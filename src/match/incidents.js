// Fábrica de incidentes: convierte hechos físicos del motor en situaciones
// arbitrales con verdad reglamentaria oculta, visibilidad y opciones.

import { clamp } from '../core/rng.js';
import { FIELD } from '../core/config.js';
import RuleEngine, { SEVERITY, inPenaltyArea } from '../rules/ruleEngine.js';
import { attackDir, ownGoalX, SIDE } from './state.js';
import { dist } from './sim.js';

let incidentId = 1;
export function resetIncidentIds() { incidentId = 1; }

/** Qué tan bien pudo ver el árbitro la jugada (0..1). */
export function computeClarity(match, pos, opts = {}) {
  const ref = match.ref;
  const d = dist(ref.pos, pos);
  const refStats = match.referee.stats;

  // Distancia: óptimo entre 8 y 18 m
  let distFactor;
  if (d < 6) distFactor = 0.78;               // demasiado encima, tapado
  else if (d <= 18) distFactor = 1;
  else distFactor = clamp(1 - (d - 18) / 42, 0.12, 1);

  // Ángulo respecto a hacia dónde mira
  const ang = Math.atan2(pos.y - ref.pos.y, pos.x - ref.pos.x);
  let diff = Math.abs(((ang - ref.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const angleFactor = clamp(1 - diff / (Math.PI * 0.95), 0.35, 1);

  // Cuerpos interpuestos
  let blocked = 0;
  for (const e of match.entities) {
    if (!e.onPitch || e.red) continue;
    const t = ((e.pos.x - ref.pos.x) * (pos.x - ref.pos.x) + (e.pos.y - ref.pos.y) * (pos.y - ref.pos.y)) / (d * d || 1);
    if (t <= 0.15 || t >= 0.9) continue;
    const px = ref.pos.x + (pos.x - ref.pos.x) * t;
    const py = ref.pos.y + (pos.y - ref.pos.y) * t;
    if (Math.hypot(e.pos.x - px, e.pos.y - py) < 1.1) blocked += 0.12;
  }

  const conc = 0.72 + (refStats.concentration / 100) * 0.28;
  const fatigue = 0.85 + (match.ref.stamina / 100) * 0.15;
  const weather = match.weather.visibility;
  const inherent = 1 - (opts.inherentAmbiguity || 0) * 0.55;

  return clamp(distFactor * angleFactor * conc * fatigue * weather * inherent - blocked, 0.05, 1);
}

function impactOf(match, { inBox, dogso, goal, minute, card }) {
  let score = 0;
  if (goal) score += 3;
  if (inBox) score += 2.5;
  if (dogso) score += 2;
  if (card === 'red') score += 2;
  const diff = Math.abs(match.score[0] - match.score[1]);
  if (diff <= 1) score += 1;
  if (minute > 75) score += 1;
  if (match.importance > 70) score += 1;
  if (score >= 6) return 'critical';
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function baseIncident(match, type, pos, extra = {}) {
  return {
    id: `i${incidentId++}`,
    type,
    minute: Math.floor(match.clock / 60),
    second: Math.floor(match.clock % 60),
    clock: match.clock,
    half: match.half,
    pos: { x: pos.x, y: pos.y },
    reviewable: false,
    resolved: false,
    decisionTaken: null,
    grade: null,
    ...extra,
  };
}

// ------------------------------------------------------- duelo / entrada

export function makeChallengeIncident(match, defender, attacker, duel) {
  const rng = match.rng;
  const diffCfg = match.difficulty;
  const tac = match.tactics[defender.side];

  const defGoalX = ownGoalX(match, defender.side);
  const inBox = inPenaltyArea(attacker.pos, defGoalX < FIELD.length / 2 ? 0 : FIELD.length);

  // ¿Jugó el balón? Dentro de su propia área el defensor sabe que una falta
  // es penalti: sólo entra cuando llega claramente al balón, y si no llega,
  // se retira en lugar de barrer.
  const playedBall = duel.diff > (inBox ? -7.5 : -2) + rng.gauss(0, 5);
  const contactRaw = clamp(
    0.20 - duel.diff / 42 + defender.player.aggression / 520 + duel.speedDiff / 55
    + rng.gauss(0, 0.14) * diffCfg.ambiguity
    - (inBox ? 0.13 : 0),
    0, 1.35,
  );
  const fromBehind = Math.cos(attacker.facing - Math.atan2(
    attacker.pos.y - defender.pos.y, attacker.pos.x - defender.pos.x,
  )) < -0.25;
  const studsUp = rng.next() < (defender.player.aggression / 100) * 0.045 + duel.speedDiff / 420;
  const armUse = rng.next() < 0.16 + (defender.player.aggression / 100) * 0.12;
  const brutality = clamp(
    defender.player.aggression / 300 + duel.speedDiff / 60 - defender.player.discipline / 260
    + (defender.mood === 'frustrated' ? 0.16 : 0) + rng.gauss(0, 0.11),
    0, 1.4,
  );

  // ¿Simulación?
  const contactLow = contactRaw < 0.4;
  const diveUrge = (attacker.player.diving / 100)
    * (inBox ? 1.7 : 0.7)
    * (contactLow ? 1 : 0.35)
    * diffCfg.simulationRate;
  const dive = rng.next() < diveUrge * 0.32;

  // Ocasión manifiesta / ataque prometedor
  const goalX = ownGoalX(match, defender.side);
  const distToGoal = Math.hypot(attacker.pos.x - goalX, attacker.pos.y - FIELD.width / 2);
  const defendersBehind = match.entities.filter((e) => e.side === defender.side && e.onPitch && !e.red
    && e.id !== defender.id
    && Math.hypot(e.pos.x - goalX, e.pos.y - FIELD.width / 2) < distToGoal).length;
  const dogso = distToGoal < 26 && defendersBehind === 0 && !playedBall && contactRaw > 0.6
    && attacker.id === match.ball.owner;
  const spa = !dogso && distToGoal < 45 && contactRaw > 0.55 && defendersBehind <= 1
    && attacker.id === match.ball.owner;

  // Reiteración: a partir de la tercera falta del mismo jugador
  const persistent = defender.fouls >= 2 && defender.yellow === 0;

  const truth = RuleEngine.evaluateFoul({
    contact: contactRaw, playedBall, fromBehind, speed: duel.speedDiff,
    studsUp, armUse, dive, inBox, dogso, spa, brutality, persistent,
    victimFell: contactRaw > 0.3,
  });

  const inherentAmbiguity = clamp(
    Math.abs(contactRaw - 0.4) < 0.16 ? 0.85 : 0.3 + (dive ? 0.4 : 0) + (playedBall && contactRaw > 0.4 ? 0.35 : 0),
    0.05, 1,
  ) * diffCfg.ambiguity;

  const inc = baseIncident(match, inBox ? 'penaltyShout' : 'challenge', attacker.pos, {
    offenderId: defender.id, offenderSide: defender.side,
    victimId: attacker.id, victimSide: attacker.side,
    inBox, dogso, spa, persistent, truth,
    facts: { contact: contactRaw, playedBall, fromBehind, studsUp, armUse, brutality, dive, speed: duel.speedDiff },
    advantageFacts: {
      possessionRetained: false, promisingAttack: spa, clearOpportunity: dogso,
      severity: truth.severity, inBox, minute: Math.floor(match.clock / 60),
    },
    inherentAmbiguity,
  });
  inc.clarity = computeClarity(match, attacker.pos, { inherentAmbiguity });
  inc.impact = impactOf(match, { inBox, dogso, minute: inc.minute, card: truth.card });
  inc.reviewable = RuleEngine.isVarReviewable(inc);
  return inc;
}

// ------------------------------------------------------------------ mano

export function makeHandballIncident(match, player, shooter, facts) {
  const rng = match.rng;
  const defGoalX = ownGoalX(match, player.side);
  const inBox = inPenaltyArea(player.pos, defGoalX < FIELD.length / 2 ? 0 : FIELD.length);
  const f = {
    armDistanceFromBody: clamp(rng.float(0.1, 1) * (0.6 + player.player.aggression / 250)
      * (inBox ? 0.72 : 1), 0, 1),
    movementTowardsBall: rng.float(0, 1) * 0.8,
    distanceToShooter: shooter ? dist(player.pos, shooter.pos) : rng.float(2, 12),
    // Dentro de su propia área el defensor bloquea con los brazos pegados al
    // cuerpo, y a bocajarro el balón le da antes en el cuerpo que en la mano.
    // Sin esta distinción, el brazo por encima del hombro —que por reglamento
    // siempre es infracción— convertía cada bloqueo en un penalti en potencia.
    armAboveShoulder: rng.bool(inBox ? 0.045 : 0.18),
    deflectedOffOwnBody: rng.bool(inBox ? 0.46 : 0.28),
    isAttacker: facts.isAttacker || false,
    leadsToGoal: facts.leadsToGoal || false,
    isGoalkeeperInBox: player.role === 'GK' && inBox,
    inBox,
    // Parar el balón con la mano a propósito dentro de tu área es un acto
    // desesperado y rarísimo: por reglamento es penalti seguro.
    deliberateStop: rng.bool(inBox ? 0.018 : 0.12),
    ...facts,
  };
  const truth = RuleEngine.evaluateHandball(f);
  const inherentAmbiguity = clamp(0.5 + Math.abs(f.armDistanceFromBody - 0.6) * -0.5 + rng.float(0, 0.3), 0.1, 1)
    * match.difficulty.ambiguity;

  const inc = baseIncident(match, 'handball', player.pos, {
    offenderId: player.id, offenderSide: player.side,
    inBox, truth, facts: f, inherentAmbiguity,
  });
  inc.clarity = computeClarity(match, player.pos, { inherentAmbiguity });
  inc.impact = impactOf(match, { inBox, minute: inc.minute, card: truth.card, goal: f.leadsToGoal });
  inc.reviewable = RuleEngine.isVarReviewable(inc);
  return inc;
}

// ------------------------------------------------------- fuera de juego

export function makeOffsideIncident(match, passer, receiver, snapshot) {
  const rng = match.rng;
  const dir = attackDir(match, passer.side);
  // Penúltimo defensor en el momento del pase
  const defs = snapshot.defenders
    .map((d) => d.x * dir)
    .sort((a, b) => b - a);
  const secondLast = defs.length > 1 ? defs[1] : defs[0] ?? 0;
  const attackerAheadBy = receiver.pos.x * dir - Math.max(secondLast, snapshot.ballX * dir, (FIELD.length / 2) * dir);

  const truth = RuleEngine.evaluateOffside({
    attackerAheadBy,
    activeInterference: true,
    deliberatePlayByDefender: rng.bool(0.06),
    inOwnHalf: receiver.pos.x * dir < (FIELD.length / 2) * dir,
  });
  truth.margin = attackerAheadBy;

  const tight = Math.abs(attackerAheadBy) < 0.6;
  const inherentAmbiguity = clamp(tight ? 0.9 : 0.25, 0, 1) * match.difficulty.ambiguity;

  const inc = baseIncident(match, 'offside', receiver.pos, {
    offenderId: receiver.id, offenderSide: receiver.side,
    passerId: passer.id, truth, inherentAmbiguity,
    margin: attackerAheadBy, leadsToGoal: false,
  });
  // El asistente ve mejor la línea que el árbitro
  inc.clarity = computeClarity(match, receiver.pos, { inherentAmbiguity });
  inc.assistantClarity = clamp(0.75 - Math.abs(attackerAheadBy) * -0.05 - (tight ? 0.3 : 0), 0.15, 1);
  inc.impact = impactOf(match, { minute: inc.minute });
  return inc;
}

// -------------------------------------------------------- balón fuera

export function makeOutOfPlayIncident(match, exitEdge, pos, ball) {
  const defendingSide = pos.x < FIELD.length / 2
    ? (attackDir(match, SIDE.HOME) > 0 ? SIDE.HOME : SIDE.AWAY)
    : (attackDir(match, SIDE.HOME) > 0 ? SIDE.AWAY : SIDE.HOME);

  const truth = RuleEngine.evaluateRestart({
    exitEdge, lastTouchSide: ball.lastTouchSide, defendingSide,
  });

  // Ambigüedad: desvíos, rebotes, jugadores amontonados
  const crowd = match.entities.filter((e) => e.onPitch && dist(e.pos, pos) < 4).length;
  const inherentAmbiguity = clamp(0.15 + crowd * 0.16, 0, 1) * match.difficulty.ambiguity;

  const inc = baseIncident(match, 'outOfPlay', pos, {
    exitEdge, truth, inherentAmbiguity, defendingSide,
    lastTouchSide: ball.lastTouchSide, lastTouchId: ball.lastTouch,
  });
  inc.clarity = computeClarity(match, pos, { inherentAmbiguity });
  inc.impact = 'low';
  return inc;
}

// ------------------------------------------------------------------ gol

export function makeGoalIncident(match, scorer, facts) {
  const truth = RuleEngine.evaluateGoal({
    fullyCrossed: facts.fullyCrossed !== false,
    offsideInBuildUp: !!facts.offsideInBuildUp,
    handballInBuildUp: !!facts.handballInBuildUp,
    foulInBuildUp: !!facts.foulInBuildUp,
    keeperFouled: !!facts.keeperFouled,
  });
  truth.closeCall = !!facts.closeCall;

  const inc = baseIncident(match, 'goal', facts.pos || match.ball.pos, {
    scorerId: scorer ? scorer.id : null,
    scoringSide: facts.side,
    truth, facts,
    inherentAmbiguity: facts.closeCall ? 0.8 : 0.1,
  });
  inc.clarity = computeClarity(match, inc.pos, { inherentAmbiguity: inc.inherentAmbiguity });
  inc.impact = 'critical';
  inc.reviewable = true;
  inc.glt = !!facts.closeCall;
  return inc;
}

// -------------------------------------------------- protestas / violencia

export function makeDissentIncident(match, player, intensity) {
  const rng = match.rng;
  const card = intensity > 0.75 ? 'yellow' : null;
  const truth = { card, reason: 'foul.dissent', rule: 'rulebook.cards', intensity };
  const inc = baseIncident(match, 'dissent', player.pos, {
    offenderId: player.id, offenderSide: player.side, truth,
    intensity, inherentAmbiguity: 0.2,
  });
  inc.clarity = clamp(0.85 + rng.float(-0.1, 0.1), 0, 1);
  inc.impact = impactOf(match, { minute: inc.minute, card });
  return inc;
}

export function makeViolenceIncident(match, offender, victim, kind) {
  const truth = {
    card: 'red',
    reason: kind === 'spit' ? 'foul.spitting' : 'foul.violent',
    rule: 'rulebook.cards',
  };
  const inc = baseIncident(match, 'violence', offender.pos, {
    offenderId: offender.id, offenderSide: offender.side,
    victimId: victim ? victim.id : null, kind, truth,
    inherentAmbiguity: 0.35,
  });
  inc.clarity = computeClarity(match, offender.pos, { inherentAmbiguity: 0.35 });
  inc.impact = 'critical';
  inc.reviewable = true;
  return inc;
}

export function makeInjuryIncident(match, player, level) {
  const stopPlay = level >= 2 || (level === 1 && match.rng.bool(0.4));
  const truth = { stopPlay, level, rule: 'rulebook.restarts' };
  const inc = baseIncident(match, 'injury', player.pos, {
    offenderId: null, victimId: player.id, victimSide: player.side,
    level, truth, inherentAmbiguity: level === 1 ? 0.6 : 0.15,
  });
  inc.clarity = computeClarity(match, player.pos, { inherentAmbiguity: inc.inherentAmbiguity });
  inc.impact = level >= 3 ? 'high' : 'medium';
  return inc;
}

/** Pérdida de tiempo en una reanudación. */
export function makeTimeWastingIncident(match, player, delaySeconds) {
  const minute = Math.floor(match.clock / 60);
  const leading = match.score[player.side] > match.score[1 - player.side];
  const truth = RuleEngine.evaluateTimeWasting({
    delaySeconds, minute, leading, alreadyWarned: !!player.warnedForDelay,
  });
  const inc = baseIncident(match, 'timewasting', player.pos, {
    offenderId: player.id, offenderSide: player.side,
    delaySeconds, leading, truth, inherentAmbiguity: 0.25,
  });
  inc.clarity = clamp(0.9 - (delaySeconds < 8 ? 0.2 : 0), 0, 1);
  inc.impact = impactOf(match, { minute, card: truth.card });
  return inc;
}

export function makeCrowdIncident(match, kind) {
  const protocolMap = {
    objectThrown: 'protocol', pitchInvasion: 'protocol', discrimination: 'protocol',
    blackout: 'stop', storm: 'stop', security: 'protocol', brawl: 'cards',
  };
  const truth = {
    protocol: protocolMap[kind] || 'protocol',
    kind,
    rule: 'rulebook.restarts',
  };
  const inc = baseIncident(match, kind === 'brawl' ? 'violence' : 'crowd', match.ball.pos, {
    kind, truth, inherentAmbiguity: 0.2,
  });
  inc.clarity = 0.9;
  inc.impact = 'high';
  return inc;
}

// ------------------------------------------------------------- opciones

/** Botones contextuales disponibles para un incidente. */
export function optionsFor(match, inc) {
  const o = [];
  const push = (id, labelKey, payload, style) => o.push({ id, labelKey, payload, style });

  switch (inc.type) {
    case 'challenge':
    case 'penaltyShout': {
      if (inc.inBox) {
        push('penalty', 'act.penalty', { action: 'penalty' }, 'primary');
        push('noPenalty', 'act.noPenalty', { action: 'playon' }, 'ghost');
        push('dive', 'act.dive', { action: 'dive', card: 'yellow' }, 'warn');
      } else {
        push('foul', 'act.whistle', { action: 'foul' }, 'primary');
        push('advantage', 'act.advantage', { action: 'advantage' }, 'accent');
        push('playon', 'act.playon', { action: 'playon' }, 'ghost');
        push('dive', 'act.dive', { action: 'dive', card: 'yellow' }, 'warn');
      }
      break;
    }
    case 'handball':
      push('handball', 'act.handball', { action: 'handball' }, 'primary');
      if (inc.inBox) push('penalty', 'act.penalty', { action: 'penalty' }, 'primary');
      push('noHandball', 'act.noHandball', { action: 'playon' }, 'ghost');
      break;
    case 'offside':
      push('offside', 'act.offside', { action: 'offside' }, 'primary');
      push('onside', 'act.onside', { action: 'playon' }, 'ghost');
      break;
    case 'outOfPlay': {
      const t = inc.truth.type;
      if (t === 'throwIn') {
        push('throwHome', 'act.throwA', { action: 'restart', restartType: 'throwIn', toSide: 0 }, 'primary');
        push('throwAway', 'act.throwA', { action: 'restart', restartType: 'throwIn', toSide: 1 }, 'primary');
      } else {
        push('corner', 'act.corner', { action: 'restart', restartType: 'corner', toSide: 1 - inc.defendingSide }, 'primary');
        push('goalKick', 'act.goalKick', { action: 'restart', restartType: 'goalKick', toSide: inc.defendingSide }, 'primary');
      }
      break;
    }
    case 'goal':
      push('goal', 'act.goal', { action: 'goal' }, 'primary');
      push('noGoal', 'act.noGoal', { action: 'noGoal' }, 'warn');
      break;
    case 'timewasting':
      push('warning', 'act.warning', { action: 'warning' }, 'ghost');
      push('yellow', 'act.yellow', { action: 'card', card: 'yellow' }, 'warn');
      push('play', 'act.letPlay', { action: 'playon' }, 'ghost');
      break;
    case 'dissent':
      push('warning', 'act.warning', { action: 'warning' }, 'ghost');
      push('yellow', 'act.yellow', { action: 'card', card: 'yellow' }, 'warn');
      push('red', 'act.red', { action: 'card', card: 'red' }, 'danger');
      push('ignore', 'act.playon', { action: 'playon' }, 'ghost');
      break;
    case 'violence':
      push('red', 'act.red', { action: 'card', card: 'red' }, 'danger');
      push('yellow', 'act.yellow', { action: 'card', card: 'yellow' }, 'warn');
      push('warning', 'act.warning', { action: 'warning' }, 'ghost');
      break;
    case 'injury':
      push('medics', 'act.medics', { action: 'medics' }, 'primary');
      push('stop', 'act.stopMatch', { action: 'stop' }, 'warn');
      push('play', 'act.letPlay', { action: 'playon' }, 'ghost');
      break;
    case 'crowd':
      push('protocol', 'event.protocolStep', { action: 'protocol' }, 'primary');
      push('stop', 'act.stopMatch', { action: 'stop' }, 'warn');
      push('abandon', 'act.abandon', { action: 'abandon' }, 'danger');
      push('play', 'act.letPlay', { action: 'playon' }, 'ghost');
      break;
    default:
      push('playon', 'act.playon', { action: 'playon' }, 'ghost');
  }

  if (inc.reviewable && match.varEnabled) push('var', 'act.var', { action: 'var' }, 'accent');
  if (['challenge', 'penaltyShout', 'handball', 'offside', 'outOfPlay', 'violence'].includes(inc.type)) {
    push('assistant', 'act.assistant', { action: 'assistant' }, 'ghost');
  }
  return o;
}

/** Tarjetas ofrecidas tras pitar una falta. */
export function cardOptionsFor(match, inc) {
  const offender = match.entities.find((e) => e.id === inc.offenderId);
  const opts = [
    { id: 'none', labelKey: 'act.noCard', payload: { card: null }, style: 'ghost' },
    { id: 'warning', labelKey: 'act.warning', payload: { card: null, warning: true }, style: 'ghost' },
    { id: 'yellow', labelKey: offender && offender.yellow >= 1 ? 'act.secondYellow' : 'act.yellow', payload: { card: 'yellow' }, style: 'warn' },
    { id: 'red', labelKey: 'act.red', payload: { card: 'red' }, style: 'danger' },
  ];
  return opts;
}

export { SEVERITY };
