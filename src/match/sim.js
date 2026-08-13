// Simulación futbolística: movimiento, táctica, posesión, duelos y balón.
// No decide nada arbitral: sólo produce sucesos que el motor convierte
// en incidentes para que el árbitro (el jugador) los resuelva.

import { clamp, lerp } from '../core/rng.js';
import { FIELD } from '../core/config.js';
import { SIDE, attackDir, ownGoalX, targetGoalX, onPitch } from './state.js';

const L = FIELD.length, W = FIELD.width;

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function maxSpeed(e) {
  const base = 4.6 + (e.player.pace / 99) * 3.7;
  const stam = 0.72 + 0.28 * (e.stamina / 100);
  const mood = e.mood === 'tired' ? 0.9 : e.mood === 'aggressive' ? 1.03 : 1;
  return base * stam * mood;
}

function progress(match, side, x) {
  const d = attackDir(match, side);
  return d > 0 ? x / L : 1 - x / L;
}

/** Posición táctica base de un jugador según el balón. */
function homeTarget(match, e) {
  const d = attackDir(match, e.side);
  const ownX = ownGoalX(match, e.side);
  const tac = match.tactics[e.side];
  const bp = progress(match, e.side, match.ball.pos.x); // 0 = mi área, 1 = área rival
  const attacking = match.possession === e.side;

  if (e.role === 'GK') {
    const depth = clamp(6 + bp * 12, 4, 20);
    return {
      x: ownX + d * depth * (bp > 0.6 ? 1 : 0.55),
      y: clamp(lerp(W / 2, match.ball.pos.y, 0.35), W * 0.25, W * 0.75),
    };
  }

  // Desplazamiento del bloque: hasta ±22 m según dónde esté el balón.
  const shift = (bp - 0.5) * (attacking ? 42 : 34);
  let slotX = e.slot.x * L * 0.92 + shift;
  if (attacking && e.role === 'FW') slotX += 6 * tac.directness;
  if (!attacking && e.role === 'FW') slotX -= 8 * (1 - tac.press);
  slotX = clamp(slotX, 4, L * 0.96);

  const widthFactor = attacking ? tac.width : tac.width * 0.72;
  let y = W / 2 + (e.slot.y - 0.5) * W * widthFactor;
  // Basculación hacia el balón
  y = lerp(y, match.ball.pos.y, attacking ? 0.14 : 0.3);
  if (d < 0) {
    // slot.y ya se aplicó simétrico; invertir para el equipo que ataca a -x
    y = W - y;
  }
  return { x: clamp(ownX + d * slotX, 1.5, L - 1.5), y: clamp(y, 1.5, W - 1.5) };
}

