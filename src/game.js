// Controlador del juego: une motor, render, HUD, pantallas, audio,
// carrera y guardado. Aquí vive la máquina de estados de la aplicación.

import { GAME, DIFFICULTY, WEATHER } from './core/config.js';
import { setLocale, getLocale, t } from './core/i18n.js';
import { RNG, clamp } from './core/rng.js';
import { loadSettings, saveSettings, saveGame, loadGame, deleteSave, lastSaveSlot } from './core/save.js';
import { generateWorld, clubsOfDivision, divisionById, generateCrew } from './data/generators.js';
import { findSpecial } from './data/scenarios.js';
import { createMatch } from './match/state.js';
import { MatchEngine } from './match/matchEngine.js';
import { Career } from './career/career.js';
import { createReferee, KITS } from './career/referee.js';
import { Academy } from './career/academy.js';
import { AchievementSystem } from './career/achievements.js';
import { Renderer } from './ui/renderer.js';
import { HUD } from './ui/hud.js';
import { Screens } from './ui/screens.js';
import { AudioSystem } from './audio/audio.js';
import { makeAutoReferee } from './ai/autoReferee.js';

const SPEEDS = [0.5, 1, 2, 4];

export class Game {
  constructor(dom) {
    this.dom = dom;
    this.settings = loadSettings();
    setLocale(this.settings.locale);
    this.audio = new AudioSystem(this.settings);
    this.renderer = new Renderer(dom.canvas);
    this.hud = new HUD(dom.hud, this);
    this.screens = new Screens(dom.screens, this);
    this.career = null;
    this.match = null;
    this.engine = null;
    this.speedIdx = SPEEDS.indexOf(this.settings.matchSpeed) >= 0 ? SPEEDS.indexOf(this.settings.matchSpeed) : 1;
    this.paused = false;
    this.mode = 'menu';
    this.special = null;
    this.tutorial = null;
    this._world = null;
    this.freeAcademy = new Academy({ rng: new RNG('free'), season: 0, round: 0, referee: createReferee({ seed: 'free' }), achievements: { check: () => [] } });
    this.freeAchievements = new AchievementSystem({ referee: null });
    this.keys = new Set();
    this.lastFrame = performance.now();
    this._bindInput();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------- entrada

  _bindInput() {
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      this.keys.add(e.key.toLowerCase());
      if (e.key === ' ') this.togglePause();
      if (e.key.toLowerCase() === 'c') this.renderer.follow = !this.renderer.follow;
      if (/^[1-6]$/.test(e.key)) this._hotkeyDecision(Number(e.key) - 1);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('resize', () => this.renderer.resize());
    this.dom.canvas.addEventListener('pointerdown', () => this.audio.ensure());
    window.addEventListener('gamepadconnected', (e) => {
      this.hud.toast(`🎮 ${e.gamepad.id.slice(0, 28)}`, 'good', 3000);
    });
  }

  _hotkeyDecision(i) {
    const btns = this.dom.hud.querySelectorAll('.decision-panel .dp-actions button');
    if (btns[i]) btns[i].click();
  }

  _readInput() {
    const k = this.keys;
    let dx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    let dy = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0);
    let sprint = k.has('shift');

    // Palanca táctil. Si el campo está girado, la dirección también.
    const tp = this.hud.touch;
    if (tp && tp.active) {
      if (this.renderer.rotated) { dx = -tp.dy; dy = tp.dx; }
      else { dx = tp.dx; dy = tp.dy; }
    }
    if (tp && tp.sprint) sprint = true;

    // Mando físico
    const gp = this._readGamepad();
    if (gp) {
      if (Math.abs(gp.dx) > 0.18 || Math.abs(gp.dy) > 0.18) {
        if (this.renderer.rotated) { dx = -gp.dy; dy = gp.dx; }
        else { dx = gp.dx; dy = gp.dy; }
      }
      if (gp.sprint) sprint = true;
    }
    return { dx, dy, sprint };
  }

  /**
   * Mando: palanca izquierda para moverse, gatillo/A para esprintar y los
   * cuatro botones frontales para las cuatro primeras opciones de decisión.
   */
  _readGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    let pad = null;
    for (const p of pads) { if (p && p.connected) { pad = p; break; } }
    if (!pad) return null;

