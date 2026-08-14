// Carrera: temporadas, designaciones, ascensos, economía, entrenamiento
// y todo lo que ocurre entre partido y partido.

import { RNG, clamp } from '../core/rng.js';
import { DIFFICULTY, WEATHER } from '../core/config.js';
import { generateWorld, DIVISIONS, divisionById, generateCrew, clubsOfDivision } from '../data/generators.js';
import { createReferee, addExperience, trainStat, avgRating, overall } from './referee.js';
import { PressSystem } from './press.js';
import { AchievementSystem } from './achievements.js';
import { Syndicate } from './syndicate.js';
import { Academy } from './academy.js';

export const TRAINING = [
  { id: 'positioning', stat: 'positioning', fatigue: 18, gain: 2.2 },
  { id: 'offside', stat: 'rules', fatigue: 10, gain: 1.8 },
  { id: 'fouls', stat: 'accuracy', fatigue: 14, gain: 2.0 },
  { id: 'advantage', stat: 'control', fatigue: 12, gain: 1.9 },
  { id: 'communication', stat: 'communication', fatigue: 8, gain: 2.1 },
  { id: 'var', stat: 'var', fatigue: 6, gain: 2.4 },
  { id: 'concentration', stat: 'concentration', fatigue: 12, gain: 1.9 },
  { id: 'stamina', stat: 'fitness', fatigue: 26, gain: 2.3 },
  { id: 'rest', stat: null, fatigue: -40, gain: 0 },
];

/**
 * Gastos. La economía existe para que el dinero pese en las decisiones, no
 * para convertir el juego en una tienda: son pocas compras, todas con un
 * efecto real y comprobable sobre la carrera.
 */
export const ASSETS = [
  {
    id: 'gym', cost: 900, upkeep: 40,
    effects: { recoveryPerRound: 8 },
  },
  {
    id: 'physio', cost: 2200, upkeep: 120,
    effects: { matchFatigue: -5, stats: { fitness: 1.5 } },
  },
  {
    id: 'car', cost: 6500, upkeep: 90,
    effects: { matchFatigue: -4 },
  },
  {
    id: 'home', cost: 24000, upkeep: 260,
    effects: { recoveryPerRound: 6, moralePerRound: 2 },
  },
  {
    id: 'course', cost: 1600, upkeep: 0,
    effects: { stats: { rules: 3, accuracy: 0.8 } },
  },
  {
    id: 'kit', cost: 700, upkeep: 0,
    effects: { stats: { communication: 2, concentration: 1 } },
  },
  {
    id: 'analyst', cost: 4800, upkeep: 180,
    effects: { stats: { var: 2.5, positioning: 1 } },
  },
];

const PROMOTION = { minMatches: 6, minAvg: 7.2, minReputation: 30 };
const RELEGATION = { minMatches: 8, maxAvg: 5.1 };

export class Career {
  constructor(opts = {}) {
    this.mode = opts.mode || 'career';       // career | syndicate | classic
    this.worldSeed = opts.worldSeed || `w${Date.now()}`;
    this.world = opts.world || generateWorld(this.worldSeed);
    this.referee = opts.referee || createReferee(opts.refereeOpts || {});
    this.difficultyId = opts.difficulty || 'normal';
    this.season = 1;
    this.round = 1;
    this.divisionId = opts.divisionId || 'regional';
    this.divisionMatches = 0;
    this.divisionRatings = [];
    this.rng = new RNG(`${this.worldSeed}:career`);
    this.assignments = [];
    this.currentAssignment = null;
    this.history = [];
    this.inbox = [];
    this.press = new PressSystem(this);
    this.achievements = new AchievementSystem(this);
    this.syndicate = new Syndicate(this);
    this.academy = new Academy(this);
    this.pendingEthics = null;
    this.pendingPressConference = null;
    this.fatigue = 0;
    this.assets = {};        // bienes comprados: id -> true
    this.ledger = [];        // últimos movimientos de dinero
    this.ended = null;
    this.generateAssignments();
  }

  get difficulty() { return DIFFICULTY[this.difficultyId] || DIFFICULTY.normal; }
  get division() { return this.world.divisions.find((d) => d.id === this.divisionId) || this.world.divisions[0]; }

  avgRating() { return avgRating(this.referee); }

  // ------------------------------------------------------------ economía

  owns(id) { return !!this.assets[id]; }