/** Objetivo real de cada jugador este tick. */
function chooseTarget(match, e, ctx) {
  const ball = match.ball;
  const carrier = ctx.carrier;

  if (e.injured && e.downUntil > match.clock) return { ...e.pos, urgency: 0 };

  if (ball.owner === e.id) return null; // el portador se mueve en su acción

  // Portero: intercepta balones sueltos y achica
  if (e.role === 'GK') {
    const ht = homeTarget(match, e);
    const bd = dist(ball.pos, e.pos);
    if (!ball.owner && bd < 16 && progress(match, e.side, ball.pos.x) < 0.25) {
      return { x: ball.pos.x, y: ball.pos.y, urgency: 1 };
    }
    return { ...ht, urgency: bd < 30 ? 0.7 : 0.35 };
  }

  const myProg = progress(match, e.side, e.pos.x);
  const tac = match.tactics[e.side];

  // Balón suelto: los dos más cercanos van a por él
  if (!ball.owner && ctx.looseChasers.includes(e.id)) {
    return { x: ball.pos.x + ball.vel.x * 0.25, y: ball.pos.y + ball.vel.y * 0.25, urgency: 1 };
  }

  if (carrier && carrier.side !== e.side) {
    // Defender: presionar al portador o marcar zona/hombre
    if (ctx.pressers.includes(e.id)) {
      const lead = 0.22 + tac.press * 0.18;
      return {
        x: carrier.pos.x + carrier.vel.x * lead,
        y: carrier.pos.y + carrier.vel.y * lead,
        urgency: 1,
      };
    }
    const mark = ctx.marks[e.id];
    if (mark) {
      const goalX = ownGoalX(match, e.side);
      const t = 0.7;
      return {
        x: lerp(mark.pos.x, goalX, 0.18) * t + homeTarget(match, e).x * (1 - t),
        y: mark.pos.y * t + homeTarget(match, e).y * (1 - t),
        urgency: 0.75,
      };
    }
    return { ...homeTarget(match, e), urgency: 0.6 };
  }

  if (carrier && carrier.side === e.side) {
    // Apoyo: desmarques y líneas de pase
    const ht = homeTarget(match, e);
    const d = attackDir(match, e.side);
    let ox = 0, oy = 0;
    if (e.role === 'FW' && myProg > 0.5) {
      ox = d * (4 + tac.directness * 8);
      oy = (e.slot.y - 0.5) * 6;
    } else if (e.role === 'MF') {
      ox = d * 2;
    }
    return { x: clamp(ht.x + ox, 2, L - 2), y: clamp(ht.y + oy, 2, W - 2), urgency: myProg > 0.45 ? 0.8 : 0.55 };
  }

  return { ...homeTarget(match, e), urgency: 0.5 };
}

/** Contexto compartido por tick: portador, presionadores, marcas. */
function buildContext(match) {
  const ball = match.ball;
  const carrier = ball.owner ? match.entities.find((e) => e.id === ball.owner) : null;
  const alive = match.entities.filter((e) => e.onPitch && !e.red);

  const byDist = alive
    .map((e) => ({ e, d: dist(e.pos, ball.pos) }))
    .sort((a, b) => a.d - b.d);

  const looseChasers = [];
  if (!carrier) {
    for (const side of [0, 1]) {
      const near = byDist.filter((o) => o.e.side === side && o.e.role !== 'GK').slice(0, 2);
      near.forEach((o) => looseChasers.push(o.e.id));
    }
  }

  const pressers = [];
  if (carrier) {
    const opp = byDist.filter((o) => o.e.side !== carrier.side && o.e.role !== 'GK');
    const tac = match.tactics[1 - carrier.side];
    const n = tac.press > 0.7 ? 3 : tac.press > 0.45 ? 2 : 1;
    opp.slice(0, n).forEach((o) => pressers.push(o.e.id));
  }

  // Marcajes simples: cada defensor libre sigue al atacante más cercano por delante
  const marks = {};
  if (carrier) {
    const attackers = alive.filter((e) => e.side === carrier.side && e.role !== 'GK' && e.id !== carrier.id);
    const defenders = alive.filter((e) => e.side !== carrier.side && e.role !== 'GK' && !pressers.includes(e.id));
    const taken = new Set();
    for (const d of defenders) {
      let best = null, bd = 1e9;
      for (const a of attackers) {
        if (taken.has(a.id)) continue;
        const dd = dist2(a.pos, d.pos);
        if (dd < bd) { bd = dd; best = a; }
      }
      if (best && bd < 900) { marks[d.id] = best; taken.add(best.id); }
    }
  }

  return { carrier, byDist, looseChasers, pressers, marks };
}

// -------------------------------------------------------------- movimiento