    const dead = (v) => (Math.abs(v) < 0.16 ? 0 : v);
    const dx = dead(pad.axes[0] || 0);
    const dy = dead(pad.axes[1] || 0);
    const pressed = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);

    // Flanco de subida: un botón sostenido no repite la decisión
    this._padPrev = this._padPrev || {};
    const edge = (i) => {
      const now = pressed(i);
      const was = this._padPrev[i];
      this._padPrev[i] = now;
      return now && !was;
    };

    if (this.engine && this.engine.pending) {
      for (let i = 0; i < 4; i++) if (edge(i)) this._hotkeyDecision(i);
      if (edge(4)) this._hotkeyDecision(4);   // L1 -> quinta opción
      if (edge(5)) this._hotkeyDecision(5);   // R1 -> sexta opción
    } else {
      for (let i = 0; i < 6; i++) edge(i);    // mantiene el estado al día
    }
    if (edge(9)) this.togglePause();          // Start
    if (edge(8)) this.renderer.follow = !this.renderer.follow; // Select

    return { dx, dy, sprint: pressed(7) || pressed(0) };
  }

  togglePause() {
    if (!this.engine || this.engine.finished) return;
    this.paused = !this.paused;
    this.hud.toast(this.paused ? t('hud.paused') : '▶', 'info', 1200);
  }

  speedLabel() { return `${SPEEDS[this.speedIdx]}×`; }

  cycleSpeed() {
    this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
    if (this.engine) this.engine.speed = SPEEDS[this.speedIdx];
    this.settings.matchSpeed = SPEEDS[this.speedIdx];
    saveSettings(this.settings);
  }

  // --------------------------------------------------------------- bucle

  _loop(now) {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.engine && !this.engine.finished) {
      const varSession = this.engine.var.session;
      if (varSession) {
        this.engine.var.tick(dt);
        this.renderer.drawReplay(this.engine.var.currentFrame(), this.match, varSession);
      } else {
        if (!this.paused && this.mode === 'match') {
          this.engine.setInput(this._readInput());
          this.engine.update(dt);
        }
        const pendingIncident = this.engine.pending ? this.engine.pending.incident : null;
        // El campo se atenúa mientras hay algo que juzgar: la vista acompaña
        // a la decisión en lugar de competir con ella.
        this.dom.canvas.classList.toggle('deciding', !!pendingIncident);
        this.renderer.draw(this.match, {
          dt,
          incident: pendingIncident,
          kit: KITS.find((x) => x.id === (this.currentKit || 'black')),
          flagUp: this._flagUp,
        });
        this.hud.update(this.match, this.engine);
        if (this.engine.pending) {
          const p = this.engine.pending;
          this.hud.updateDecisionTimer(p.timeLeft / this.match.difficulty.decisionTime);
        }
        this.audio.updateCrowd(this.match.atmosphere.noise,
          (this.match.atmosphere.anger[0] + this.match.atmosphere.anger[1]) / 2);
      }
    } else if (!this.match) {
      this._tickAmbient(dt);
    }
    requestAnimationFrame(this._loop);
  }

  // --------------------------------------------------------- arranque UI

  boot() {
    this.dom.canvas.classList.add('dim');
    this.screens.mainMenu();
    this.startAmbient();
  }

  /**
   * Partido de fondo: mientras el jugador está en los menús, el campo no se
   * queda vacío. Se juega solo, con árbitro automático, y cuando termina
   * empieza otro. No toca la carrera ni el guardado: es sólo ambiente.
   */
  startAmbient() {
    try {
      const world = this.classicWorld();
      const rng = new RNG(`ambient-${Date.now()}`);
      const div = world.divisions[0];
      const pool = clubsOfDivision(world, div.id);
      const home = rng.pick(pool);
      let away = rng.pick(pool);
      while (away.id === home.id) away = rng.pick(pool);
      const match = createMatch({
        home, away, competition: div, seed: rng.int(1, 1e9),
        weather: rng.pick(['clear', 'clear', 'rain', 'wind']),
        importance: 50,
        difficulty: DIFFICULTY.normal,
        referee: createReferee({ seed: 'ambient', baseLevel: 70 }),
        crew: generateCrew(rng, div.level, false),
        varEnabled: false,
        stadium: home.stadium,
        startMinute: rng.int(2, 70),
      });
      const engine = new MatchEngine(match, { autoReferee: makeAutoReferee({ skill: 78, rng: match.rng }) });
      engine.start();
      this.ambient = { match, engine };
    } catch {
      this.ambient = null;      // el ambiente nunca puede tumbar el menú
    }
  }

  _tickAmbient(dt) {
    const amb = this.ambient;
    if (!amb) return;
    // Sólo se juega cuando de verdad se ve: en el resto de pantallas el velo
    // es opaco y simularlo sería gastar batería para nada.
    if (!this.dom.screens.classList.contains('airy')) return;
    if (amb.engine.finished) { this.startAmbient(); return; }
    if (amb.match.phase === 'halftime') amb.engine.resumeFromHalfTime();
    amb.engine.update(dt);
    // La cámara sigue al balón sólo aquí: no se toca la preferencia del jugador
    const userFollow = this.renderer.follow;
    this.renderer.follow = true;
    this.renderer.draw(amb.match, { dt, incident: null, kit: KITS[0], flagUp: null });
    this.renderer.follow = userFollow;
  }

  quitToMenu() {
    this._teardownMatch();
    this.mode = 'menu';
    this.dom.canvas.classList.add('dim');
    this.hud.root.classList.add('hidden');
    this.audio.stopCrowd();
    this.screens.mainMenu();
  }

  classicWorld() {
    if (!this._world) this._world = generateWorld('classic-world');
    return this._world;
  }

  setLocale(id) {
    setLocale(id);
    this.settings.locale = id;
    saveSettings(this.settings);
    this.screens.settings();
  }

  setDifficulty(id) {
    this.settings.difficulty = id;
    saveSettings(this.settings);
    if (this.career) this.career.difficultyId = id;
    this.screens.settings();
  }

  toggleSetting(key) {
    this.settings[key] = !this.settings[key];
    saveSettings(this.settings);
    this.audio.setSettings(this.settings);
    this.screens.settings();
  }

  // ------------------------------------------------------------- carrera

  createRefereeFromForm() {
    const q = (id) => this.dom.screens.querySelector(id);
    const opts = {
      firstName: q('#f-first').value.trim() || t('ui.defaultFirst'),
      lastName: q('#f-last').value.trim() || t('ui.defaultLast'),
      age: Number(q('#f-age').value) || 24,
      gender: q('#f-gender').value,
      nationId: q('#f-nation').value,
      kit: q('#f-kit').value,
      skin: q('#f-skin').value,
      hair: q('#f-hair').value,
      seed: `${Date.now()}`,
    };
    const difficulty = q('#f-diff').value;
    const mode = q('#f-mode').value;
    this.settings.difficulty = difficulty;
    saveSettings(this.settings);

    const referee = createReferee(opts);
    this.career = new Career({
      mode, difficulty, referee,
      worldSeed: `w${Date.now()}`,
    });
    this.currentKit = opts.kit;
    this.pendingRef = null;
    this.autosave();
    this.screens.careerHub();
  }

  continueCareer() {
    const slot = lastSaveSlot();
    if (!slot) return this.screens.createReferee();
    this.loadSlot(slot);
  }

  loadSlot(slot) {
    const data = loadGame(slot);
    if (!data) return this.screens.saves();
    this.career = Career.deserialize(data);
    this.currentKit = this.career.referee.appearance.kit;
    this.saveSlotIdx = slot;
    this.hud.toast(t('ui.loaded'), 'good');
    this.screens.careerHub();
  }

  saveSlot(slot) {
    if (!this.career) return;
    saveGame(slot, this.career);
    this.saveSlotIdx = slot;
    this.hud.toast(t('ui.saved'), 'good');
    this.screens.saves();
  }

  deleteSlot(slot) { deleteSave(slot); this.screens.saves(); }

  autosave() {
    if (!this.settings.autosave || !this.career) return;
    saveGame(this.saveSlotIdx || 1, this.career);
    this.saveSlotIdx = this.saveSlotIdx || 1;
  }

  restRound() {
    if (!this.career) return;
    this.career.train('rest');
    this.career.advanceRound();
    this.autosave();
    this.screens.careerHub();
  }

  doTraining(id) {
    const res = this.career.train(id);
    let msg = '';
    if (res && res.blocked) msg = t('ui.tooTired');
    else if (res && res.rest) msg = t('ui.rested', { n: Math.round(res.fatigue) });
    else if (res) msg = t('training.doneGain', { stat: t(`stat.${res.stat}`), n: res.gain });
    this.autosave();
    this.screens.training(msg);
  }

  buyAsset(id) {
    const res = this.career.buy(id);
    if (!res.ok) {
      const msg = res.reason === 'money' ? t('econ.cantAfford', { n: res.missing.toLocaleString('es') }) : '';
      this.audio.ui('error');
      this.screens.economy(msg || undefined);
      return;
    }
    this.autosave();
    const gains = Object.entries(res.gains)
      .map(([k, v]) => `${t(`stat.${k}`)} +${v}`).join(' · ');
    this.screens.economy(`${t('econ.bought', { name: t(`econ.${id}`) })}${gains ? ` — ${gains}` : ''}`);
  }

  startExam(topic) {
    const ac = this.career ? this.career.academy : this.freeAcademy;
    this.activeAcademy = ac;
    const exam = ac.startExam(topic || null, 6);
    this.screens.examQuestion(exam, null);
  }

  answerExam(i) {
    const ac = this.activeAcademy;
    const res = ac.answer(i);
    if (!res) return;
    if (res.done) {
      const final = ac.finishExam();
      this.audio.ui(final.passed ? 'click' : 'error');
      if (this.career) this.autosave();
      this.screens.examResult(final);
    } else {
      this.screens.examQuestion(ac.current, res);
    }
  }

  publishPost(tone) {
    const p = this.career.press.publish('partido', tone);
    this.autosave();
    this.screens.pressScreen(`${t('ui.published')}: ${t('ui.reach')} ${p.reach}, ${p.followersGained >= 0 ? '+' : ''}${p.followersGained} ${t('ui.followersGained')}, ${t('stat.reputation')} ${p.repDelta}.`);
  }

  syndicateChoose(chapter, option) {
    const res = this.career.syndicate.choose(chapter, option);
    this.autosave();
    if (res && res.option.money) this.hud.toast(`+${res.option.money} €`, 'good');
    this.screens.careerHub();
  }

  resolveEthics(choice) {
    const res = this.career.resolveEthics(choice);
    this.autosave();
    const msgs = {
      accepted: t('ui.bribeAccepted'), refused: t('ui.bribeRefused'),
      reported: t('ui.bribeReported'), ignored: t('ui.bribeIgnored'),
    };
    this.hud.toast(msgs[res.type] || '', res.type === 'accepted' ? 'bad' : 'good', 4000);
    this._postMatchNext();
  }

  answerPress(qIndex, key) {
    const conf = this.career.pendingPressConference;
    const q = conf.questions[qIndex];
    this.career.press.answer(q, key, this.lastReport);
    conf.current = (conf.current || 0) + 1;
    if (conf.current >= conf.questions.length) {
      this.career.pendingPressConference = null;
      this.afterPressConference();
    } else {
      this.screens.pressConference(conf, this.lastReport);
    }
  }

  afterPressConference() {
    this.autosave();
    this._postMatchNext();
  }

  retire() {
    const end = this.career.retire();
    this.screens.ending(end, this.career);
    this.career = null;
  }

  // -------------------------------------------------------------- partido

  acceptAssignment(id) {
    const a = this.career.accept(id);
    if (!a) return;
    const cfg = this.career.matchConfigFor(a);
    this.pendingMatchCfg = cfg;
    this.match = createMatch(cfg);
    this.screens.preMatch({ ...cfg, lineups: this.match.lineups, weatherId: this.match.weatherId, crew: this.match.crew }, a);
  }

  startClassicFromForm() {
    const q = (id) => this.dom.screens.querySelector(id);
    const world = this.classicWorld();
    const divId = q('#c-div').value;
    const div = world.divisions.find((d) => d.id === divId) || world.divisions[0];
    const all = clubsOfDivision(world, divId);
    const home = all.find((c) => c.id === q('#c-home').value) || all[0];
    const away = all.find((c) => c.id === q('#c-away').value) || all[1];
    if (home.id === away.id) { this.hud.toast(t('ui.pickDifferent'), 'bad'); return; }
    const difficulty = DIFFICULTY[q('#c-diff').value] || DIFFICULTY.normal;
    const referee = this.career ? this.career.referee : createReferee({ seed: 'classic', baseLevel: 62 });
    const rng = new RNG(Date.now());
    const cfg = {
      home, away, competition: div, seed: Date.now(),
      weather: q('#c-weather').value,
      importance: Number(q('#c-imp').value) || 50,
      rivalry: (home.rivals.find((r) => r.id === away.id) || {}).intensity || 0,
      difficulty, referee,
      crew: generateCrew(rng, div.level, !!div.var),
      varEnabled: !!div.var,
      stadium: home.stadium,
    };
    this.mode = 'classic';
    this.pendingMatchCfg = cfg;
    this.match = createMatch(cfg);
    this.screens.preMatch({ ...cfg, lineups: this.match.lineups, weatherId: this.match.weatherId, crew: this.match.crew }, null);
  }

  startSpecial(id) {
    const sp = findSpecial(id);
    if (!sp) return;
    const world = this.classicWorld();
    const div = world.divisions.find((d) => d.id === sp.divisionId) || world.divisions[0];
    const pool = clubsOfDivision(world, sp.divisionId);
    const rng = new RNG(`${id}:${Date.now()}`);
    const home = rng.pick(pool);
    let away = rng.pick(pool);
    while (away.id === home.id) away = rng.pick(pool);
    if (sp.aggressionBoost) { home.aggression = Math.min(99, home.aggression * sp.aggressionBoost); away.aggression = Math.min(99, away.aggression * sp.aggressionBoost); }
    const referee = this.career ? this.career.referee : createReferee({ seed: `sp-${id}`, baseLevel: 66 });
    const difficulty = DIFFICULTY[this.settings.difficulty] || DIFFICULTY.normal;
    const cfg = {
      home, away, competition: div, seed: `${id}:${Date.now()}`,
      weather: sp.weather, importance: sp.importance, rivalry: sp.rivalry,
      difficulty: sp.diveBoost ? { ...difficulty, simulationRate: difficulty.simulationRate * sp.diveBoost } : difficulty,
      referee, crew: generateCrew(rng, div.level, !!div.var), varEnabled: !!div.var,
      knockout: !!sp.knockout, stadium: home.stadium, title: sp.name,
      kickoffScore: sp.score, startMinute: sp.startMinute, half: sp.half,
    };
    this.mode = 'special';
    this.special = sp;
    this.pendingMatchCfg = cfg;
    this.match = createMatch(cfg);
    if (sp.preCards) this._preloadCards(this.match, sp.preCards);
    this.screens.preMatch({ ...cfg, lineups: this.match.lineups, weatherId: this.match.weatherId, crew: this.match.crew }, null);
  }

  _preloadCards(match, n) {
    const pool = match.rng.shuffle(match.entities.filter((e) => e.role !== 'GK'));
    for (let i = 0; i < n && i < pool.length; i++) {
      pool[i].yellow = 1;
      match.stats[pool[i].side].yellows++;
      pool[i].frustration = 60;
    }
  }

  beginMatch() {
    this.screens.hide();
    this.hud.root.classList.remove('hidden');
    this.dom.canvas.classList.remove('dim');
    this.renderer.resize();
    this.mode = this.mode === 'menu' ? 'match' : this.mode;
    if (this.mode !== 'special' && this.mode !== 'classic') this.mode = 'match';
    this._runMatch();
  }

  _runMatch() {
    const engine = new MatchEngine(this.match, { speed: SPEEDS[this.speedIdx] });
    this.engine = engine;
    this.paused = false;
    this._wireEngine(engine);
    this.audio.ensure();
    this.audio.startCrowd();
    engine.start();
    this.audio.whistle('short');
    this.hud.renderIdleActions(engine);
    this.hud.toast(t('ui.matchStarts'), 'info');
    // El modo partido usa el bucle general; `mode` marca que hay simulación viva
    this._activeMode = this.mode;
    this.mode = 'match';
  }

  _wireEngine(engine) {
    const hud = this.hud;

    engine.on('decision:request', ({ incident, options }) => {
      this.audio.whistle(incident.type === 'goal' ? 'double' : 'short');
      hud.showDecision(incident, options, this.match, (opt) => {
        if (opt.payload.action === 'assistant') {
          engine.decide({ action: 'assistant' });
          return;
        }
        if (opt.payload.action === 'var') {
          engine.decide({ action: 'var', preDecision: this._lastIntent || { action: 'playon' } });
          return;
        }
        this._lastIntent = opt.payload;
        hud.hideDecision();
        engine.decide(opt.payload);
      });
    });

    engine.on('decision:cards', ({ incident, options }) => {
      hud.showCardChoice(incident, options, this.match, (opt) => {
        hud.hideDecision();
        engine.decide(opt.payload);
      });
    });

    engine.on('decision:timeout', () => {
      hud.hideDecision();
      hud.toast(t('ui.noDecision'), 'bad');
    });

    engine.on('decision:resolved', ({ incident, payload, grade }) => {
      hud.hideDecision();
      // Cada decisión sale del silbato del árbitro, y se ve salir
      if (payload.action !== 'play') this.renderer.whistle(this.match.ref.pos, 0.9);
      if (this.settings.showEvaluation && !this.match.difficulty.showTruthBefore) {
        hud.showEvaluation(incident, payload, grade);
      }
      hud.renderIdleActions(engine);
      if (payload.card === 'yellow') this.audio.card(false);
      if (payload.card === 'red') this.audio.card(true);
      if (this.tutorial) this._tutorialStep(incident, payload);
    });

    engine.on('assistant:answer', ({ answer }) => {
      hud.showAssistantAnswer(answer);
      this._flagUp = answer.kind === 'offside' && answer.value ? (answer.key === 'ar1' ? 0 : 1) : null;
      setTimeout(() => { this._flagUp = null; }, 2500);
    });

    // El VAR revisa en silencio y llama cuando ve un error claro: eso no es
    // lo mismo que pedirlo tú, y el jugador tiene que enterarse.
    engine.on('var:calls', () => {
      hud.toast(`📺 ${t('var.calls')}`, 'accent', 4000);
      this.audio.varBeep(true);
    });

    engine.on('var:open', ({ session }) => {
      this.audio.varBeep(true);
      hud.hideDecision();
      hud.showVar(session, engine.var, this.match, (payload) => {
        engine.var.close(payload);
        hud.hideVar();
        this.audio.varBeep(false);
      });
    });

    engine.on('goal', ({ side }) => {
      this.renderer.triggerFlash('#ffffff', 0.35);
      this.renderer.triggerShake(8);
      this.renderer.addFloater(`¡${t('act.goal')}!`, this.match.ball.pos.x, this.match.ball.pos.y, '#ffd60a', 2.6);
      this.renderer.burst(side);
      this.audio.cheer(1);
      hud.goalBurst(this.match.teams[side].name);
      hud.toast(`⚽ ${this.match.teams[side].name}`, 'good');
    });

    engine.on('card', ({ entity, card }) => {
      this.renderer.showCard(entity.pos, card);
      this.renderer.whistle(this.match.ref.pos, 1);
      hud.cardFlash(card);
    });

    engine.on('protest', ({ entity, intensity }) => {
      this.renderer.gesture(entity.id, 'protest', 2.4);
      const lines = ['protest.ref', 'protest.out', 'protest.noTouch', 'protest.red', 'protest.penalty',
        'protest.always', 'protest.dive', 'protest.handball', 'protest.homer'];
      const key = lines[Math.floor(Math.random() * lines.length)];
      this.renderer.addFloater(t(key), entity.pos.x, entity.pos.y, '#ff9f1c', 2.2);
    });

    engine.on('coachProtest', ({ side, coach }) => {
      hud.toast(`📣 ${coach.name}: “${t('protest.coach')}”`, 'warn', 3000);
    });

    engine.on('crowd', ({ anger }) => {
      if (anger > 55) this.audio.boo(Math.min(1, anger / 90));
    });

    engine.on('restart:taken', ({ type }) => {
      if (['freeKick', 'corner', 'goalKick', 'throwIn'].includes(type)) this.audio.kick(0.8);
    });

    engine.on('substitution', ({ side, out, in: inn }) => {
      hud.toast(`🔄 ${out.player.name} → ${inn.player.name}`, 'info');
    });

    engine.on('addedTime', ({ minutes }) => {
      hud.toast(`⏱ ${t('hud.added')}: +${Math.round(minutes)}`, 'info', 3500);
    });

    engine.on('advantage:start', () => {
      hud.toast(`▶ ${t('act.advantage')}`, 'accent');
      hud.renderIdleActions(engine);
    });

    engine.on('advantage:end', ({ materialized }) => {
      hud.toast(t(materialized ? 'ui.advantageUsed' : 'ui.backToFoul'), materialized ? 'good' : 'warn');
      hud.renderIdleActions(engine);
    });

    engine.on('match:stopped', () => hud.toast(`⏸ ${t('ui.playStopped')}`, 'warn'));
    engine.on('match:resumed', () => hud.toast(`▶ ${t('ui.playResumed')}`, 'info'));
    engine.on('match:abandoned', () => hud.toast(`⛔ ${t('ui.matchAbandoned')}`, 'bad', 5000));

    engine.on('halftime', ({ report }) => {
      this.audio.whistle('double');
      this.paused = true;
      this.screens.halfTime(report, this.match);
    });

    engine.on('match:end', ({ report }) => {
      this.audio.whistle('triple');
      this.audio.stopCrowd();
      this.lastReport = report;
      setTimeout(() => this._onMatchEnd(report), 900);
    });
  }

  resumeSecondHalf() {
    this.screens.hide();
    this.paused = false;
    this.engine.resumeFromHalfTime();
    this.hud.renderIdleActions(this.engine);
    this.audio.startCrowd();
    this.audio.whistle('short');
  }

  cancelAdvantage() {
    if (this.engine && this.engine.cancelAdvantage()) this.audio.whistle('short');
  }

  stopMatchRequest() {
    if (!this.engine) return;
    if (this.engine.manualStop(90)) this.audio.whistle('long');
  }

  askAssistantFree() {
    if (!this.engine) return;
    const a = this.engine.askAssistantAbout(null);
    if (a) { this.hud.showAssistantAnswer(a); return; }
    const f = this.engine.askFourthOfficial();
    this.hud.toast(`💬 ${f.name}: ${t('ui.addedEstimate')} +${Math.max(f.addedTime, f.pendingStoppage)}′`, 'assistant', 3200);
  }

  // ------------------------------------------------------- fin de partido

  _onMatchEnd(report) {
    this.hud.root.classList.add('hidden');
    this.dom.canvas.classList.add('dim');
    const mode = this._activeMode || 'match';

    // Instantánea mínima para poder revisar las jugadas cuando el partido
    // ya no existe: colores, estadio y clima, nada más.
    this.reviewMatch = this.match ? {
      teams: this.match.teams,
      kits: this.match.kits,
      stadium: this.match.stadium,
      weather: this.match.weather,
      atmosphere: { noise: 35 },
    } : null;
    this.reviewReport = report;

    if (mode === 'special' && this.special) {
      const passed = report.rating.overall >= this.special.targetRating && !report.abandoned;
      this.screens.scenarioResult(this.special, report, passed);
      this._teardownMatch();
      return;
    }
    if (mode === 'classic' || !this.career) {
      this.lastReportExtra = {
        buttons: `<button class="primary" data-act="classic">${t('ui.anotherMatch')}</button>
                  <button data-act="menu">${t('menu.quit')}</button>`,
      };
      this.screens.matchReport(report, this.lastReportExtra);
      this._teardownMatch();
      return;
    }
    if (this.tutorial) {
      this.tutorial = null;
      this.screens.matchReport(report, { buttons: `<button class="primary" data-act="menu">${t('tut.done')}</button>` });
      this._teardownMatch();
      return;
    }

    const res = this.career.finishMatch(report);
    this.lastResult = res;
    this.autosave();

    const gainsHtml = `
      <div class="card"><h4>${t('ui.progress')}</h4>
        <ul class="list small">
          <li>${t('report.xp')}: +${res.entry.xp} XP${res.entry.levels.length ? ` · ${t('ui.levelUp', { n: res.entry.levels[res.entry.levels.length - 1] })}` : ''}</li>
          <li>${t('report.fee')}: +${res.entry.fee} €</li>
          <li>${t('stat.reputation')}: ${res.entry.repDelta >= 0 ? '+' : ''}${res.entry.repDelta}</li>
          ${Object.entries(res.entry.gains).map(([k, v]) => `<li>${t(`stat.${k}`)} +${v}</li>`).join('')}
          ${res.movement ? `<li class="${res.movement.type === 'promotion' ? 'good' : 'bad'}">
            ${res.movement.type === 'promotion' ? t('career.promoted', { div: res.movement.name }) : t('career.relegated', { div: res.movement.name })}</li>` : ''}
          ${res.unlocked.map((u) => `<li class="good">🏅 ${t('ach.unlocked', { name: u.name })}</li>`).join('')}
          ${res.news.map((n) => `<li class="muted">📰 ${n.headline}</li>`).join('')}
        </ul></div>`;

    this.lastReportExtra = {
      gainsHtml,
      buttons: `<button class="primary big" data-act="postMatchNext">${t('ui.continue')}</button>`,
    };
    this.screens.matchReport(report, this.lastReportExtra);
    // El botón de continuar encadena rueda de prensa / ética / trama
    this._rewirePostMatchButton();
    this._teardownMatch();
  }

  _postMatchNext() {
    const c = this.career;
    if (!c) return this.screens.mainMenu();
    if (c.pendingPressConference) {
      c.pendingPressConference.current = c.pendingPressConference.current || 0;
      return this.screens.pressConference(c.pendingPressConference, this.lastReport);
    }
    if (c.pendingEthics) return this.screens.ethicsEvent(c.pendingEthics);
    if (c.syndicate.pending()) return this.screens.syndicateScene();
    c.advanceRound();
    if (c.ended) { const e = c.ended; this.screens.ending(e, c); this.career = null; return; }
    this.autosave();
    return this.screens.careerHub();
  }

  _teardownMatch() {
    this.dom.canvas.classList.remove('deciding');
    this.engine = null;
    this.match = null;
    this.paused = false;
    this._flagUp = null;
    this.audio.stopCrowd();
  }

  // -------------------------------------------------- revisión de jugadas

  openReview(clipId) {
    const report = this.reviewReport;
    if (!report || !report.clips) return;
    const clip = report.clips[clipId];
    if (!clip) return;
    const incident = (report.incidents || []).find((i) => i.id === clipId) || null;

    this.screens.matchReview(clip, incident);
    const canvas = this.dom.screens.querySelector('#review-canvas');
    if (!canvas) return;

    const renderer = new Renderer(canvas);
    const session = {
      frames: clip.frames, index: 0, playing: true, speed: 1,
      camera: 'side', zoom: 1, offsideLine: false, incident,
    };
    this.review = { renderer, session, clip, raf: null, last: performance.now() };

    const range = this.dom.screens.querySelector('#review-range');
    const btn = (name) => this.dom.screens.querySelector(`[data-rv="${name}"]`);
    const step = (n) => {
      session.index = clamp(session.index + n, 0, session.frames.length - 1);
      session.playing = false;
      if (playBtn) playBtn.textContent = '▶';
    };
    const playBtn = btn('play');

    btn('start').onclick = () => step(-session.frames.length);
    btn('back10').onclick = () => step(-10);
    btn('back1').onclick = () => step(-1);
    btn('fwd1').onclick = () => step(1);
    btn('fwd10').onclick = () => step(10);
    playBtn.onclick = () => {
      session.playing = !session.playing;
      if (session.playing && session.index >= session.frames.length - 1) session.index = 0;
      playBtn.textContent = session.playing ? '⏸' : '▶';
    };
    const speeds = [0.25, 0.5, 1, 2];
    let si = 2;
    btn('speed').onclick = () => {
      si = (si + 1) % speeds.length;
      session.speed = speeds[si];
      btn('speed').textContent = `${speeds[si]}×`;
    };
    const cams = ['main', 'side', 'behindGoal', 'tactical'];
    let ci = 1;
    btn('cam').onclick = () => {
      ci = (ci + 1) % cams.length;
      session.camera = cams[ci];
      btn('cam').textContent = t(`var.cam.${cams[ci]}`);
    };
    btn('line').onclick = () => {
      session.offsideLine = !session.offsideLine;
      btn('line').classList.toggle('on', session.offsideLine);
    };
    if (range) {
      range.oninput = () => { session.index = Number(range.value); session.playing = false; playBtn.textContent = '▶'; };
    }
    playBtn.textContent = '⏸';

    const loop = (now) => {
      if (!this.review) return;
      const dt = Math.min(0.05, (now - this.review.last) / 1000);
      this.review.last = now;
      if (session.playing) {
        session.acc = (session.acc || 0) + dt * 30 * session.speed;
        while (session.acc >= 1) {
          session.acc -= 1;
          session.index++;
          if (session.index >= session.frames.length - 1) {
            session.index = session.frames.length - 1;
            session.playing = false;
            playBtn.textContent = '▶';
            break;
          }
        }
        if (range) range.value = String(session.index);
      }
      renderer.drawReplay(session.frames[session.index], this.reviewMatch, session);
      this.review.raf = requestAnimationFrame(loop);
    };
    this.review.raf = requestAnimationFrame(loop);
  }

  closeReview() {
    if (this.review) {
      cancelAnimationFrame(this.review.raf);
      this.review = null;
    }
    this.screens.matchReport(this.reviewReport, this.lastReportExtra || {});
    this._rewirePostMatchButton();
  }

  _rewirePostMatchButton() {
    const btn = this.dom.screens.querySelector('[data-act="postMatchNext"]');
    if (btn) btn.onclick = () => { this.audio.ui('click'); this._postMatchNext(); };
  }

  // ------------------------------------------------------------ tutorial

  startTutorial() {
    const world = this.classicWorld();
    const div = world.divisions.find((d) => d.id === 'tercera');
    const pool = clubsOfDivision(world, 'tercera');
    const rng = new RNG('tutorial');
    const referee = createReferee({ seed: 'tutorial', baseLevel: 55 });
    const cfg = {
      home: pool[0], away: pool[1], competition: div, seed: 'tutorial',
      weather: 'clear', importance: 30, rivalry: 0,
      difficulty: { ...DIFFICULTY.easy, decisionTime: 20 },
      referee, crew: generateCrew(rng, div.level, true), varEnabled: true,
      stadium: pool[0].stadium,
    };
    this.mode = 'match';
    this.tutorial = { step: 0, seen: new Set() };
    this.pendingMatchCfg = cfg;
    this.match = createMatch(cfg);
    this.screens.preMatch({ ...cfg, lineups: this.match.lineups, weatherId: 'clear', crew: this.match.crew }, null);
    setTimeout(() => {
      this.hud.toast(t('tut.move'), 'info', 7000);
      setTimeout(() => this.hud.toast(t('tut.position'), 'info', 7000), 2000);
    }, 400);
  }

  _tutorialStep(incident, payload) {
    if (!this.tutorial) return;
    const seen = this.tutorial.seen;
    const lessons = {
      challenge: 'tut.foul', penaltyShout: 'tut.penalty',
      offside: 'tut.offside', goal: 'tut.var', handball: 'tut.card',
    };
    const key = lessons[incident.type];
    if (key && !seen.has(key)) {
      seen.add(key);
      this.hud.toast(t(key), 'info', 6000);
    }
    if (payload.action === 'advantage' && !seen.has('adv')) {
      seen.add('adv');
      this.hud.toast(t('tut.advantage'), 'info', 6000);
    }
  }
}

export default Game;