  /** Suma de un efecto entre todo lo que el árbitro posee. */
  assetBonus(key) {
    let total = 0;
    for (const a of ASSETS) {
      if (!this.assets[a.id]) continue;
      const v = a.effects[key];
      if (typeof v === 'number') total += v;
    }
    return total;
  }

  /** Coste fijo por jornada: vivir cuesta más cuanto más alto arbitras. */
  livingCost() {
    const base = Math.round(20 + this.division.level * 1.4);
    const upkeep = ASSETS.reduce((sum, a) => sum + (this.assets[a.id] ? a.upkeep : 0), 0);
    return base + upkeep;
  }

  spend(amount, concept) {
    this.referee.money -= amount;
    this.ledger.unshift({ concept, amount: -amount, season: this.season, round: this.round });
    this.ledger = this.ledger.slice(0, 40);
    return this.referee.money;
  }

  earn(amount, concept) {
    this.referee.money += amount;
    this.ledger.unshift({ concept, amount, season: this.season, round: this.round });
    this.ledger = this.ledger.slice(0, 40);
    return this.referee.money;
  }

  /** Compra un bien. Devuelve el resultado para que la interfaz lo explique. */
  buy(id) {
    const asset = ASSETS.find((a) => a.id === id);
    if (!asset) return { ok: false, reason: 'unknown' };
    if (this.assets[id]) return { ok: false, reason: 'owned' };
    if (this.referee.money < asset.cost) return { ok: false, reason: 'money', missing: asset.cost - this.referee.money };

    this.spend(asset.cost, `buy:${id}`);
    this.assets[id] = true;

    const gains = {};
    if (asset.effects.stats) {
      for (const [stat, amount] of Object.entries(asset.effects.stats)) {
        const g = trainStat(this.referee, stat, amount);
        if (g > 0) gains[stat] = g;
      }
    }
    return { ok: true, asset, gains, money: this.referee.money };
  }

  // ------------------------------------------------------ designaciones

  generateAssignments() {
    const div = this.division;
    const pool = clubsOfDivision(this.world, this.divisionId);
    const rng = this.rng;
    const count = 3;
    const used = new Set();
    const out = [];

    for (let i = 0; i < count; i++) {
      let home, away, guard = 0;
      do {
        home = rng.pick(pool);
        away = rng.pick(pool);
        guard++;
      } while ((home.id === away.id || used.has(home.id) || used.has(away.id)) && guard < 60);
      used.add(home.id); used.add(away.id);

      const rivalry = (home.rivals.find((r) => r.id === away.id) || {}).intensity || 0;
      const importance = clamp(Math.round(
        (home.prestige + away.prestige) / 2 * 0.6 + rivalry * 0.3 + div.level * 0.25
        + rng.gauss(0, 8),
      ), 10, 100);
      const knockout = !!div.cup && rng.bool(0.6);
      const isFinal = knockout && rng.bool(0.12);
      const weather = rng.weighted([
        ['clear', 46], ['rain', 22], ['wind', 12], ['storm', 6], ['snow', 4], ['heat', 10],
      ]);

      out.push({
        id: `a${this.season}-${this.round}-${i}`,
        homeId: home.id, awayId: away.id,
        homeName: home.name, awayName: away.name,
        divisionId: this.divisionId,
        competitionName: isFinal ? `${div.name} — ${'Final'}` : div.name,
        stadium: home.stadium,
        rivalry, importance, knockout, isFinal,
        derby: rivalry > 65,
        weather,
        pressure: this._pressureOf(importance, rivalry),
        difficultyLabel: this._difficultyOf(home, away, importance),
        fee: Math.round(div.fee * (0.85 + importance / 200) * (isFinal ? 2.4 : 1)),
        xp: Math.round(div.xp * (0.9 + importance / 240) * (isFinal ? 1.8 : 1)),
      });
    }
    this.assignments = out;
    return out;
  }

  _pressureOf(importance, rivalry) {
    const p = importance * 0.7 + rivalry * 0.4;
    if (p > 105) return 'extreme';
    if (p > 75) return 'high';
    if (p > 45) return 'medium';
    return 'low';
  }

  _difficultyOf(home, away, importance) {
    const raw = (home.aggression + away.aggression) / 2 * 0.5 + importance * 0.5;
    if (raw > 78) return 'extreme';
    if (raw > 58) return 'high';
    if (raw > 38) return 'medium';
    return 'low';
  }