function stepEntity(match, e, target, dt) {
  if (!e.onPitch || e.red) return;
  if (e.blockCd > 0) e.blockCd -= dt;
  if (e.injured && e.downUntil > match.clock) { e.vel.x = 0; e.vel.y = 0; return; }
  if (!target) return;

  const urgency = target.urgency ?? 0.7;
  const ms = maxSpeed(e) * (0.45 + 0.55 * urgency);
  const dx = target.x - e.pos.x, dy = target.y - e.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const desiredX = (dx / d) * Math.min(ms, d / dt);
  const desiredY = (dy / d) * Math.min(ms, d / dt);
  const accel = 11 * dt;
  e.vel.x += clamp(desiredX - e.vel.x, -accel, accel);
  e.vel.y += clamp(desiredY - e.vel.y, -accel, accel);

  // Resbalones con lluvia/nieve
  if (match.weather.slip > 0.05 && match.rng.next() < match.weather.slip * dt * 0.3) {
    e.vel.x *= 0.4; e.vel.y *= 0.4;
  }

  e.pos.x = clamp(e.pos.x + e.vel.x * dt, -1, L + 1);
  e.pos.y = clamp(e.pos.y + e.vel.y * dt, -1.5, W + 1.5);
  const sp = Math.hypot(e.vel.x, e.vel.y);
  if (sp > 0.4) e.facing = Math.atan2(e.vel.y, e.vel.x);

  // Fatiga
  const drain = (0.0016 + (sp / 9) * 0.02) * match.weather.stamina * dt * 6;
  e.stamina = clamp(e.stamina - drain + (sp < 1.5 ? 0.006 * dt * 6 : 0), 12, 100);
  if (e.stamina < 35 && e.mood !== 'frustrated') e.mood = 'tired';
  e.minutesPlayed += dt / 60;
}

// ------------------------------------------------------------------ balón

function ballFriction(match) {
  return 0.42 / (match.weather.ballFriction || 1);
}

export function stepBall(match, dt, hooks) {
  const ball = match.ball;
  if (ball.owner) {
    const c = match.entities.find((e) => e.id === ball.owner);
    if (!c || !c.onPitch || c.red) { ball.owner = null; return; }
    ball.pos.x = c.pos.x + Math.cos(c.facing) * 0.85;
    ball.pos.y = c.pos.y + Math.sin(c.facing) * 0.85;
    ball.vel.x = c.vel.x; ball.vel.y = c.vel.y;
    ball.height = 0;
    return;
  }

  const prev = { x: ball.pos.x, y: ball.pos.y };
  ball.pos.x += ball.vel.x * dt;
  ball.pos.y += ball.vel.y * dt;
  const k = Math.exp(-ballFriction(match) * dt);
  ball.vel.x *= k; ball.vel.y *= k;

  if (ball.height > 0 || ball.vz > 0) {
    ball.vz -= 9.8 * dt;
    ball.height += ball.vz * dt;
    if (ball.height <= 0) { ball.height = 0; ball.vz = Math.abs(ball.vz) * 0.35; if (ball.vz < 1) ball.vz = 0; }
  }

  // Desvíos y bloqueos: un balón fuerte que pasa junto a un rival rebota en
  // él. Dentro del área los defensores se tiran a taparlo, y de ahí salen
  // los córners, los rechaces y buena parte de las manos.
  const speed = Math.hypot(ball.vel.x, ball.vel.y);
  if (speed > 9 && ball.height < 1.9) {
    for (const e of match.entities) {
      if (!e.onPitch || e.red || e.id === ball.lastTouch) continue;
      if (e.side === ball.lastTouchSide) continue;
      if (e.injured && e.downUntil > match.clock) continue;
      // Un jugador no bloquea dos veces seguidas el mismo balón
      if (e.blockCd > 0) continue;
      // Sólo se intenta el bloqueo si el balón viene hacia él
      const approaching = (ball.pos.x - e.pos.x) * ball.vel.x + (ball.pos.y - e.pos.y) * ball.vel.y < 0;
      if (!approaching) continue;

      // Un defensor en su propia área alarga la pierna: más alcance
      const ownGoal = attackDir(match, e.side) > 0 ? 0 : L;
      const inOwnBox = Math.abs(e.pos.x - ownGoal) < FIELD.penaltyAreaLength
        && Math.abs(e.pos.y - W / 2) < FIELD.penaltyAreaWidth / 2;
      const reach = inOwnBox ? 1.15 : 0.95;
      if (dist(e.pos, ball.pos) > reach) continue;

      const p = inOwnBox
        ? clamp(0.5 + e.player.positioning / 300 + e.player.tackling / 400, 0.3, 0.88)
        : 0.42;
      if (match.rng.next() > p) continue;

      // ¿Iba el balón hacia su portería? Entonces es un bloqueo, no un roce
      const towardGoal = (ownGoal === 0 ? ball.vel.x < 0 : ball.vel.x > 0)
        && Math.abs(ball.pos.y - W / 2) < 22;
      const blocked = inOwnBox && towardGoal;

      // Un bloqueo puede irse por la línea de fondo (córner) o quedar como
      // rechace dentro del campo; un roce cualquiera sólo desvía la trayectoria.
      const behind = blocked && match.rng.bool(clamp(0.35 + speed / 40, 0.35, 0.85));
      const base = Math.atan2(ball.vel.y, ball.vel.x);
      const ang = behind
        ? base + match.rng.float(-0.5, 0.5)            // sigue hacia el fondo
        : blocked
          ? base + Math.PI + match.rng.float(-1.1, 1.1) // rechace hacia fuera
          : base + match.rng.float(-1.5, 1.5);
      const ns = speed * (behind ? match.rng.float(0.5, 0.9)
        : blocked ? match.rng.float(0.3, 0.7) : match.rng.float(0.25, 0.6));
      ball.vel.x = Math.cos(ang) * ns;
      ball.vel.y = Math.sin(ang) * ns;
      ball.prevTouch = ball.lastTouch; ball.prevTouchSide = ball.lastTouchSide;
      ball.lastTouch = e.id; ball.lastTouchSide = e.side;
      e.blockCd = 4;
      hooks.onDeflection && hooks.onDeflection(e, speed, { blocked, inOwnBox, behind });
      break;
    }
  }

  hooks.checkBoundaries(prev, ball);
}

