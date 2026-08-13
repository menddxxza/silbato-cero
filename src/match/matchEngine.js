// MATCH ENGINE
// Orquesta el partido: reloj, fases, reanudaciones, incidentes, decisiones
// arbitrales, ventaja, tarjetas, VAR, lesiones, cambios y descuento.
// No dibuja nada: emite eventos por el bus.

import { RNG, clamp, lerp } from '../core/rng.js';
import { FIELD, SIM } from '../core/config.js';
import { EventBus } from '../core/events.js';
import RuleEngine, { GRADE, GRADE_WEIGHT, ADVANTAGE_WINDOW, SEVERITY } from '../rules/ruleEngine.js';
import {
  SIDE, attackDir, ownGoalX, targetGoalX, onPitch, setKickoffPositions, entityById,
} from './state.js';
import { simulate, dist, pressureOn } from './sim.js';
import {
  makeChallengeIncident, makeHandballIncident, makeOffsideIncident, makeOutOfPlayIncident,
  makeGoalIncident, makeDissentIncident, makeViolenceIncident, makeInjuryIncident,
  makeCrowdIncident, makeTimeWastingIncident, optionsFor, cardOptionsFor,
  resetIncidentIds, computeClarity,
} from './incidents.js';
import { RefereeRating } from './rating.js';
import { VarSystem } from './var.js';
import { AssistantSystem } from './assistants.js';

const L = FIELD.length, W = FIELD.width;

export class MatchEngine {
  constructor(match, opts = {}) {
    this.match = match;
    this.bus = opts.bus || new EventBus();
    this.autoReferee = opts.autoReferee || null; // función(incident, options) -> payload
    this.rating = new RefereeRating(match);
    this.var = new VarSystem(match, this.bus);
    this.assistants = new AssistantSystem(match);
    this.speed = opts.speed ?? 1;
    this.input = { dx: 0, dy: 0, sprint: false };
    this.acc = 0;
    this.pending = null;
    this.pendingCards = null;
    this.finished = false;
    this.celebrationUntil = 0;
    this.deadballUntil = 0;
    this.lastEventCheck = 0;
    this.protocolStep = 0;
    this.pendingClips = [];
    match.clips = {};
    resetIncidentIds();
    this._bindHooks();
  }

  on(t, f) { return this.bus.on(t, f); }
  emit(t, p) { this.bus.emit(t, p); }

  // --------------------------------------------------------------- arranque

  start() {
    const m = this.match;
    m.phase = 'kickoff';
    m.running = true;
    m.half = m.startHalf || 1;
    m.clock = m.startClock || 0;
    m.halfLength = 45 * 60;
    const first = m.rng.bool(0.5) ? SIDE.HOME : SIDE.AWAY;
    m.kickoffSide = first;
    setKickoffPositions(m, first);
    this.deadballUntil = m.clock + 1.2;
    m.phase = 'play';
    this.logEvent('kickoff', { side: first });
    this.emit('match:start', { match: m });
  }

  // ----------------------------------------------------------------- bucle

  /** realDt: segundos reales transcurridos. */
  update(realDt) {
    if (this.finished) return;
    const m = this.match;
    if (m.phase === 'decision' || m.phase === 'var' || m.phase === 'halftime' || m.phase === 'report') {
      if (this.pending) this._tickDecisionTimer(realDt);
      return;
    }
    const dt = SIM.dt;
    this.acc += realDt * this.speed;
    let guard = 0;
    while (this.acc >= dt && !this.finished && guard++ < 12) {
      this.acc -= dt;
      this._tick(dt);
      if (m.phase === 'decision' || m.phase === 'var') break;
    }
  }

  _tick(dt) {
    const m = this.match;
    this._moveReferee(dt);
    this._moveAssistants(dt);

    // Reloj de partido
    const matchDt = dt * 6; // 6 s de partido por segundo simulado a velocidad 1
    m.clock += matchDt;

    if (m.phase === 'deadball') {
      this._considerSubstitution();
      this._checkTimeWasting(matchDt);
      if (m.clock >= this.deadballUntil) this._executeRestart();
      this._recordReplayFrame();
      this._checkHalfEnd();
      return;
    }
    if (m.phase === 'celebration') {
      m.stoppage += matchDt;
      if (m.clock >= this.celebrationUntil) this._afterGoalKickoff();
      return;
    }
    if (m.phase === 'stopped') {
      m.stoppage += matchDt;
      this._tickStopped();
      return;
    }

    simulate(m, dt, this.hooks);
    this._flushClips();
    if (this.pendingDelivery) this._deliverSetPiece();
    this._advantageWatch(dt);
    this._moodUpdate(dt);
    this._randomIncidents(dt);
    this._recordReplayFrame();
    this._checkHalfEnd();
  }

  // -------------------------------------------------------- árbitro y AR

  setInput(input) { this.input = { ...this.input, ...input }; }