  /** Configuración lista para createMatch(). */
  matchConfigFor(assignment) {
    const home = this.world.clubs[assignment.homeId] || this.world.nationalTeams[assignment.homeId];
    const away = this.world.clubs[assignment.awayId] || this.world.nationalTeams[assignment.awayId];
    const div = this.division;
    const rng = this.rng.fork(assignment.id);
    return {
      home, away,
      competition: div,
      seed: `${this.worldSeed}:${assignment.id}`,
      weather: assignment.weather,
      importance: assignment.importance,
      rivalry: assignment.rivalry,
      difficulty: this.difficulty,
      referee: this.referee,
      crew: generateCrew(rng, div.level, !!div.var),
      varEnabled: !!div.var,
      knockout: assignment.knockout,
      title: assignment.isFinal ? assignment.competitionName : null,
      stadium: assignment.stadium,
    };
  }

  accept(assignmentId) {
    const a = this.assignments.find((x) => x.id === assignmentId);
    if (!a) return null;
    this.currentAssignment = a;
    return a;
  }

  // --------------------------------------------------- fin de partido

  finishMatch(report) {
    const ref = this.referee;
    const a = this.currentAssignment;
    const rating = report.rating.overall;

    ref.record.matches++;
    ref.record.ratings.push(rating);
    ref.record.yellows += report.stats[0].yellows + report.stats[1].yellows;
    ref.record.reds += report.stats[0].reds + report.stats[1].reds;
    ref.record.penalties += report.stats[0].penalties + report.stats[1].penalties;
    ref.record.goals += report.score[0] + report.score[1];
    ref.record.correct += report.counts.correct;
    ref.record.mostly += report.counts.mostly;
    ref.record.debatable += report.counts.debatable;
    ref.record.incorrect += report.counts.incorrect;
    ref.record.varReviews += report.rating.varCalls.used;
    if (report.abandoned) ref.record.abandoned++;

    this.divisionMatches++;
    this.divisionRatings.push(rating);

    // Experiencia y dinero
    const xpMult = clamp(0.55 + rating / 12, 0.4, 1.6);
    const xp = Math.round((a ? a.xp : 60) * xpMult);
    const levels = addExperience(ref, xp);
    const fee = Math.round((a ? a.fee : 100) * clamp(0.7 + rating / 15, 0.6, 1.5));
    this.earn(fee, 'fee');

    // Reputación
    const repDelta = (rating - 6.5) * (a && a.importance > 70 ? 2.6 : 1.6);
    ref.reputation = clamp(ref.reputation + repDelta, 0, 100);
    ref.morale = clamp(ref.morale + (rating - 6.2) * 5, 0, 100);

    // Atributos: se aprende de los partidos
    const gains = {};
    const learn = (stat, amount) => { const g = trainStat(ref, stat, amount); if (g > 0) gains[stat] = g; };
    learn('accuracy', clamp((rating - 5) * 0.22, 0, 1.2));
    learn('positioning', clamp((report.rating.breakdown.positioning - 5) * 0.16, 0, 1));
    learn('pressure', a && a.importance > 65 ? 0.5 : 0.15);
    learn('concentration', 0.2);
    if (report.rating.varCalls.used) learn('var', 0.5);

    // Condición física: el desplazamiento y la recuperación dependen de en
    // qué se haya gastado el dinero.
    const matchFatigue = clamp(22 + this.assetBonus('matchFatigue'), 8, 30);
    this.fatigue = clamp(this.fatigue + matchFatigue, 0, 100);
    ref.condition = clamp(100 - this.fatigue, 10, 100);

    const entry = {
      season: this.season, round: this.round,
      assignment: a ? { ...a } : null,
      report: {
        score: report.score, teams: report.teams, rating, counts: report.counts,
        stats: report.stats, competition: report.competition, supervisor: report.supervisor,
        abandoned: report.abandoned, stadium: report.stadium,
        incidents: report.incidents, events: report.events,
        crew: report.crew, possession: report.possession,
      },
      xp, fee, repDelta: +repDelta.toFixed(1), gains, levels,
    };
    this.history.push(entry);

    // Prensa, logros, trama y ética
    const news = this.press.afterMatch(report, a);
    this.pendingPressConference = this.press.buildConference(report, a);
    const unlocked = this.achievements.checkAfterMatch(report, this);
    this.syndicate.afterMatch(report, a);
    this.pendingEthics = this._maybeEthicsEvent(a);

    const movement = this._checkProgression();

    this.currentAssignment = null;
    return { entry, news, unlocked, movement };
  }