/**
 * Duelo aéreo: un balón alto que cae en el área lo remata o lo despeja
 * quien mejor juegue de cabeza. Sin esto, los córners no producen nada.
 */
function tryHeader(match, ctx, hooks) {
  const ball = match.ball;
  if (ball.owner) return false;
  if (ball.height < 1.1 || ball.height > 3.0) return false;
  if (ball.vz > 0) return false;                 // sólo cuando ya cae

  let best = null, bestScore = -1;
  for (const e of match.entities) {
    if (!e.onPitch || e.red || e.role === 'GK') continue;
    if (e.injured && e.downUntil > match.clock) continue;
    const d = dist(e.pos, ball.pos);
    if (d > 1.9) continue;
    const score = e.player.heading * 0.6 + e.player.strength * 0.25
      + match.rng.gauss(0, 12) - d * 6;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  if (!best) return false;

  ball.prevTouch = ball.lastTouch; ball.prevTouchSide = ball.lastTouchSide;
  ball.lastTouch = best.id; ball.lastTouchSide = best.side;
  ball.owner = null;

  const gx = targetGoalX(match, best.side);
  const distToGoal = Math.hypot(gx - best.pos.x, W / 2 - best.pos.y);
  const attacking = distToGoal < 20;

  if (attacking) {
    // Remate a puerta
    const acc = best.player.heading * 0.7 + best.player.technique * 0.3;
    const ty = W / 2 + match.rng.gauss(0, 4.2 * (1.2 - acc / 110));
    const dx = gx - best.pos.x, dy = ty - best.pos.y;
    const dd = Math.hypot(dx, dy) || 1;
    const sp = clamp(13 + acc / 8, 10, 22);
    ball.vel.x = (dx / dd) * sp;
    ball.vel.y = (dy / dd) * sp;
    ball.height = 1.4; ball.vz = -1.2;
    match.stats[best.side].shots++;
    hooks.onShot && hooks.onShot(best, { x: gx, y: ty }, dd);
  } else {
    // Despeje. Bajo presión y cerca de la propia línea, lo normal es mandarlo
    // fuera: de ahí sale una buena parte de los córners.
    const ownGoal = ownGoalX(match, best.side);
    const distOwnGoal = Math.abs(best.pos.x - ownGoal);
    const pressed = pressureOn(match, best) > 0.8;
    const panic = distOwnGoal < 13 && (pressed || match.rng.bool(0.25));

    if (panic && match.rng.bool(0.5)) {
      // Fuera por la línea de fondo, lejos del portero: hacia el banderín
      const sp = clamp(9 + best.player.strength / 10, 7, 16);
      const toFlag = best.pos.y < W / 2 ? -1 : 1;
      ball.vel.x = (ownGoal === 0 ? -1 : 1) * sp;
      ball.vel.y = toFlag * match.rng.float(5, 11);
      ball.height = 1.4; ball.vz = 2.4;
    } else {
      const away = Math.atan2(
        (best.pos.y - W / 2) + match.rng.float(-8, 8),
        (best.pos.x - ownGoal) || 1,
      );
      const sp = clamp(10 + best.player.strength / 8, 8, 20);
      ball.vel.x = Math.cos(away) * sp;
      ball.vel.y = Math.sin(away) * sp;
      ball.height = 1.6; ball.vz = 3.2;
    }
    hooks.onClearance && hooks.onClearance(best);
  }
  best.actionCd = 0.6;
  return true;
}

/** Alguien recupera un balón suelto. */
function tryPickUp(match, ctx) {
  const ball = match.ball;
  if (ball.owner) return null;
  if (ball.height > 2.2) return null;
  const speed = Math.hypot(ball.vel.x, ball.vel.y);
  let best = null, bd = 1e9;
  for (const e of match.entities) {
    if (!e.onPitch || e.red || (e.injured && e.downUntil > match.clock)) continue;
    const d = dist(e.pos, ball.pos);
    if (d < bd) { bd = d; best = e; }
  }
  if (!best) return null;
  const reach = best.role === 'GK' ? 2.2 : 1.35;
  if (bd > reach) return null;
  const control = best.player.technique * 0.6 + best.player.positioning * 0.4;
  // Un balón golpeado con fuerza no se controla: sigue su camino.
  const p = clamp(0.28 + control / 150 - speed / 20 + (best.role === 'GK' ? 0.35 : 0), 0.02, 0.94);
  if (match.rng.next() > p) return null;
  ball.owner = best.id;
  ball.prevTouch = ball.lastTouch; ball.prevTouchSide = ball.lastTouchSide;
  ball.lastTouch = best.id; ball.lastTouchSide = best.side;
  if (best.role === 'GK' && progress(match, best.side, ball.pos.x) < 0.2) {
    return { type: 'gkCatch', player: best };
  }
  return { type: 'pickup', player: best };
}

// ------------------------------------------------- decisiones del portador

function passOptions(match, carrier, ctx) {
  const d = attackDir(match, carrier.side);
  const mates = match.entities.filter(
    (e) => e.side === carrier.side && e.onPitch && !e.red && e.id !== carrier.id
      && !(e.injured && e.downUntil > match.clock),
  );
  const opps = match.entities.filter((e) => e.side !== carrier.side && e.onPitch && !e.red);
  const out = [];
  for (const m of mates) {
    const dd = dist(m.pos, carrier.pos);
    if (dd < 3 || dd > 45) continue;
    // Bloqueo de la línea de pase
    let blocked = 0;
    for (const o of opps) {
      const t = ((o.pos.x - carrier.pos.x) * (m.pos.x - carrier.pos.x)
        + (o.pos.y - carrier.pos.y) * (m.pos.y - carrier.pos.y)) / (dd * dd);
      if (t <= 0.05 || t >= 0.95) continue;
      const px = carrier.pos.x + (m.pos.x - carrier.pos.x) * t;
      const py = carrier.pos.y + (m.pos.y - carrier.pos.y) * t;
      const off = Math.hypot(o.pos.x - px, o.pos.y - py);
      if (off < 2.2) blocked += (2.2 - off) / 2.2;
    }
    const forward = (m.pos.x - carrier.pos.x) * d;
    const space = Math.min(...opps.map((o) => dist(o.pos, m.pos)), 40);
    const score = forward * 0.9 + space * 1.2 - blocked * 26 - dd * 0.12
      + (m.role === 'FW' ? 6 : 0) + m.player.positioning * 0.04;
    out.push({ mate: m, score, dd, blocked, forward });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Cuánto se mide un defensor antes de entrar. Dentro de su área, porque una
 * falta es penalti; y con una amarilla encima, porque la siguiente es la
 * calle. Sin lo segundo, un amonestado entraba igual que uno limpio y las
 * expulsiones por doble amarilla se iban a 0,47 por partido (real 0,1-0,2).
 */
export function tackleCaution(defender, inOwnBox) {
  return (inOwnBox ? 0.16 : 1) * (defender.yellow >= 1 ? 0.42 : 1);
}

function shotQuality(match, carrier) {
  const gx = targetGoalX(match, carrier.side);
  const gy = W / 2;
  const d = Math.hypot(gx - carrier.pos.x, gy - carrier.pos.y);
  const angle = Math.abs(carrier.pos.y - gy);
  if (d > 34) return { d, q: 0 };
  const q = clamp(1 - d / 34, 0, 1) * clamp(1 - angle / 30, 0.1, 1);
  return { d, q };
}

function pressureOn(match, e) {
  let p = 0;
  for (const o of match.entities) {
    if (o.side === e.side || !o.onPitch || o.red) continue;
    const d = dist(o.pos, e.pos);
    if (d < 6) p += (6 - d) / 6;
  }
  return p;
}

function doPass(match, carrier, target, power, hooks, lofted = false) {
  const ball = match.ball;
  const dx = target.x - carrier.pos.x, dy = target.y - carrier.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const skill = carrier.player.passing * 0.7 + carrier.player.technique * 0.3;
  const err = (1 - skill / 110) * (0.6 + pressureOn(match, carrier) * 0.35)
    * (match.weather.slip > 0.1 ? 1.35 : 1);
  const ang = Math.atan2(dy, dx) + match.rng.gauss(0, 0.09 * err * 2);
  const speed = clamp(d / (0.45 + d * 0.028) * power * match.rng.float(0.9, 1.12), 6, 30);
  ball.owner = null;
  ball.prevTouch = ball.lastTouch; ball.prevTouchSide = ball.lastTouchSide;
  ball.lastTouch = carrier.id; ball.lastTouchSide = carrier.side;
  ball.vel.x = Math.cos(ang) * speed;
  ball.vel.y = Math.sin(ang) * speed;
  if (lofted) { ball.vz = 6.5; ball.height = 0.2; }
  carrier.hasBall = false;
  match.stats[carrier.side].passes++;
  hooks.onPass && hooks.onPass(carrier, target, d);
}

function doShot(match, carrier, hooks) {
  const ball = match.ball;
  const gx = targetGoalX(match, carrier.side);
  const gy = W / 2 + match.rng.gauss(0, 1.6);
  const acc = carrier.player.shooting * 0.65 + carrier.player.technique * 0.35;
  const press = pressureOn(match, carrier);
  const spread = (1.05 - acc / 110) * (1 + press * 0.4) * (1 + (100 - carrier.stamina) / 220);
  const targetY = gy + match.rng.gauss(0, 3.4 * spread);
  const dx = gx - carrier.pos.x, dy = targetY - carrier.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const speed = clamp(19 + acc / 6 + match.rng.gauss(0, 2.5), 14, 34);
  ball.owner = null;
  ball.prevTouch = ball.lastTouch; ball.prevTouchSide = ball.lastTouchSide;
  ball.lastTouch = carrier.id; ball.lastTouchSide = carrier.side;
  ball.vel.x = (dx / d) * speed;
  ball.vel.y = (dy / d) * speed;
  ball.height = 0.2; ball.vz = match.rng.float(-0.5, 3.2);
  carrier.hasBall = false;
  match.stats[carrier.side].shots++;
  hooks.onShot && hooks.onShot(carrier, { x: gx, y: targetY }, d);
}

function carrierAction(match, carrier, ctx, dt, hooks) {
  carrier.actionCd -= dt;
  const d = attackDir(match, carrier.side);
  const tac = match.tactics[carrier.side];
  const press = pressureOn(match, carrier);

  // Conducción continua
  const gx = targetGoalX(match, carrier.side);
  const toGoal = Math.atan2(W / 2 - carrier.pos.y, gx - carrier.pos.x);
  const evade = ctx.pressers.length
    ? (() => {
      const p = match.entities.find((e) => e.id === ctx.pressers[0]);
      if (!p) return 0;
      const a = Math.atan2(carrier.pos.y - p.pos.y, carrier.pos.x - p.pos.x);
      return a;
    })() : null;
  const driveAng = evade !== null && press > 1.1
    ? toGoal * 0.55 + evade * 0.45
    : toGoal;
  const ms = maxSpeed(carrier) * (0.78 + tac.tempo * 0.15) * (1 - press * 0.06);
  const acc = 10 * dt;
  carrier.vel.x += clamp(Math.cos(driveAng) * ms - carrier.vel.x, -acc, acc);
  carrier.vel.y += clamp(Math.sin(driveAng) * ms - carrier.vel.y, -acc, acc);
  carrier.pos.x = clamp(carrier.pos.x + carrier.vel.x * dt, 0.5, L - 0.5);
  carrier.pos.y = clamp(carrier.pos.y + carrier.vel.y * dt, 0.6, W - 0.6);
  carrier.facing = Math.atan2(carrier.vel.y, carrier.vel.x);
  carrier.stamina = clamp(carrier.stamina - 0.02 * dt * 6 * match.weather.stamina, 12, 100);

  if (carrier.actionCd > 0) return;
  carrier.actionCd = clamp(0.75 - carrier.player.technique / 300 + press * 0.05, 0.28, 0.9);

  const { q: sq, d: goalDist } = shotQuality(match, carrier);
  const opts = passOptions(match, carrier, ctx);
  const best = opts[0];

  // Portero: despeja largo o saca en corto
  if (carrier.role === 'GK') {
    const safe = opts.filter((o) => o.blocked < 0.3 && o.dd < 28)[0];
    if (safe && match.rng.bool(0.55)) doPass(match, carrier, safe.mate.pos, 1, hooks);
    else {
      const far = opts.filter((o) => o.forward > 18)[0] || best;
      doPass(match, carrier, far ? far.mate.pos : { x: gx, y: W / 2 }, 1.25, hooks, true);
    }
    return;
  }

  // La urgencia por disparar cae rápido con la distancia, no en línea recta:
  // con la relación lineal, dos tercios de los tiros salían de fuera del área
  // y la conversión se hundía. En el fútbol real la mitad salen de dentro.
  const shootUrge = (sq ** 2.1) * (0.7 + carrier.player.shooting / 160) * (press < 1.5 ? 1.15 : 0.75);
  if (sq > 0.24 && match.rng.next() < shootUrge * 1.35) {
    doShot(match, carrier, hooks);
    return;
  }

  // Presión alta: pase de seguridad o despeje
  if (press > 1.8 && (!best || best.blocked > 0.6)) {
    const out = opts.filter((o) => o.blocked < 0.4)[0];
    if (out) doPass(match, carrier, out.mate.pos, 1.1, hooks, out.dd > 22);
    else doPass(match, carrier, { x: gx, y: match.rng.float(6, W - 6) }, 1.4, hooks, true);
    return;
  }

  const dribbleUrge = (carrier.player.technique / 100) * (1 - press * 0.25) * (0.35 + tac.directness * 0.2);
  if (match.rng.next() < dribbleUrge * 0.55 && press < 1.6) return; // sigue conduciendo

  if (best) {
    // Pase filtrado a la espalda si hay carrera clara
    const through = opts.find((o) => o.forward > 12 && o.blocked < 0.35 && o.mate.role !== 'GK');
    const chosen = through && match.rng.bool(0.4 + tac.directness * 0.3) ? through : best;
    const lead = chosen.forward > 8 ? 0.55 : 0.25;
    const tp = {
      x: clamp(chosen.mate.pos.x + chosen.mate.vel.x * lead + d * (through === chosen ? 5 : 0), 1, L - 1),
      y: clamp(chosen.mate.pos.y + chosen.mate.vel.y * lead, 1, W - 1),
    };
    doPass(match, carrier, tp, 1, hooks, chosen.dd > 26);
    if (through === chosen) hooks.onThroughBall && hooks.onThroughBall(carrier, chosen.mate);
  }
}

// ------------------------------------------------------------------ duelos

function tryTackles(match, ctx, dt, hooks) {
  const carrier = ctx.carrier;
  if (!carrier) return;
  if (match.ball.height > 1.2) return;   // balón por alto: se salta, no se entra
  for (const id of ctx.pressers) {
    const def = match.entities.find((e) => e.id === id);
    if (!def || !def.onPitch || def.red) continue;
    def.tackleCd -= dt;
    if (def.tackleCd > 0) continue;
    const d = dist(def.pos, carrier.pos);
    if (d > 1.9) continue;

    const tac = match.tactics[def.side];
    // Dentro del área los defensores miden mucho más la entrada
    const ownGoal = attackDir(match, def.side) > 0 ? 0 : L;
    const inOwnBox = Math.abs(def.pos.x - ownGoal) < 17 && Math.abs(def.pos.y - W / 2) < 20.2;
    const caution = tackleCaution(def, inOwnBox);
    const eager = (0.100 + tac.aggression * 0.10 + def.player.aggression / 900
      + (def.mood === 'frustrated' ? 0.08 : 0) + (def.mood === 'aggressive' ? 0.05 : 0)) * caution;
    if (match.rng.next() > eager) { def.tackleCd = 1.2; continue; }

    def.tackleCd = match.rng.float(5, 9);
    const skill = def.player.tackling * 0.65 + def.player.positioning * 0.2 + def.player.pace * 0.15;
    const evade = carrier.player.technique * 0.55 + carrier.player.pace * 0.3 + carrier.player.strength * 0.15;
    const speedDiff = Math.hypot(def.vel.x, def.vel.y);
    const slip = match.weather.slip;
    const roll = match.rng.gauss(0, 13);
    const diff = skill - evade + roll - speedDiff * 1.2 - slip * 40;

    hooks.onDuel(def, carrier, { diff, speedDiff, d, slip });
    return; // un duelo por tick
  }
}

// ------------------------------------------------------------------- ciclo

export function simulate(match, dt, hooks) {
  const ctx = buildContext(match);
  match.ctx = ctx;

  for (const e of match.entities) {
    if (!e.onPitch || e.red) continue;
    if (e.protestCd > 0) e.protestCd -= dt;
    if (e.injured && e.downUntil <= match.clock) { e.injured = e.injuryLevel > 1; }
    if (ctx.carrier && e.id === ctx.carrier.id) continue;
    stepEntity(match, e, chooseTarget(match, e, ctx), dt);
  }

  if (ctx.carrier) carrierAction(match, ctx.carrier, ctx, dt, hooks);

  stepBall(match, dt, hooks);

  const headed = tryHeader(match, ctx, hooks);
  const pick = headed ? null : tryPickUp(match, ctx);
  if (pick) hooks.onPossessionChange && hooks.onPossessionChange(pick);

  if (ctx.carrier) tryTackles(match, ctx, dt, hooks);

  if (match.ball.owner) {
    const c = match.entities.find((e) => e.id === match.ball.owner);
    if (c) {
      match.possession = c.side;
      match.stats[c.side].possessionTicks++;
    }
  }
  match.momentum = clamp(match.momentum * 0.995 + (match.possession === SIDE.HOME ? 0.004 : -0.004), -1, 1);
}

export { pressureOn, homeTarget, progress, maxSpeed };