  _moveReferee(dt) {
    const m = this.match;
    const r = m.ref;
    const st = m.referee.stats;
    const base = 4.2 + (st.fitness / 100) * 3.2;
    const sprint = this.input.sprint && r.stamina > 8 ? 1.45 : 1;
    const speed = base * sprint * (0.6 + 0.4 * (r.stamina / 100));
    const mag = Math.hypot(this.input.dx, this.input.dy);
    if (mag > 0.01) {
      const nx = this.input.dx / mag, ny = this.input.dy / mag;
      r.vel.x = lerp(r.vel.x, nx * speed, 0.25);
      r.vel.y = lerp(r.vel.y, ny * speed, 0.25);
      r.facing = Math.atan2(r.vel.y, r.vel.x);
    } else {
      r.vel.x *= 0.82; r.vel.y *= 0.82;
      // Mirada hacia el balón cuando está quieto
      const a = Math.atan2(m.ball.pos.y - r.pos.y, m.ball.pos.x - r.pos.x);
      let d = ((a - r.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      r.facing += d * 0.12;
    }
    r.pos.x = clamp(r.pos.x + r.vel.x * dt, 1, L - 1);
    r.pos.y = clamp(r.pos.y + r.vel.y * dt, 1, W - 1);
    const sp = Math.hypot(r.vel.x, r.vel.y);
    const drain = (0.004 + (sp / 8) * 0.05 * (sprint > 1 ? 2.1 : 1)) * dt * 6 * m.weather.stamina;
    r.stamina = clamp(r.stamina - drain + (sp < 1 ? 0.02 * dt * 6 : 0), 0, 100);
    r.sprinting = sprint > 1;

    // Posicionamiento acumulado para la nota
    const d = dist(r.pos, m.ball.pos);
    this.rating.samplePositioning(d, m.phase === 'play');
  }

  _moveAssistants(dt) {
    const m = this.match;
    for (let i = 0; i < 2; i++) {
      const a = m.assistantsPos[i];
      const side = i === 0 ? SIDE.HOME : SIDE.AWAY;
      // El asistente sigue la línea del penúltimo defensor de su mitad
      const half = i === 0 ? [0, L / 2] : [L / 2, L];
      const defs = m.entities
        .filter((e) => e.onPitch && !e.red && e.role !== 'GK' && e.pos.x >= half[0] - 6 && e.pos.x <= half[1] + 6)
        .map((e) => e.pos.x)
        .sort((p, q) => p - q);
      let targetX = m.ball.pos.x;
      if (defs.length > 1) {
        targetX = i === 0 ? defs[1] : defs[defs.length - 2];
      }
      targetX = clamp(Math.max(Math.min(targetX, half[1]), half[0]), 0, L);
      a.x = lerp(a.x, targetX, Math.min(1, dt * 3));
    }
  }

  // --------------------------------------------------------------- hooks

  _bindHooks() {
    const m = this.match;
    this.hooks = {
      checkBoundaries: (prev, ball) => this._checkBoundaries(prev, ball),
      onDuel: (def, att, duel) => this._resolveDuel(def, att, duel),
      onPass: (from, to, d) => this._onPass(from, to, d),
      onShot: (from, target, d) => this._onShot(from, target, d),
      onThroughBall: (from, to) => this._onThroughBall(from, to),
      onPossessionChange: (info) => this._onPossessionChange(info),
      onDeflection: (entity, speed, info) => this._onDeflection(entity, speed, info),
      onClearance: (entity) => { this.match.flow.phase = 'clearance'; },
    };
  }

  _onPass(from) {
    const m = this.match;
    m.flow.phase = 'build';
    this.pendingPass = {
      passer: from,
      snapshot: {
        defenders: m.entities.filter((e) => e.side !== from.side && e.onPitch && !e.red && e.role !== 'GK')
          .map((e) => ({ x: e.pos.x, y: e.pos.y })),
        ballX: m.ball.pos.x,
      },
      clock: m.clock,
      forwardPass: true,
    };
  }

  _onThroughBall(from, to) {
    this.pendingPass && (this.pendingPass.through = true);
  }

  _onShot(shooter, target, d) {
    const m = this.match;
    m.flow.phase = 'shot';
    this.lastShot = { shooter, clock: m.clock };
    // Posible mano de un defensor que se cruza
    const defenders = m.entities.filter((e) => e.side !== shooter.side && e.onPitch && !e.red && e.role !== 'GK');
    for (const def of defenders) {
      if (dist(def.pos, shooter.pos) < 4.5 && m.rng.next() < 0.018) {
        const inc = makeHandballIncident(m, def, shooter, { isAttacker: false });
        this._raise(inc);
        return;
      }
    }
  }

  /** Un rechace puede haber sido con el brazo. */
  _onDeflection(entity, speed, info = {}) {
    const m = this.match;

    // Un disparo bloqueado que sale desviado hacia el fondo acaba en córner
    // algo más de la mitad de las veces: el portero no llega a todo.
    if (info.behind && speed > 15 && m.rng.bool(0.5)) {
      const ownGoal = ownGoalX(m, entity.side);
      const pos = { x: ownGoal, y: clamp(m.ball.pos.y + m.rng.float(-4, 4), 0.5, W - 0.5) };
      m.ball.vel.x = 0; m.ball.vel.y = 0; m.ball.owner = null;
      m.ball.pos = { ...pos };
      m.ball.height = 0; m.ball.vz = 0;
      this._raiseOrAuto(makeOutOfPlayIncident(m, 'goalline', pos, m.ball));
      return;
    }

    if (entity.role === 'GK') return;
    // Un bloqueo dentro del área es donde de verdad aparecen las manos
    const p = info.blocked ? 0.03 : info.inOwnBox ? 0.02 : 0.01;
    if (m.rng.next() > p) return;
    const shooter = this.lastShot && m.clock - this.lastShot.clock < 4 ? this.lastShot.shooter : null;
    const inc = makeHandballIncident(m, entity, shooter, { isAttacker: false });
    // Sólo llega al árbitro si hay algo que decidir
    if (!inc.truth.offence && inc.clarity > 0.7 && inc.inherentAmbiguity < 0.4) return;
    this._raise(inc);
  }

  _onPossessionChange(info) {
    const m = this.match;
    const p = info.player;
    // ¿Se materializó la ventaja?
    if (m.advantage && p.side === m.advantage.victimSide) m.advantage.retained = true;
    if (m.advantage && p.side !== m.advantage.victimSide) m.advantage.lost = true;

    // Fuera de juego: comprobar al recibir un pase adelantado
    if (this.pendingPass && this.pendingPass.passer.side === p.side
      && p.id !== this.pendingPass.passer.id
      && m.clock - this.pendingPass.clock < 6) {
      const dir = attackDir(m, p.side);
      const progressed = (p.pos.x - this.pendingPass.snapshot.ballX) * dir;
      if (progressed > 4) {
        const inc = makeOffsideIncident(m, this.pendingPass.passer, p, this.pendingPass.snapshot);
        this.pendingPass = null;
        // El asistente decide si levanta el banderín
        const flag = this.assistants.judgeOffside(inc);
        inc.assistantFlag = flag.flag;
        inc.assistantConfidence = flag.confidence;
        if (flag.flag || inc.truth.offside) {
          this._raise(inc);
          return;
        }
        m.incidents.push(inc); // fuera de juego no señalado, queda registrado
        return;
      }
    }
    this.pendingPass = null;
  }

  // ---------------------------------------------------------- límites

  _checkBoundaries(prev, ball) {
    const m = this.match;
    if (m.phase !== 'play') return;

    // Línea de meta
    if (ball.pos.x <= 0 || ball.pos.x >= L) {
      const gy = W / 2;
      const inGoalMouth = Math.abs(ball.pos.y - gy) <= FIELD.goalWidth / 2 && ball.height < 2.44;
      const margin = Math.min(Math.abs(ball.pos.x), Math.abs(ball.pos.x - L));
      if (inGoalMouth) {
        this._handleGoal(ball.pos.x <= 0 ? 0 : L, margin < 0.35);
        return;
      }
      const pos = { x: clamp(ball.pos.x, 0, L), y: clamp(ball.pos.y, 0, W) };
      ball.vel.x = 0; ball.vel.y = 0; ball.owner = null;
      const inc = makeOutOfPlayIncident(m, 'goalline', pos, ball);
      this._raiseOrAuto(inc);
      return;
    }
    // Bandas
    if (ball.pos.y <= 0 || ball.pos.y >= W) {
      const pos = { x: clamp(ball.pos.x, 0, L), y: clamp(ball.pos.y, 0, W) };
      ball.vel.x = 0; ball.vel.y = 0; ball.owner = null;
      const inc = makeOutOfPlayIncident(m, 'touchline', pos, ball);
      this._raiseOrAuto(inc);
    }
  }

  /** Las salidas evidentes se resuelven solas; las dudosas van al árbitro. */
  _raiseOrAuto(inc) {
    const m = this.match;
    if (inc.inherentAmbiguity < 0.35 || inc.clarity > 0.72) {
      const payload = { action: 'restart', restartType: inc.truth.type, toSide: inc.truth.toSide, auto: true };
      inc.auto = true;
      this._applyDecision(inc, payload, { silent: true });
      return;
    }
    this._raise(inc);
  }

  // ------------------------------------------------------------------ gol

  _handleGoal(goalX, closeCall) {
    const m = this.match;
    const scoringSide = (goalX === 0)
      ? (attackDir(m, SIDE.HOME) > 0 ? SIDE.AWAY : SIDE.HOME)
      : (attackDir(m, SIDE.HOME) > 0 ? SIDE.HOME : SIDE.AWAY);
    const scorer = entityById(m, m.ball.lastTouch);

    // Portero: intento de parada antes de decidir gol
    const gk = m.entities.find((e) => e.side !== scoringSide && e.role === 'GK' && e.onPitch);
    if (gk && !this._gkAlreadyTried) {
      const d = Math.abs(gk.pos.y - m.ball.pos.y);
      const reflex = gk.player.positioning * 0.5 + gk.player.technique * 0.3 + gk.player.strength * 0.2;
      // Un portero bien colocado paraba el 84% de lo que le llegaba a puerta:
      // demasiado. En el fútbol real se para en torno al 70%, y ese exceso se
      // comía los goles cuando se corrigió el reparto de tiros.
      const saveP = clamp(0.50 - d / 14 + reflex / 320 - (m.weather.slip > 0.1 ? 0.06 : 0), 0.05, 0.86);
      if (m.rng.next() < saveP) {
        m.stats[1 - scoringSide].saves++;
        m.stats[scoringSide].shotsOn++;
        m.ball.prevTouch = m.ball.lastTouch; m.ball.prevTouchSide = m.ball.lastTouchSide;
        m.ball.lastTouch = gk.id; m.ball.lastTouchSide = gk.side;
        this.logEvent('save', { gk: gk.player.name });
        // Casi la mitad de las paradas acaban en córner
        if (m.rng.bool(0.45)) {
          const pos = { x: goalX, y: clamp(m.ball.pos.y, 0.5, W - 0.5) };
          m.ball.vel.x = 0; m.ball.vel.y = 0; m.ball.owner = null;
          const inc = makeOutOfPlayIncident(m, 'goalline', pos, m.ball);
          this._raiseOrAuto(inc);
          return;
        }
        m.ball.pos.x = clamp(m.ball.pos.x, 2.5, L - 2.5);
        m.ball.vel.x *= -0.5; m.ball.vel.y = m.rng.float(-7, 7);
        return;
      }
      m.stats[scoringSide].shotsOn++;
    }

    const facts = {
      side: scoringSide,
      pos: { x: clamp(m.ball.pos.x, 0, L), y: m.ball.pos.y },
      fullyCrossed: true,
      closeCall,
      offsideInBuildUp: this._recentOffsideUnflagged(scoringSide),
      handballInBuildUp: m.rng.next() < 0.035,
      foulInBuildUp: m.rng.next() < 0.03,
    };
    const inc = makeGoalIncident(m, scorer, facts);
    m.ball.vel.x = 0; m.ball.vel.y = 0; m.ball.owner = null;
    this._raise(inc);
  }

  _recentOffsideUnflagged(side) {
    const m = this.match;
    const recent = m.incidents.filter((i) => i.type === 'offside' && m.clock - i.clock < 12
      && i.offenderSide === side && !i.resolved);
    return recent.some((i) => i.truth.offside);
  }

  _afterGoalKickoff() {
    const m = this.match;
    const conceded = m.lastGoalSide === SIDE.HOME ? SIDE.AWAY : SIDE.HOME;
    setKickoffPositions(m, conceded);
    m.phase = 'play';
  }

  // ---------------------------------------------------------------- duelo

  _resolveDuel(def, att, duel) {
    const m = this.match;
    // Entrada limpia y clara: recupera el balón sin incidente
    if (duel.diff > 14) {
      m.ball.owner = def.id;
      m.ball.prevTouch = m.ball.lastTouch; m.ball.prevTouchSide = m.ball.lastTouchSide;
      m.ball.lastTouch = def.id; m.ball.lastTouchSide = def.side;
      att.hasBall = false;
      return;
    }
    // Ni roza: sigue el juego
    if (duel.diff > 4 && m.rng.bool(0.6)) return;

    const inc = makeChallengeIncident(m, def, att, duel);

    // Contacto banal: el juego sigue, no llega a ser una situación arbitral
    if (!inc.truth.isFoul && !inc.truth.simulation && inc.facts.contact < 0.42) return;

    m.stats[def.side].fouls += inc.truth.isFoul ? 1 : 0;
    m.stats[att.side].foulsSuffered += inc.truth.isFoul ? 1 : 0;
    if (inc.truth.simulation) m.stats[att.side].dives++;

    // El balón queda suelto donde estaba
    if (m.ball.owner === att.id) {
      m.ball.owner = null;
      m.ball.vel.x = att.vel.x * 0.6 + m.rng.float(-3, 3);
      m.ball.vel.y = att.vel.y * 0.6 + m.rng.float(-3, 3);
    }
    // Posible lesión por entrada dura
    if (inc.truth.severity === SEVERITY.EXCESSIVE && m.rng.bool(0.4)) {
      inc.injuryCaused = true;
    }
    this._raise(inc);
  }

  // ----------------------------------------------- incidentes aleatorios
  // (siempre condicionados al estado del juego, nunca "random cada X s")

  _randomIncidents(dt) {
    const m = this.match;
    const minute = m.clock / 60;

    // Protestas: reaccionan a la última decisión
    for (const e of m.entities) {
      if (!e.onPitch || e.red || e.protestCd > 0) continue;
      if (e.frustration < 55) continue;
      const p = (e.frustration / 100) * (e.player.temperament / 100) * 0.02 * dt
        * m.difficulty.protestRate;
      if (m.rng.next() < p) {
        e.protestCd = 20;
        const intensity = clamp(e.frustration / 100 + m.rng.gauss(0, 0.15), 0, 1.2);
        if (dist(e.pos, m.ref.pos) < 12) {
          const inc = makeDissentIncident(m, e, intensity);
          this._raise(inc);
          return;
        }
        this.emit('protest', { entity: e, intensity });
      }
    }

    // Lesiones (más probables con faltas duras y fatiga)
    for (const e of m.entities) {
      if (!e.onPitch || e.injured || e.red) continue;
      const p = (0.0000035 + (100 - e.stamina) * 0.00000025) * dt * 6;
      if (m.rng.next() < p) {
        const level = m.rng.weighted([[1, 55], [2, 30], [3, 12], [4, 3]]);
        e.injured = true; e.injuryLevel = level; e.downUntil = m.clock + 8 + level * 6;
        m.stats[e.side].injuries++;
        const inc = makeInjuryIncident(m, e, level);
        this._raise(inc);
        return;
      }
    }

    // Eventos de estadio, ligados a tensión acumulada
    if (m.clock - this.lastEventCheck > 120) {
      this.lastEventCheck = m.clock;
      const tension = (m.atmosphere.anger[0] + m.atmosphere.anger[1]) / 200
        + m.rivalry / 200 + m.importance / 300;
      if (m.rng.next() < tension * 0.09) {
        const kind = m.rng.weighted([
          ['objectThrown', 22], ['pitchInvasion', 12], ['discrimination', 10],
          ['security', 14], ['blackout', 6], ['brawl', 26], ['storm', 10],
        ]);
        const inc = makeCrowdIncident(m, kind);
        this._raise(inc);
      }
    }

    // Cambios

  }

  /**
   * Sustituciones con lectura del partido: se cambia por lesión, por
   * desgaste, para proteger a un amonestado y para atacar o cerrar el
   * resultado según el marcador y el minuto.
   */
  _considerSubstitution(force = null) {
    const m = this.match;
    const minute = m.clock / 60;
    if (!force && minute < 25) return null;
    if (!force && m.clock < (this.lastSubCheck || 0) + 90) return null;
    this.lastSubCheck = m.clock;

    for (const side of m.rng.shuffle([SIDE.HOME, SIDE.AWAY])) {
      if (m.subsUsed[side] >= SIM.maxSubsPerTeam) continue;
      if (!m.bench[side] || !m.bench[side].length) continue;

      const plan = this._substitutionPlan(side, minute, force);
      if (!plan) continue;
      const done = this._makeSubstitution(side, plan);
      if (done) return done;
    }
    return null;
  }

  /** Decide a quién quitar y qué perfil pedir al banquillo. */
  _substitutionPlan(side, minute, force) {
    const m = this.match;
    const squad = onPitch(m, side).filter((e) => e.role !== 'GK');
    if (!squad.length) return null;

    const diff = m.score[side] - m.score[1 - side];
    const losing = diff < 0;
    const winning = diff > 0;

    // 1. Lesionado: sale sí o sí
    const hurt = squad.find((e) => e.id === force || (e.injured && e.injuryLevel >= 2));
    if (hurt) return { out: hurt, want: hurt.role, reason: 'injury' };

    // 2. Amonestado que sigue jugando al límite: se le protege
    if (minute > 55) {
      const risky = squad
        .filter((e) => e.yellow >= 1 && (e.player.aggression > 62 || e.fouls >= 2))
        .sort((a, b) => b.player.aggression - a.player.aggression)[0];
      if (risky && m.rng.bool(0.5)) return { out: risky, want: risky.role, reason: 'protect' };
    }

    // 3. Marcador: perder obliga a arriesgar, ganar a cerrar
    if (losing && minute > 58) {
      const defender = squad.filter((e) => e.role === 'DF')
        .sort((a, b) => a.player.shooting - b.player.shooting)[0];
      if (defender && m.rng.bool(0.6)) return { out: defender, want: 'FW', reason: 'chase' };
      const mid = squad.filter((e) => e.role === 'MF')
        .sort((a, b) => a.stamina - b.stamina)[0];
      if (mid) return { out: mid, want: 'FW', reason: 'chase' };
    }
    if (winning && minute > 72) {
      const forward = squad.filter((e) => e.role === 'FW')
        .sort((a, b) => a.stamina - b.stamina)[0];
      if (forward && m.rng.bool(0.65)) return { out: forward, want: 'DF', reason: 'protect_lead' };
    }

    // 4. Desgaste puro
    const tired = squad.sort((a, b) => a.stamina - b.stamina)[0];
    if (tired && tired.stamina < 58 && minute > 55) {
      return { out: tired, want: tired.role, reason: 'tired' };
    }
    return null;
  }

  /** Ejecuta el cambio buscando en el banquillo el perfil pedido. */
  _makeSubstitution(side, plan) {
    const m = this.match;
    const bench = m.bench[side];
    let idx = bench.findIndex((p) => p.role === plan.want);
    if (idx < 0) idx = bench.findIndex((p) => p.role !== 'GK');
    if (idx < 0) return null;

    const inPlayer = bench.splice(idx, 1)[0];
    const out = plan.out;
    out.onPitch = false;

    // El entrante hereda el hueco táctico del que sale, salvo que el cambio
    // busque otro perfil: entonces ocupa una posición propia de su rol.
    const slot = plan.want === out.role ? out.slot : this._slotForRole(side, plan.want, out.slot);
    const ent = {
      ...out,
      id: inPlayer.id,
      player: inPlayer,
      role: inPlayer.role,
      slot: { ...slot },
      stamina: 100,
      onPitch: true,
      yellow: 0, red: false, fouls: 0,
      injured: false, injuryLevel: 0, downUntil: 0,
      mood: 'calm', frustration: 20,
      actionCd: 0, tackleCd: 0, blockCd: 0, protestCd: 0,
      warnedForDelay: false,
      pos: { ...out.pos }, vel: { x: 0, y: 0 },
      minutesPlayed: 0,
    };
    m.entities.push(ent);
    m.subsUsed[side]++;
    m.stats[side].subs++;
    m.stoppage += 25 + m.rng.float(0, 20);

    this.logEvent('substitution', {
      side, out: out.player.name, in: inPlayer.name, reason: plan.reason,
    });
    this.emit('substitution', { side, out, in: ent, reason: plan.reason });
    return { side, out, in: ent, reason: plan.reason };
  }

  /** Posición base razonable para un rol dentro de la formación. */
  _slotForRole(side, role, fallback) {
    const m = this.match;
    const sameRole = m.lineups[side].lineup.filter((l) => l.slot.role === role);
    if (sameRole.length) {
      const ref = sameRole[m.rng.int(0, sameRole.length - 1)].slot;
      return { role, x: ref.x, y: ref.y };
    }
    const x = role === 'FW' ? 0.72 : role === 'MF' ? 0.45 : 0.2;
    return { role, x, y: fallback ? fallback.y : 0.5 };
  }

  // ---------------------------------------------------------- ventaja

  _advantageWatch(dt) {
    const m = this.match;
    const adv = m.advantage;
    if (!adv) return;
    if (m.clock > adv.until) {
      const materialized = adv.retained && !adv.lost;
      this._closeAdvantage(materialized);
      return;
    }
    // Gol durante la ventaja: se materializa de inmediato
    if (adv.goalScored) this._closeAdvantage(true);
  }

  _closeAdvantage(materialized) {
    const m = this.match;
    const adv = m.advantage;
    m.advantage = null;
    const inc = m.incidents.find((i) => i.id === adv.incidentId);
    if (!inc) return;
    inc.advantageMaterialized = materialized;
    this.rating.recordAdvantage(materialized, inc);
    this.emit('advantage:end', { incident: inc, materialized });

    if (!materialized) {
      // Vuelta a la falta: se reanuda desde el punto original
      this._setRestart({
        type: inc.truth.penalty ? 'penalty' : 'freeKick',
        side: inc.victimSide,
        pos: inc.pos,
      });
      this.logEvent('advantageBack', { player: this._name(inc.offenderId) });
    }
    // La tarjeta pendiente se muestra ahora: el motor recuerda al infractor
    if (adv.pendingCard !== false && inc.truth.card) {
      this._askCard(inc, { fromAdvantage: true, materialized });
    } else {
      this._resumeAfterIncident(inc);
    }
  }

  // ------------------------------------------------ acciones del jugador

  /** El árbitro corta la ventaja y vuelve a la falta. */
  cancelAdvantage() {
    if (!this.match.advantage) return false;
    this._closeAdvantage(false);
    return true;
  }

  /** Detiene el juego por decisión propia (incidente grave, agua, etc.). */
  manualStop(seconds = 60) {
    const m = this.match;
    if (m.phase !== 'play' && m.phase !== 'deadball') return false;
    m.phase = 'stopped';
    this.resumeAt = m.clock + seconds;
    this.resumeIncident = null;
    this.emit('match:stopped', { manual: true });
    return true;
  }

  /** Consulta rápida al cuarto árbitro. */
  askFourthOfficial() {
    const m = this.match;
    return {
      name: m.crew.fourth.name,
      addedTime: Math.round(m.addedTime / 60),
      pendingStoppage: Math.round(m.stoppage / 60),
      subs: m.subsUsed.slice(),
      cards: [m.stats[0].yellows + m.stats[0].reds, m.stats[1].yellows + m.stats[1].reds],
    };
  }

  /** Consulta al asistente sobre el último incidente relevante. */
  askAssistantAbout(incident) {
    const inc = incident || [...this.match.incidents].reverse()
      .find((i) => ['challenge', 'penaltyShout', 'handball', 'offside', 'outOfPlay'].includes(i.type));
    if (!inc) return null;
    return this.assistants.ask(inc, null);
  }

  // -------------------------------------------------------- decisiones

  _raise(inc) {
    const m = this.match;
    m.incidents.push(inc);
    const options = optionsFor(m, inc);
    m.phase = 'decision';
    this.pending = {
      incident: inc,
      options,
      timeLeft: m.difficulty.decisionTime,
      started: m.clock,
    };
    m.pending = this.pending;
    this.emit('decision:request', { incident: inc, options, match: m });

    if (this.autoReferee) {
      const payload = this.autoReferee(inc, options, m);
      if (payload) this.decide(payload);
    }
  }

  _tickDecisionTimer(realDt) {
    if (!this.pending) return;
    this.pending.timeLeft -= realDt;
    if (this.pending.timeLeft <= 0) {
      const inc = this.pending.incident;
      this.decide({ action: 'playon', timeout: true });
      this.emit('decision:timeout', { incident: inc });
    }
  }

  /** Punto de entrada de la UI: el árbitro decide. */
  decide(payload) {
    if (this.pendingCards) return this._decideCard(payload);
    if (!this.pending) return;
    const { incident } = this.pending;

    if (payload.action === 'assistant') {
      const answer = this.assistants.ask(incident, payload.question);
      this.emit('assistant:answer', { incident, answer });
      incident.assistantConsulted = true;
      return;
    }
    if (payload.action === 'var') {
      this._openVar(incident, payload);
      return;
    }
    this._applyDecision(incident, payload);
  }

  _openVar(incident, payload) {
    const m = this.match;
    if (!RuleEngine.isVarReviewable(incident)) {
      this.emit('var.notReviewable', { incident });
      return;
    }
    m.phase = 'var';
    this.var.open(incident, {
      preDecision: payload.preDecision || null,
      onClose: (result) => {
        m.phase = 'decision';
        incident.varUsed = true;
        incident.varResult = result;
        m.stats[0].varReviews = (m.stats[0].varReviews || 0) + 1;
        m.stoppage += 65 + m.rng.float(0, 45);
        this.rating.recordVar(incident, result);
        if (result.finalPayload) this._applyDecision(incident, result.finalPayload);
      },
    });
  }

  _applyDecision(incident, payload, opts = {}) {
    const m = this.match;
    incident.decisionTaken = payload;
    this.pending = null;
    m.pending = null;

    // Ventaja: no se resuelve todavía
    if (payload.action === 'advantage') {
      m.advantage = {
        incidentId: incident.id,
        until: m.clock + ADVANTAGE_WINDOW * 6,
        offenderId: incident.offenderId,
        victimSide: incident.victimSide,
        retained: m.possession === incident.victimSide,
        lost: false,
      };
      incident.resolved = false;
      m.phase = 'play';
      this.emit('advantage:start', { incident });
      this.logEvent('advantage', { player: this._name(incident.victimId) });
      return;
    }

    // Acciones que requieren elegir tarjeta después
    const needsCard = ['foul', 'penalty', 'handball', 'dive'].includes(payload.action)
      || (payload.action === 'card' && !payload.card);
    if (needsCard && !opts.skipCard) {
      this._askCard(incident, { basePayload: payload });
      return;
    }

    this._finalizeDecision(incident, payload, opts);
  }

  _askCard(incident, ctx = {}) {
    const m = this.match;
    m.phase = 'decision';
    this.pendingCards = { incident, ctx, options: cardOptionsFor(m, incident) };
    this.emit('decision:cards', { incident, options: this.pendingCards.options, ctx });
    if (this.autoReferee) {
      const p = this.autoReferee(incident, this.pendingCards.options, m, { cardPhase: true });
      if (p) this._decideCard(p);
    }
  }

  _decideCard(payload) {
    const { incident, ctx } = this.pendingCards;
    this.pendingCards = null;
    const base = ctx.basePayload || { action: incident.truth.penalty ? 'penalty' : 'foul' };
    const merged = { ...base, card: payload.card ?? null, warning: !!payload.warning };
    this._finalizeDecision(incident, merged, ctx);
  }

  _finalizeDecision(incident, payload, opts = {}) {
    const m = this.match;
    incident.decisionTaken = payload;
    incident.resolved = true;

    const grade = RuleEngine.gradeDecision(incident, payload);
    incident.grade = grade;

    // Las jugadas con peso se guardan para poder revisarlas al final
    const worthKeeping = payload.card || ['goal', 'penaltyShout', 'violence'].includes(incident.type)
      || payload.action === 'penalty' || incident.impact === 'critical' || incident.impact === 'high'
      || !!incident.varUsed;
    if (worthKeeping && !payload.auto) this._requestClip(incident);

    const record = {
      incidentId: incident.id,
      type: incident.type,
      minute: incident.minute,
      clock: incident.clock,
      decision: payload,
      truth: incident.truth,
      grade: grade.grade,
      score: grade.score,
      explanation: grade.explanation,
      rule: grade.rule,
      confidence: incident.clarity,
      impact: incident.impact,
      playerId: incident.offenderId,
      varUsed: !!incident.varUsed,
      auto: !!payload.auto,
    };
    m.decisions.push(record);
    if (!payload.auto) this.rating.recordDecision(incident, payload, grade);

    this._applyConsequences(incident, payload);
    if (!opts.silent) this.emit('decision:resolved', { incident, payload, grade, record });
    this._resumeAfterIncident(incident, payload);
  }

  // ----------------------------------------------------- consecuencias

  _applyConsequences(incident, payload) {
    const m = this.match;
    const offender = incident.offenderId ? entityById(m, incident.offenderId) : null;

    // Tarjetas
    if (payload.card && offender) {
      this._giveCard(offender, payload.card, incident);
    } else if (payload.warning && offender) {
      offender.frustration = clamp(offender.frustration - 12, 0, 100);
      if (incident.type === 'timewasting') offender.warnedForDelay = true;
      this.logEvent('warning', { player: offender.player.name });
    }
    if (payload.action === 'dive' && incident.victimId) {
      const diver = entityById(m, incident.victimId);
      if (diver && payload.card) this._giveCard(diver, payload.card, incident);
    }

    // Faltas acumuladas por jugador: alimentan la reiteración
    if (offender && ['foul', 'penalty', 'handball'].includes(payload.action)) {
      offender.fouls++;
    }

    // Estadísticas y marcador
    switch (payload.action) {
      case 'goal': {
        const side = incident.scoringSide;
        m.score[side]++;
        m.lastGoalSide = side;
        m.stats[side].goals++;
        m.phase = 'celebration';
        this.celebrationUntil = m.clock + 22;
        m.stoppage += 30;
        if (m.advantage) m.advantage.goalScored = true;
        this.logEvent('goal', { side, player: this._name(incident.scorerId) });
        this.emit('goal', { side, incident });
        this._crowdReaction(side, 'goal');
        break;
      }
      case 'noGoal':
        this.logEvent('goalDisallowed', { player: this._name(incident.scorerId) });
        this._crowdReaction(incident.scoringSide, 'disallowed');
        break;
      case 'penalty':
        m.stats[incident.victimSide ?? (1 - incident.offenderSide)].penalties++;
        this.logEvent('penalty', { side: incident.victimSide });
        break;
      case 'offside':
        m.stats[incident.offenderSide].offsides++;
        break;
      case 'restart':
        if (payload.restartType === 'corner') m.stats[payload.toSide].corners++;
        else if (payload.restartType === 'throwIn') m.stats[payload.toSide].throwIns++;
        else m.stats[payload.toSide].goalKicks++;
        break;
      default: break;
    }

    // Reacción emocional de los 22 + público
    this._emotionalFallout(incident, payload);
  }

  _giveCard(entity, card, incident) {
    const m = this.match;
    if (card === 'yellow') {
      entity.yellow++;
      m.stats[entity.side].yellows++;
      this.logEvent('yellow', { player: entity.player.name, reason: incident.truth.cardReason || incident.truth.reason });
      if (entity.yellow >= 2) {
        entity.red = true; entity.onPitch = false;
        m.stats[entity.side].reds++;
        this.logEvent('secondYellow', { player: entity.player.name });
      }
    } else if (card === 'red') {
      entity.red = true; entity.onPitch = false;
      m.stats[entity.side].reds++;
      this.logEvent('red', { player: entity.player.name, reason: incident.truth.cardReason || incident.truth.reason });
    }
    m.stoppage += 22;
    this.emit('card', { entity, card, incident });
    // La segunda amarilla acaba en roja: el árbitro enseña las dos, y la
    // interfaz tiene que enseñar las dos. Emitiendo sólo la amarilla se
    // expulsaba a un jugador mientras en pantalla salía una cartulina
    // amarilla, sin que la roja apareciera nunca.
    if (card === 'yellow' && entity.yellow >= 2) {
      this.emit('card', { entity, card: 'red', incident, secondYellow: true });
    }
    // Todo el equipo se calienta
    for (const e of m.entities) {
      if (e.side === entity.side && e.onPitch) e.frustration = clamp(e.frustration + (card === 'red' ? 26 : 12), 0, 100);
    }
  }

  _emotionalFallout(incident, payload) {
    const m = this.match;
    const grade = incident.grade;
    const wronged = this._whoFeelsWronged(incident, payload);
    if (wronged === null) return;
    const severity = incident.impact === 'critical' ? 26 : incident.impact === 'high' ? 18 : 10;
    const perceived = grade && grade.grade === GRADE.INCORRECT ? 1.45 : grade && grade.grade === GRADE.DEBATABLE ? 1.1 : 0.7;
    for (const e of m.entities) {
      if (e.side !== wronged || !e.onPitch) continue;
      e.frustration = clamp(e.frustration + severity * perceived * (e.player.temperament / 70), 0, 100);
      if (e.frustration > 70) e.mood = 'frustrated';
    }
    m.atmosphere.anger[wronged] = clamp(m.atmosphere.anger[wronged] + severity * perceived * 0.5, 0, 100);
    m.atmosphere.support[1 - wronged] = clamp(m.atmosphere.support[1 - wronged] + 3, 0, 100);
    this.emit('crowd', { side: wronged, anger: m.atmosphere.anger[wronged] });
    // Entrenador
    const coach = m.teams[wronged].coach;
    if (coach.protestRate / 100 > m.rng.next() && incident.impact !== 'low') {
      this.emit('coachProtest', { side: wronged, coach, incident });
    }
  }

  _whoFeelsWronged(incident, payload) {
    switch (payload.action) {
      case 'playon': return incident.victimSide ?? null;
      case 'foul': case 'penalty': case 'handball': return incident.offenderSide ?? null;
      case 'dive': return incident.victimSide ?? null;
      case 'offside': return incident.offenderSide ?? null;
      case 'noGoal': return incident.scoringSide ?? null;
      case 'goal': return incident.scoringSide === 0 ? 1 : 0;
      case 'card': return incident.offenderSide ?? null;
      default: return null;
    }
  }

  _crowdReaction(side, kind) {
    const m = this.match;
    m.atmosphere.noise = clamp(m.atmosphere.noise + (kind === 'goal' ? 45 : 25), 0, 100);
    this.emit('atmosphere', { side, kind, noise: m.atmosphere.noise });
  }

  _moodUpdate(dt) {
    const m = this.match;
    for (const e of m.entities) {
      if (!e.onPitch) continue;
      e.frustration = clamp(e.frustration - 0.35 * dt, 0, 100);
      const losing = m.score[e.side] < m.score[1 - e.side];
      if (losing && m.clock > 60 * 65) e.frustration = clamp(e.frustration + 0.25 * dt, 0, 100);
      if (e.frustration > 75) e.mood = 'frustrated';
      else if (e.stamina < 32) e.mood = 'tired';
      else if (e.yellow > 0 && e.frustration < 40) e.mood = 'nervous';
      else if (m.score[e.side] > m.score[1 - e.side]) e.mood = 'confident';
      else e.mood = 'calm';
    }
    m.atmosphere.noise = clamp(m.atmosphere.noise - 4 * dt, 25, 100);
    m.atmosphere.anger[0] = clamp(m.atmosphere.anger[0] - 1.2 * dt, 0, 100);
    m.atmosphere.anger[1] = clamp(m.atmosphere.anger[1] - 1.2 * dt, 0, 100);
  }

  // ------------------------------------------------------ reanudaciones

  _resumeAfterIncident(incident, payload = {}) {
    const m = this.match;
    if (m.phase === 'celebration' || m.phase === 'stopped') return;

    if (m.advantage) { m.phase = 'play'; return; }

    switch (payload.action) {
      case 'goal':
        return; // celebración -> saque de centro
      case 'noGoal': {
        const side = incident.scoringSide;
        const reason = incident.truth.reason;
        if (reason === 'law.offside') this._setRestart({ type: 'freeKick', side: 1 - side, pos: incident.pos });
        else this._setRestart({ type: 'goalKick', side: 1 - side, pos: incident.pos });
        return;
      }
      case 'penalty':
        this._setRestart({ type: 'penalty', side: incident.victimSide ?? (1 - incident.offenderSide), pos: incident.pos });
        return;
      case 'foul':
        this._setRestart({ type: 'freeKick', side: incident.victimSide ?? (1 - incident.offenderSide), pos: incident.pos });
        return;
      case 'handball':
        this._setRestart({ type: 'freeKick', side: 1 - incident.offenderSide, pos: incident.pos });
        return;
      case 'dive':
        this._setRestart({ type: 'freeKick', side: incident.offenderSide ?? 1 - (incident.victimSide ?? 0), pos: incident.pos });
        return;
      case 'offside':
        this._setRestart({ type: 'freeKick', side: 1 - incident.offenderSide, pos: incident.pos });
        return;
      case 'restart':
        this._setRestart({ type: payload.restartType, side: payload.toSide, pos: incident.pos });
        return;
      case 'medics':
      case 'stop':
        m.phase = 'stopped';
        m.stoppage += 20;
        this.emit('match:stopped', { incident });
        this._scheduleResume(incident);
        return;
      case 'abandon':
        this._abandon(incident);
        return;
      case 'protocol':
        this.protocolStep++;
        m.stoppage += 90;
        m.phase = 'stopped';
        this._scheduleResume(incident);
        return;
      case 'card':
        // Amonestación fuera de una falta (protesta, pérdida de tiempo):
        // se recupera la reanudación que estaba en marcha.
        if (m.restart) { m.phase = 'deadball'; this.deadballUntil = m.clock + 4; }
        else if (m.phase === 'decision') m.phase = 'play';
        return;
      default:
        // Sigue el juego (balón suelto)
        if (m.restart) { m.phase = 'deadball'; this.deadballUntil = m.clock + 3; }
        else if (m.phase === 'decision') m.phase = 'play';
        return;
    }
  }

  _scheduleResume(incident) {
    const m = this.match;
    this.resumeAt = m.clock + (incident.type === 'injury' ? 30 + (incident.level || 1) * 15 : 110);
    this.resumeIncident = incident;
  }

  /** Se evalúa cada tick mientras el partido está detenido. */
  _tickStopped() {
    const m = this.match;
    if (this.resumeAt == null || m.clock < this.resumeAt) return;
    const incident = this.resumeIncident;
    this.resumeAt = null;
    this.resumeIncident = null;
    if (incident && incident.type === 'injury') {
      const inj = entityById(m, incident.victimId);
      if (inj) {
        if (incident.level >= 3) this._considerSubstitution(inj.id);
        else { inj.injured = false; inj.downUntil = 0; }
      }
    }
    this._setRestart({ type: 'dropBall', side: m.possession ?? SIDE.HOME, pos: m.ball.pos });
    this.emit('match:resumed', {});
  }

  _abandon(incident) {
    const m = this.match;
    m.phase = 'abandoned';
    this.finished = true;
    this.logEvent('abandoned', { reason: incident.kind || 'security' });
    this.emit('match:abandoned', { incident });
    this._finish(true);
  }

  _setRestart({ type, side, pos }) {
    const m = this.match;
    this.timeWastingRaised = false;
    this.delayAccum = 0;
    m.restart = { type, side, pos: { x: clamp(pos.x, 0.5, L - 0.5), y: clamp(pos.y, 0.5, W - 0.5) } };
    m.phase = 'deadball';
    this.deadballUntil = m.clock + (type === 'penalty' ? 18 : type === 'freeKick' ? 14 : 9);
    m.stoppage += type === 'penalty' ? 25 : 6;
    this.emit('restart:set', { restart: m.restart });
  }

  _executeRestart() {
    const m = this.match;
    const r = m.restart;
    if (!r) { m.phase = 'play'; return; }
    m.phase = 'play';

    if (r.type === 'penalty') { this._takePenalty(r.side); return; }

    const takers = onPitch(m, r.side).filter((e) => e.role !== 'GK')
      .sort((a, b) => dist(a.pos, r.pos) - dist(b.pos, r.pos));
    let taker = takers[0];
    if (r.type === 'goalKick') taker = onPitch(m, r.side).find((e) => e.role === 'GK') || takers[0];
    if (!taker) { m.phase = 'play'; return; }

    let bp = { ...r.pos };
    if (r.type === 'corner') {
      const gx = targetGoalX(m, r.side);
      bp = { x: gx > L / 2 ? L - 0.4 : 0.4, y: r.pos.y > W / 2 ? W - 0.4 : 0.4 };
    } else if (r.type === 'goalKick') {
      const gx = ownGoalX(m, r.side);
      bp = { x: gx > L / 2 ? L - 6 : 6, y: W / 2 };
    } else if (r.type === 'throwIn') {
      bp = { x: r.pos.x, y: r.pos.y < W / 2 ? 0.2 : W - 0.2 };
    }

    taker.pos.x = bp.x; taker.pos.y = bp.y;
    taker.vel.x = 0; taker.vel.y = 0;
    m.ball.pos = { ...bp };
    m.ball.vel = { x: 0, y: 0 };
    m.ball.height = 0; m.ball.vz = 0;
    m.ball.owner = taker.id;
    m.ball.lastTouch = taker.id;
    m.ball.lastTouchSide = taker.side;
    m.possession = taker.side;
    taker.actionCd = 0.35;

    // Colocación de balón parado: barrera en las faltas cerca del área y
    // jugadores subidos al remate en los córners.
    if (r.type === 'corner') {
      this._setCornerPositions(r.side, bp);
      this.pendingDelivery = { type: 'corner', takerId: taker.id, at: m.clock + 2.5, side: r.side };
    } else if (r.type === 'freeKick') {
      const wall = this._setFreeKickPositions(r.side, bp);
      if (wall) this.pendingDelivery = { type: 'freeKick', takerId: taker.id, at: m.clock + 3, side: r.side, wall };
    }

    this.emit('restart:taken', { type: r.type, side: r.side, taker });
    m.restart = null;
  }

  /**
   * Pérdida de tiempo: el equipo que gana estira las reanudaciones en el
   * tramo final. Si el retraso se hace descarado, llega al árbitro.
   */
  _checkTimeWasting(matchDt) {
    const m = this.match;
    const r = m.restart;
    if (!r || this.timeWastingRaised) return;
    if (!['throwIn', 'goalKick', 'freeKick', 'corner'].includes(r.type)) return;

    const minute = m.clock / 60;
    const leading = m.score[r.side] > m.score[1 - r.side];
    if (!leading || minute < 60) return;

    this.delayAccum = (this.delayAccum || 0) + matchDt;
    // Cuanto más avanzado el partido y más corta la ventaja, más tentación
    const urge = (minute - 60) / 30 * (Math.abs(m.score[0] - m.score[1]) === 1 ? 1.4 : 0.7);
    if (this.delayAccum < 6 || m.rng.next() > 0.02 * urge) return;

    const taker = onPitch(m, r.side)
      .sort((a, b) => dist(a.pos, r.pos) - dist(b.pos, r.pos))[0];
    if (!taker) return;

    const delaySeconds = this.delayAccum + m.rng.float(2, 10);
    this.deadballUntil += delaySeconds * 0.5;
    m.stoppage += delaySeconds;
    this.timeWastingRaised = true;
    this.delayAccum = 0;

    const inc = makeTimeWastingIncident(m, taker, delaySeconds);
    this.logEvent('timeWasting', { player: taker.player.name, seconds: Math.round(delaySeconds) });
    this._raise(inc);
  }

  /** Coloca la barrera y a los rematadores en una falta peligrosa. */
  _setFreeKickPositions(side, bp) {
    const m = this.match;
    const gx = targetGoalX(m, side);
    const gy = W / 2;
    const d = Math.hypot(gx - bp.x, gy - bp.y);
    if (d > 32) return null;                       // demasiado lejos: sin barrera

    const ang = Math.atan2(gy - bp.y, gx - bp.x);
    const wallCount = d < 18 ? 4 : d < 26 ? 3 : 2;
    const defenders = onPitch(m, 1 - side)
      .filter((e) => e.role !== 'GK')
      .sort((a, b) => dist(a.pos, bp) - dist(b.pos, bp));

    const wall = [];
    for (let i = 0; i < wallCount && i < defenders.length; i++) {
      const e = defenders[i];
      const off = (i - (wallCount - 1) / 2) * 0.75;
      e.pos.x = clamp(bp.x + Math.cos(ang) * 9.15 - Math.sin(ang) * off, 1, L - 1);
      e.pos.y = clamp(bp.y + Math.sin(ang) * 9.15 + Math.cos(ang) * off, 1, W - 1);
      e.vel.x = 0; e.vel.y = 0;
      e.facing = ang + Math.PI;
      wall.push(e.id);
    }

    // Rematadores y marcadores dentro del área
    const attackers = onPitch(m, side).filter((e) => e.role !== 'GK' && e.id !== m.ball.owner)
      .sort((a, b) => b.player.heading - a.player.heading).slice(0, 4);
    const markers = defenders.slice(wallCount, wallCount + 4);
    attackers.forEach((e, i) => {
      e.pos.x = clamp(gx + (gx > L / 2 ? -1 : 1) * (7 + i * 1.6), 2, L - 2);
      e.pos.y = clamp(gy + (i - 1.5) * 4.2, 3, W - 3);
      e.vel.x = 0; e.vel.y = 0;
      const mk = markers[i];
      if (mk) {
        mk.pos.x = clamp(e.pos.x + (gx > L / 2 ? -1.2 : 1.2), 2, L - 2);
        mk.pos.y = clamp(e.pos.y + 0.8, 3, W - 3);
        mk.vel.x = 0; mk.vel.y = 0;
      }
    });
    return wall;
  }

  /** Llena el área en un saque de esquina. */
  _setCornerPositions(side, bp) {
    const m = this.match;
    const gx = targetGoalX(m, side);
    const inward = gx > L / 2 ? -1 : 1;
    const attackers = onPitch(m, side).filter((e) => e.role !== 'GK' && e.id !== m.ball.owner)
      .sort((a, b) => b.player.heading - a.player.heading).slice(0, 5);
    const defenders = onPitch(m, 1 - side).filter((e) => e.role !== 'GK')
      .sort((a, b) => b.player.heading - a.player.heading).slice(0, 6);

    attackers.forEach((e, i) => {
      e.pos.x = clamp(gx + inward * (5 + (i % 3) * 2.4), 2, L - 2);
      e.pos.y = clamp(W / 2 + (i - 2) * 3.4, 4, W - 4);
      e.vel.x = 0; e.vel.y = 0;
    });
    defenders.forEach((e, i) => {
      e.pos.x = clamp(gx + inward * (3.5 + (i % 3) * 2.2), 2, L - 2);
      e.pos.y = clamp(W / 2 + (i - 2.5) * 3.1, 4, W - 4);
      e.vel.x = 0; e.vel.y = 0;
    });
  }

  /**
   * Ejecuta el envío: el córner se centra al área y la falta cercana se
   * dispara por encima de la barrera o se pone al segundo palo.
   */
  _deliverSetPiece() {
    const m = this.match;
    const del = this.pendingDelivery;
    if (!del || m.clock < del.at) return;
    this.pendingDelivery = null;
    if (m.phase !== 'play') return;

    const taker = entityById(m, del.takerId);
    if (!taker || m.ball.owner !== taker.id) return;

    const gx = targetGoalX(m, del.side);
    const inward = gx > L / 2 ? -1 : 1;
    const skill = taker.player.passing * 0.6 + taker.player.technique * 0.4;
    const err = (1.1 - skill / 110) * (m.weather.slip > 0.1 ? 1.3 : 1);

    if (del.type === 'corner') {
      const target = {
        x: gx + inward * m.rng.float(4.5, 11),
        y: W / 2 + m.rng.gauss(0, 4.5 * err),
      };
      this._launchBall(taker, target, m.rng.float(0.95, 1.15), true);
      this.logEvent('cross', { side: del.side, player: taker.player.name });
      return;
    }

    const d = Math.hypot(gx - taker.pos.x, W / 2 - taker.pos.y);
    const direct = d < 27 && m.rng.next() < 0.35 + taker.player.shooting / 300;
    if (direct) {
      const ty = W / 2 + m.rng.gauss(0, 3.6 * err);
      const dx = gx - taker.pos.x, dy = ty - taker.pos.y;
      const dd = Math.hypot(dx, dy) || 1;
      const sp = clamp(20 + taker.player.shooting / 7, 15, 32);
      m.ball.owner = null;
      m.ball.prevTouch = m.ball.lastTouch; m.ball.prevTouchSide = m.ball.lastTouchSide;
      m.ball.lastTouch = taker.id; m.ball.lastTouchSide = taker.side;
      m.ball.vel.x = (dx / dd) * sp;
      m.ball.vel.y = (dy / dd) * sp;
      m.ball.height = 1.9; m.ball.vz = -0.4;   // por encima de la barrera
      m.stats[taker.side].shots++;
      this.lastShot = { shooter: taker, clock: m.clock };
      this.logEvent('freeKickShot', { side: del.side, player: taker.player.name });
    } else {
      const target = {
        x: gx + inward * m.rng.float(5, 12),
        y: W / 2 + m.rng.gauss(0, 5 * err),
      };
      this._launchBall(taker, target, 1, true);
    }
  }

  /** Envía el balón a un punto (centro o servicio), con altura. */
  _launchBall(from, target, power = 1, lofted = false) {
    const m = this.match;
    const dx = target.x - from.pos.x, dy = target.y - from.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy, dx);
    const speed = clamp(d / (0.55 + d * 0.024) * power, 7, 26);
    m.ball.owner = null;
    m.ball.prevTouch = m.ball.lastTouch; m.ball.prevTouchSide = m.ball.lastTouchSide;
    m.ball.lastTouch = from.id; m.ball.lastTouchSide = from.side;
    m.ball.vel.x = Math.cos(ang) * speed;
    m.ball.vel.y = Math.sin(ang) * speed;
    if (lofted) { m.ball.height = 0.3; m.ball.vz = clamp(d * 0.28, 4, 8.5); }
    m.stats[from.side].passes++;
    from.hasBall = false;
  }

  _takePenalty(side) {
    const m = this.match;
    const shooters = onPitch(m, side).sort((a, b) => b.player.shooting - a.player.shooting);
    const shooter = shooters[0];
    const gk = onPitch(m, 1 - side).find((e) => e.role === 'GK');
    if (!shooter) { m.phase = 'play'; return; }
    const skill = shooter.player.shooting * 0.6 + shooter.player.technique * 0.4;
    const nerves = (m.importance / 200) + (Math.abs(m.score[0] - m.score[1]) <= 1 && m.clock > 75 * 60 ? 0.12 : 0);
    const gkSkill = gk ? (gk.player.positioning * 0.5 + gk.player.technique * 0.5) : 50;
    // Un penalti se marca en el 75-78% de los casos en el fútbol real; con la
    // base anterior el lanzador tipo se quedaba en el 68%.
    const p = clamp(0.70 + skill / 260 - gkSkill / 420 - nerves * 0.18, 0.35, 0.94);
    const scored = m.rng.next() < p;
    const gx = targetGoalX(m, side);
    if (scored) {
      m.score[side]++;
      m.stats[side].goals++;
      m.stats[side].shots++; m.stats[side].shotsOn++;
      m.lastGoalSide = side;
      m.phase = 'celebration';
      this.celebrationUntil = m.clock + 20;
      this.logEvent('penaltyScored', { player: shooter.player.name, side });
      this.emit('goal', { side, penalty: true });
    } else {
      m.stats[side].shots++;
      if (gk) m.stats[1 - side].saves++;
      this.logEvent('penaltyMissed', { player: shooter.player.name, side });
      this.emit('penaltyMissed', { side });
      this._setRestart({ type: 'goalKick', side: 1 - side, pos: { x: gx, y: W / 2 } });
    }
  }

  // ------------------------------------------------------------ reloj

  _checkHalfEnd() {
    const m = this.match;
    if (m.phase === 'decision' || m.phase === 'var') return;
    const half = m.half;
    const regular = half <= 2 ? 45 * 60 : 15 * 60;
    const elapsedInHalf = m.clock - (half === 1 ? 0 : half === 2 ? 45 * 60 : half === 3 ? 90 * 60 : 105 * 60);

    if (elapsedInHalf < regular) return;

    if (m.addedTime === 0) {
      m.addedTime = this._computeAddedTime();
      this.emit('addedTime', { minutes: m.addedTime / 60, half });
      return;
    }
    if (elapsedInHalf < regular + m.addedTime) return;

    // No cortar en mitad de una ocasión clara
    if (this._dangerousMoment()) return;

    this._endHalf();
  }

  _computeAddedTime() {
    const m = this.match;
    const raw = m.stoppage;
    m.stoppage = 0;
    const mins = clamp(Math.round(raw / 60), 1, 15);
    return mins * 60;
  }

  _dangerousMoment() {
    const m = this.match;
    if (m.phase !== 'play') return false;
    const c = m.ball.owner && entityById(m, m.ball.owner);
    if (!c) return false;
    const gx = targetGoalX(m, c.side);
    const d = Math.hypot(gx - m.ball.pos.x, W / 2 - m.ball.pos.y);
    return d < 26;
  }

  _endHalf() {
    const m = this.match;
    const half = m.half;
    m.addedTime = 0;
    m.stoppage = 0;

    if (half === 1) {
      m.half = 2;
      m.clock = 45 * 60;
      m.phase = 'halftime';
      this.emit('halftime', { match: m, report: this.buildHalfTimeReport() });
      return;
    }
    if (half === 2) {
      const drawn = m.score[0] === m.score[1];
      if (m.knockout && drawn) {
        m.half = 3; m.clock = 90 * 60; m.phase = 'deadball';
        setKickoffPositions(m, SIDE.AWAY);
        this.deadballUntil = m.clock + 2;
        this.emit('extraTime', { match: m });
        return;
      }
      this._finish();
      return;
    }
    if (half === 3) {
      m.half = 4; m.clock = 105 * 60; m.phase = 'deadball';
      setKickoffPositions(m, SIDE.HOME);
      this.deadballUntil = m.clock + 2;
      return;
    }
    if (half === 4) {
      if (m.knockout && m.score[0] === m.score[1]) { this._runShootout(); return; }
      this._finish();
    }
  }

  resumeFromHalfTime() {
    const m = this.match;
    m.phase = 'deadball';
    setKickoffPositions(m, m.kickoffSide === SIDE.HOME ? SIDE.AWAY : SIDE.HOME);
    this.deadballUntil = m.clock + 2;
    this.emit('secondHalf', {});
  }

  _runShootout() {
    const m = this.match;
    m.phase = 'shootout';
    m.half = 5;
    const takers = [onPitch(m, 0), onPitch(m, 1)].map((arr) =>
      arr.slice().sort((a, b) => b.player.shooting - a.player.shooting).slice(0, 11));
    const gks = [onPitch(m, 0).find((e) => e.role === 'GK'), onPitch(m, 1).find((e) => e.role === 'GK')];
    const sc = [0, 0];
    const seq = [];
    let i = 0;
    const kick = (side) => {
      const sh = takers[side][i % takers[side].length];
      const gk = gks[1 - side];
      const p = clamp(0.66 + (sh ? sh.player.shooting : 50) / 300 - (gk ? gk.player.positioning : 50) / 500, 0.4, 0.92);
      const ok = m.rng.next() < p;
      if (ok) sc[side]++;
      seq.push({ side, player: sh ? sh.player.name : '—', scored: ok });
      return ok;
    };
    for (let round = 0; round < 5; round++) {
      i = round;
      kick(0); kick(1);
      const rem = 5 - round - 1;
      if (sc[0] > sc[1] + rem || sc[1] > sc[0] + rem) break;
    }
    let round = 5;
    while (sc[0] === sc[1] && round < 20) { i = round; kick(0); kick(1); round++; }
    m.shootout = { sequence: seq, score: sc, winner: sc[0] > sc[1] ? 0 : 1 };
    this.emit('shootout', m.shootout);
    this._finish();
  }

  _finish(abandoned = false) {
    const m = this.match;
    // La última jugada del partido es justo la que más se quiere revisar:
    // se cierran los clips pendientes aunque no haya dado tiempo al epílogo.
    this._flushClips(true);
    this.finished = true;
    m.phase = abandoned ? 'abandoned' : 'fulltime';
    m.running = false;
    const report = this.buildReport(abandoned);
    m.report = report;
    this.emit('match:end', { match: m, report });
  }

  // --------------------------------------------------------- informes

  buildHalfTimeReport() {
    const m = this.match;
    return {
      score: m.score.slice(),
      stats: m.stats.map((s) => ({ ...s })),
      possession: this._possessionPct(),
      decisions: m.decisions.slice(),
      controversies: m.decisions.filter((d) => d.grade === GRADE.INCORRECT || d.impact === 'critical'),
      rating: this.rating.current(),
      notes: this.assistants.halfTimeNotes(),
      events: m.events.slice(),
    };
  }

  buildReport(abandoned = false) {
    const m = this.match;
    const r = this.rating.finalize();
    const dec = m.decisions.filter((d) => !d.auto);
    return {
      abandoned,
      matchId: m.id,
      competition: m.competition.name,
      competitionId: m.competition.id,
      title: m.title,
      teams: [m.teams[0].name, m.teams[1].name],
      teamIds: [m.teams[0].id, m.teams[1].id],
      stadium: m.stadium.name,
      weather: m.weatherId,
      score: m.score.slice(),
      shootout: m.shootout,
      stats: m.stats.map((s) => ({ ...s })),
      possession: this._possessionPct(),
      decisions: dec,
      counts: {
        total: dec.length,
        correct: dec.filter((d) => d.grade === GRADE.CORRECT).length,
        mostly: dec.filter((d) => d.grade === GRADE.MOSTLY).length,
        debatable: dec.filter((d) => d.grade === GRADE.DEBATABLE).length,
        incorrect: dec.filter((d) => d.grade === GRADE.INCORRECT).length,
      },
      rating: r,
      events: m.events.slice(),
      incidents: m.incidents.map((i) => ({
        id: i.id, type: i.type, minute: i.minute, grade: i.grade ? i.grade.grade : null,
        impact: i.impact, pos: i.pos, decision: i.decisionTaken, truth: i.truth,
        varUsed: !!i.varUsed, offenderId: i.offenderId,
      })),
      crew: {
        ar1: this.assistants.rate('ar1'),
        ar2: this.assistants.rate('ar2'),
        var: this.var.rate(),
      },
      supervisor: this.rating.supervisorNotes(m),
      clips: m.clips,
    };
  }

  _possessionPct() {
    const m = this.match;
    const a = m.stats[0].possessionTicks, b = m.stats[1].possessionTicks;
    const t = a + b || 1;
    return [Math.round((a / t) * 100), Math.round((b / t) * 100)];
  }

  // ------------------------------------------------------------ replays

  /**
   * Guarda la jugada de un incidente para poder revisarla después. El clip
   * se cierra unos segundos más tarde, cuando ya se ha visto el desenlace.
   */
  _requestClip(incident) {
    const m = this.match;
    this.pendingClips.push({
      id: incident.id,
      from: incident.clock - 9,
      until: m.clock + 3,
      minute: incident.minute,
      type: incident.type,
    });
    if (this.pendingClips.length > 40) this.pendingClips.shift();
  }

  _flushClips(force = false) {
    const m = this.match;
    if (!this.pendingClips.length) return;
    for (let i = this.pendingClips.length - 1; i >= 0; i--) {
      const req = this.pendingClips[i];
      if (!force && m.clock < req.until) continue;
      const frames = m.replayBuffer.filter((f) => f.t >= req.from && f.t <= req.until);
      if (frames.length > 4) {
        m.clips[req.id] = { id: req.id, minute: req.minute, type: req.type, frames };
      }
      this.pendingClips.splice(i, 1);
    }
    // No se guardan clips sin límite: el partido no debe crecer sin control
    const ids = Object.keys(m.clips);
    if (ids.length > 30) delete m.clips[ids[0]];
  }

  _recordReplayFrame() {
    const m = this.match;
    const frame = {
      t: m.clock,
      ball: { x: m.ball.pos.x, y: m.ball.pos.y, h: m.ball.height },
      ref: { x: m.ref.pos.x, y: m.ref.pos.y, f: m.ref.facing },
      players: m.entities.filter((e) => e.onPitch).map((e) => ({
        id: e.id, s: e.side, x: +e.pos.x.toFixed(2), y: +e.pos.y.toFixed(2), f: +e.facing.toFixed(2),
      })),
    };
    m.replayBuffer.push(frame);
    if (m.replayBuffer.length > 700) m.replayBuffer.shift();
  }

  // ------------------------------------------------------------- varios

  logEvent(kind, data = {}) {
    const m = this.match;
    const ev = { kind, minute: Math.floor(m.clock / 60), second: Math.floor(m.clock % 60), half: m.half, ...data };
    m.events.push(ev);
    this.emit('event', ev);
  }

  _name(id) {
    const e = id && entityById(this.match, id);
    return e ? e.player.name : '—';
  }
}

export default MatchEngine;