  _checkProgression() {
    const idx = DIVISIONS.findIndex((d) => d.id === this.divisionId);
    const recent = this.divisionRatings.slice(-8);
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;

    if (this.divisionMatches >= PROMOTION.minMatches && avg >= PROMOTION.minAvg
      && this.referee.reputation >= PROMOTION.minReputation
      && this.academy.passedFor(this.divisionId)
      && idx < DIVISIONS.length - 1) {
      const next = DIVISIONS[idx + 1];
      this.divisionId = next.id;
      this.divisionMatches = 0;
      this.divisionRatings = [];
      this.referee.record.promotions++;
      this.inbox.push({ type: 'promotion', divisionId: next.id, season: this.season });
      this.generateAssignments();
      return { type: 'promotion', divisionId: next.id, name: next.name };
    }

    if (this.divisionMatches >= RELEGATION.minMatches && avg <= RELEGATION.maxAvg && idx > 0) {
      const prev = DIVISIONS[idx - 1];
      this.divisionId = prev.id;
      this.divisionMatches = 0;
      this.divisionRatings = [];
      this.inbox.push({ type: 'relegation', divisionId: prev.id, season: this.season });
      this.generateAssignments();
      return { type: 'relegation', divisionId: prev.id, name: prev.name };
    }
    return null;
  }

  // ----------------------------------------------------------- ética

  _maybeEthicsEvent(assignment) {
    const ref = this.referee;
    const base = 0.05 + (this.division.level / 100) * 0.08 + (ref.corruption > 0 ? 0.18 : 0);
    if (this.rng.next() > base) return null;
    const club = this.world.clubs[this.rng.pick(this.division.clubIds || [])]
      || this.world.clubs[this.world.allClubIds[0]];
    const amount = Math.round(this.division.fee * this.rng.float(4, 14));
    return {
      id: `eth${this.season}-${this.round}`,
      clubId: club.id,
      clubName: club.name,
      amount,
      // La carrera guarda la clave y sus datos, no el texto ya traducido: la
      // lógica no debe contener textos (y una partida guardada en español
      // seguiría enseñando español después de cambiar de idioma).
      textKey: 'ethics.offer',
      textArgs: { club: club.name, amount },
    };
  }

  resolveEthics(choice) {
    const ref = this.referee;
    const ev = this.pendingEthics;
    if (!ev) return null;
    this.pendingEthics = null;
    let result;
    switch (choice) {
      case 'accept':
        ref.money += ev.amount;
        ref.corruption = clamp(ref.corruption + 22, 0, 100);
        ref.suspicion = clamp(ref.suspicion + 12, 0, 100);
        ref.ethics = clamp(ref.ethics - 25, 0, 100);
        this.syndicate.onBribeAccepted(ev);
        result = { type: 'accepted', money: ev.amount };
        break;
      case 'refuse':
        ref.ethics = clamp(ref.ethics + 8, 0, 100);
        ref.reputation = clamp(ref.reputation + 1.5, 0, 100);
        result = { type: 'refused' };
        break;
      case 'report':
        ref.ethics = clamp(ref.ethics + 16, 0, 100);
        ref.reputation = clamp(ref.reputation + 4, 0, 100);
        this.syndicate.onReported(ev);
        result = { type: 'reported' };
        break;
      default:
        ref.suspicion = clamp(ref.suspicion + 3, 0, 100);
        result = { type: 'ignored' };
    }
    this.achievements.check('ethics', { choice });
    return result;
  }

  // ------------------------------------------------------ entrenamiento

  train(sessionId) {
    const s = TRAINING.find((t) => t.id === sessionId);
    if (!s) return null;
    if (s.id === 'rest') {
      this.fatigue = clamp(this.fatigue - 40, 0, 100);
      this.referee.condition = clamp(100 - this.fatigue, 10, 100);
      return { rest: true, fatigue: this.fatigue };
    }
    if (this.fatigue > 88) return { blocked: true };
    const efficiency = clamp(1 - this.fatigue / 160, 0.35, 1);
    const gain = trainStat(this.referee, s.stat, s.gain * efficiency);
    this.fatigue = clamp(this.fatigue + s.fatigue, 0, 100);
    this.referee.condition = clamp(100 - this.fatigue, 10, 100);
    return { stat: s.stat, gain, fatigue: this.fatigue };
  }

  advanceRound() {
    this.round++;
    // Gastos fijos de la jornada
    const cost = this.livingCost();
    this.spend(cost, 'living');
    if (this.referee.money < 0) {
      // Vivir por encima de tus posibilidades pasa factura fuera del campo
      this.referee.morale = clamp(this.referee.morale - 6, 0, 100);
      if (!this.inbox.some((i) => i.type === 'debt' && i.season === this.season)) {
        this.inbox.push({ type: 'debt', season: this.season, round: this.round });
      }
    }
    this.referee.morale = clamp(this.referee.morale + this.assetBonus('moralePerRound'), 0, 100);
    this.fatigue = clamp(this.fatigue - (12 + this.assetBonus('recoveryPerRound')), 0, 100);
    this.referee.condition = clamp(100 - this.fatigue, 10, 100);
    if (this.round > 24) { this.round = 1; this.season++; this.referee.age++; this._seasonEnd(); }
    this.generateAssignments();
    return { round: this.round, season: this.season };
  }

  _seasonEnd() {
    const ref = this.referee;
    this.inbox.push({ type: 'seasonEnd', season: this.season - 1, avg: this.avgRating() });
    // Retirada por edad
    if (ref.age >= 48) this.ended = this.computeEnding();
  }

  /** Final de carrera según lo que hizo el jugador. */
  computeEnding() {
    const ref = this.referee;
    const avg = this.avgRating() || 0;
    const idx = DIVISIONS.findIndex((d) => d.id === this.divisionId);
    if (this.syndicate.exposed) return { id: 'whistleblower', key: 'ending.whistleblower' };
    if (ref.corruption > 60) return { id: 'corrupt', key: 'ending.corrupt' };
    if (ref.suspicion > 80) return { id: 'banned', key: 'ending.banned' };
    if (idx >= 8 && avg >= 8) return { id: 'legend', key: 'ending.legend' };
    if (idx >= 7) return { id: 'international', key: 'ending.international' };
    if (avg >= 7) return { id: 'respected', key: 'ending.respected' };
    if (ref.record.matches < 20) return { id: 'earlyRetirement', key: 'ending.earlyRetirement' };
    return { id: 'controversial', key: 'ending.controversial' };
  }

  retire() {
    this.ended = this.computeEnding();
    return this.ended;
  }

  // ------------------------------------------------------ persistencia

  serialize() {
    const ref = this.referee;
    return {
      mode: this.mode,
      worldSeed: this.worldSeed,
      difficultyId: this.difficultyId,
      season: this.season, round: this.round,
      divisionId: this.divisionId,
      divisionMatches: this.divisionMatches,
      divisionRatings: this.divisionRatings,
      fatigue: this.fatigue,
      assets: this.assets,
      ledger: this.ledger.slice(0, 20),
      rngState: this.rng.state(),
      referee: {
        firstName: ref.firstName, lastName: ref.lastName, gender: ref.gender,
        age: ref.age, nationId: ref.nationId, appearance: ref.appearance,
        stats: ref.stats, condition: ref.condition, morale: ref.morale,
        reputation: ref.reputation, ethics: ref.ethics, experience: ref.experience,
        level: ref.level, money: ref.money, followers: ref.followers,
        corruption: ref.corruption, suspicion: ref.suspicion, record: ref.record,
      },
      assignments: this.assignments,
      history: this.history.slice(-40),
      inbox: this.inbox.slice(-30),
      press: this.press.serialize(),
      academy: this.academy.serialize(),
      syndicate: this.syndicate.serialize(),
      achievements: this.achievements.serialize(),
      ended: this.ended,
    };
  }

  static deserialize(data) {
    const c = new Career({
      mode: data.mode,
      worldSeed: data.worldSeed,
      difficulty: data.difficultyId,
      divisionId: data.divisionId,
      refereeOpts: { seed: data.worldSeed },
    });
    Object.assign(c.referee, data.referee);
    c.season = data.season; c.round = data.round;
    c.divisionMatches = data.divisionMatches;
    c.divisionRatings = data.divisionRatings || [];
    c.fatigue = data.fatigue || 0;
    c.assets = data.assets || {};
    c.ledger = data.ledger || [];
    if (data.rngState) c.rng.setState(data.rngState);
    c.assignments = data.assignments || [];
    c.history = data.history || [];
    c.inbox = data.inbox || [];
    c.press.restore(data.press);
    c.academy.restore(data.academy);
    c.syndicate.restore(data.syndicate);
    c.achievements.restore(data.achievements);
    c.ended = data.ended || null;
    if (!c.assignments.length) c.generateAssignments();
    return c;
  }
}

export default Career;
