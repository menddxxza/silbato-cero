// Pantallas fuera del partido. Cada botón hace algo real: no hay maquetas.

import { t, availableLocales, getLocale } from '../core/i18n.js';
import { GAME, DIFFICULTY, REF_STATS } from '../core/config.js';
import { DIVISIONS, divisionById, clubsOfDivision } from '../data/generators.js';
import { KITS, SKINS, HAIRS, overall, avgRating, XP_PER_LEVEL } from '../career/referee.js';
import { TRAINING, ASSETS } from '../career/career.js';
import { NATIONS } from '../data/names.js';
import { SCENARIOS, HISTORIC } from '../data/scenarios.js';
import { listSaves } from '../core/save.js';
import { clamp } from '../core/rng.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Screens {
  constructor(root, game) {
    this.root = root;
    this.game = game;
  }

  hide() { this.root.classList.add('hidden'); this.root.innerHTML = ''; }
  show() { this.root.classList.remove('hidden'); }

  render(html, opts = {}) {
    this.show();
    this.root.innerHTML = `<div class="screen ${opts.cls || ''}">${html}</div>`;
    // En el menú el velo se aclara para dejar ver el partido de fondo
    this.root.classList.toggle('airy', opts.cls === 'menu');
    this.root.scrollTop = 0;
    this.root.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        this.game.audio.ui('click');
        this.handle(b.dataset.act, b.dataset);
      });
    });
  }

  handle(act, data) {
    const g = this.game;
    const map = {
      newCareer: () => this.createReferee(),
      continue: () => g.continueCareer(),
      saves: () => this.saves(),
      classic: () => this.classicSetup(),
      historic: () => this.specials('historic'),
      scenarios: () => this.specials('scenario'),
      academy: () => this.academy(),
      training: () => this.training(),
      economy: () => this.economy(),
      stats: () => this.profile(),
      achievements: () => this.achievements(),
      settings: () => this.settings(),
      rulebook: () => this.rulebook(),
      tutorial: () => g.startTutorial(),
      menu: () => this.mainMenu(),
      hub: () => this.careerHub(),
      press: () => this.pressScreen(),
      blog: () => this.pressScreen(),
      inbox: () => this.careerHub(),
      syndicate: () => this.syndicateScene(),
      quitToMenu: () => g.quitToMenu(),
    };
    if (map[act]) return map[act]();
    if (act === 'accept') return g.acceptAssignment(data.id);
    if (act === 'rest') return g.restRound();
    if (act === 'startExam') return g.startExam(data.topic || null);
    if (act === 'answerExam') return g.answerExam(Number(data.i));
    if (act === 'finishExam') return this.academy();
    if (act === 'train') return g.doTraining(data.id);
    if (act === 'buy') return g.buyAsset(data.id);
    if (act === 'review') return g.openReview(data.id);
    if (act === 'closeReview') return g.closeReview();
    if (act === 'kickoff') return g.beginMatch();
    if (act === 'resumeHalf') return g.resumeSecondHalf();
    if (act === 'ethics') return g.resolveEthics(data.choice);
    if (act === 'pressAnswer') return g.answerPress(Number(data.q), data.key);
    if (act === 'publish') return g.publishPost(data.tone);
    if (act === 'syndicateChoose') return g.syndicateChoose(Number(data.chapter), data.option);
    if (act === 'loadSlot') return g.loadSlot(Number(data.slot));
    if (act === 'saveSlot') return g.saveSlot(Number(data.slot));
    if (act === 'deleteSlot') return g.deleteSlot(Number(data.slot));
    if (act === 'startSpecial') return g.startSpecial(data.id);
    if (act === 'startClassic') return g.startClassicFromForm();
    if (act === 'setLocale') return g.setLocale(data.id);
    if (act === 'setDifficulty') return g.setDifficulty(data.id);
    if (act === 'toggleSetting') return g.toggleSetting(data.key);
    if (act === 'setRange') return null;
    if (act === 'createRef') return g.createRefereeFromForm();
    if (act === 'randomRef') return this.createReferee(true);
    if (act === 'retire') return g.retire();
    return null;
  }

  // ------------------------------------------------------- menú principal

  mainMenu() {
    const has = listSaves().some((s) => !s.empty);
    this.render(`
      <div class="brand">
        <div class="logo">
          <svg viewBox="0 0 64 64" width="76" height="76" aria-hidden="true">
            <circle cx="32" cy="32" r="29" fill="#0f1620" stroke="#f2c14e" stroke-width="3"/>
            <path d="M20 40 L32 18 L44 40 Z" fill="none" stroke="#f2c14e" stroke-width="3" stroke-linejoin="round"/>
            <circle cx="32" cy="44" r="4" fill="#e63946"/>
          </svg>
        </div>
        <div>
          <h1>${GAME.name}</h1>
          <p class="tagline">${GAME.tagline} · v${GAME.version}</p>
        </div>
      </div>
      <div class="menu-grid">
        <button class="big ${has ? '' : 'disabled'}" data-act="${has ? 'continue' : 'newCareer'}">${t('menu.continue')}</button>
        <button class="big primary" data-act="newCareer">${t('menu.newCareer')}</button>
        <button data-act="classic">${t('menu.classic')}</button>
        <button data-act="historic">${t('menu.historic')}</button>
        <button data-act="scenarios">${t('menu.scenarios')}</button>
        <button data-act="academy">${t('menu.academy')}</button>
        <button data-act="tutorial">${t('menu.tutorial')}</button>
        <button data-act="achievements">${t('menu.achievements')}</button>
        <button data-act="rulebook">${t('menu.rulebook')}</button>
        <button data-act="saves">${t('menu.saves')}</button>
        <button data-act="settings">${t('menu.settings')}</button>
      </div>`, { cls: 'menu' });
  }

  // ------------------------------------------------------ crear árbitro

  createReferee(randomize = false) {
    const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const f = this.game.pendingRef || {};
    if (randomize || !this.game.pendingRef) {
      this.game.pendingRef = {
        firstName: rnd(['Adrián', 'Nerea', 'Bruno', 'Alba', 'Iván', 'Marta', 'Saúl', 'Vera']),
        lastName: rnd(['Alcaraz', 'Beltrán', 'Cordero', 'Rueda', 'Salcedo', 'Yáñez', 'Merino']),
        gender: 'm', age: 24, nationId: 'ibr', kit: 'black',
        skin: rnd(SKINS), hair: rnd(HAIRS), number: 1,
        mode: 'career', difficulty: this.game.settings.difficulty,
      };
    }
    const p = this.game.pendingRef;
    this.render(`
      <h2>${t('create.title')}</h2>
      <div class="form-grid">
        <label>${t('create.firstName')}<input id="f-first" value="${esc(p.firstName)}"></label>
        <label>${t('create.lastName')}<input id="f-last" value="${esc(p.lastName)}"></label>
        <label>${t('create.age')}<input id="f-age" type="number" min="18" max="40" value="${p.age}"></label>
        <label>${t('create.gender')}
          <select id="f-gender">
            <option value="m" ${p.gender === 'm' ? 'selected' : ''}>${t('create.gender.m')}</option>
            <option value="f" ${p.gender === 'f' ? 'selected' : ''}>${t('create.gender.f')}</option>
            <option value="x" ${p.gender === 'x' ? 'selected' : ''}>${t('create.gender.x')}</option>
          </select></label>
        <label>${t('create.nationality')}
          <select id="f-nation">${NATIONS.map((n) => `<option value="${n.id}" ${p.nationId === n.id ? 'selected' : ''}>${n.name}</option>`).join('')}</select></label>
        <label>${t('create.kit')}
          <select id="f-kit">${KITS.map((k) => `<option value="${k.id}" ${p.kit === k.id ? 'selected' : ''}>${esc(t(`kit.${k.id}`))}</option>`).join('')}</select></label>
        <label>${t('create.skin')}
          <select id="f-skin">${SKINS.map((s, i) => `<option value="${s}" ${p.skin === s ? 'selected' : ''}>Tono ${i + 1}</option>`).join('')}</select></label>
        <label>${t('create.hair')}
          <select id="f-hair">${HAIRS.map((s, i) => `<option value="${s}" ${p.hair === s ? 'selected' : ''}>Color ${i + 1}</option>`).join('')}</select></label>
        <label>${t('settings.difficulty')}
          <select id="f-diff">${Object.values(DIFFICULTY).map((d) => `<option value="${d.id}" ${p.difficulty === d.id ? 'selected' : ''}>${t(d.label)}</option>`).join('')}</select></label>
        <label>${t('ui.mode')}
          <select id="f-mode">
            <option value="career" ${p.mode === 'career' ? 'selected' : ''}>${t('ui.officialCareer')}</option>
            <option value="syndicate" ${p.mode === 'syndicate' ? 'selected' : ''}>${t('syndicate.title')}</option>
          </select></label>
      </div>
      <div class="row-btns">
        <button data-act="randomRef">${t('create.random')}</button>
        <button class="primary" data-act="createRef">${t('create.start')}</button>
        <button data-act="menu">${t('ui.back')}</button>
      </div>`);
  }

  // -------------------------------------------------------- hub carrera

  careerHub() {
    const c = this.game.career;
    if (!c) return this.mainMenu();
    const ref = c.referee;
    const div = c.division;
    const avg = avgRating(ref);
    const sy = c.syndicate.pending();
    const nextXp = XP_PER_LEVEL(ref.level);

    const assignments = c.assignments.map((a) => `
      <div class="card assignment">
        <div class="a-head">
          <span class="a-comp">${esc(a.competitionName)}</span>
          <span class="pill p-${a.pressure}">${t('career.pressure')}: ${t(`career.pressure.${a.pressure}`)}</span>
        </div>
        <div class="a-teams">${esc(a.homeName)} <span class="vs">vs</span> ${esc(a.awayName)}</div>
        <div class="a-meta">
          <span>🏟 ${esc(a.stadium.name)}</span>
          <span>🌤 ${a.weather}</span>
          ${a.derby ? '<span class="tag hot">DERBI</span>' : ''}
          ${a.isFinal ? '<span class="tag gold">FINAL</span>' : ''}
          ${a.knockout ? '<span class="tag">Eliminatoria</span>' : ''}
        </div>
        <div class="a-meta"><span>${t('career.difficulty')}: ${t(`career.pressure.${a.difficultyLabel}`)}</span>
          <span>💶 ${a.fee} €</span><span>✦ ${a.xp} XP</span></div>
        <button class="primary" data-act="accept" data-id="${a.id}">${t('career.accept')}</button>
      </div>`).join('');

    const news = c.press.articles.slice(0, 4).map((n) =>
      `<li class="news ${n.tone}">${esc(n.headline)}</li>`).join('') || `<li class="muted">—</li>`;

    const inbox = c.inbox.slice(-4).reverse().map((i) => {
      if (i.type === 'promotion') return `<li class="good">⬆ ${t('career.promoted', { div: divisionById(i.divisionId).name })}</li>`;
      if (i.type === 'relegation') return `<li class="bad">⬇ ${t('career.relegated', { div: divisionById(i.divisionId).name })}</li>`;
      if (i.type === 'federationWarning') return `<li class="bad">✉ La federación te recuerda que debes medir tus declaraciones.</li>`;
      if (i.type === 'debt') return `<li class="bad">✉ ${t('inbox.debt')}</li>`;
      if (i.type === 'seasonEnd') return `<li>✓ Fin de la temporada ${i.season}. Nota media: ${i.avg ?? '—'}</li>`;
      return `<li>${esc(JSON.stringify(i))}</li>`;
    }).join('') || `<li class="muted">—</li>`;

    this.render(`
      <div class="hub-head">
        <div>
          <h2>${esc(ref.firstName)} ${esc(ref.lastName)}</h2>
          <p class="muted">${esc(div.name)} · ${t('career.season')} ${c.season} · ${t('career.round')} ${c.round}
            · ${t('stat.level')} ${ref.level} (${Math.round(ref.experience)}/${nextXp} XP)</p>
        </div>
        <div class="hub-kpis">
          <div class="kpi"><span>${t('career.matches')}</span><b>${ref.record.matches}</b></div>
          <div class="kpi"><span>${t('career.avgRating')}</span><b>${avg ?? '—'}</b></div>
          <div class="kpi"><span>${t('stat.reputation')}</span><b>${Math.round(ref.reputation)}</b></div>
          <div class="kpi"><span>${t('career.money')}</span><b>${ref.money} €</b></div>
          <div class="kpi"><span>${t('training.fatigue')}</span><b>${Math.round(c.fatigue)}%</b></div>
        </div>
      </div>

      ${sy ? `<div class="card story"><b>${t('syndicate.title')} — ${t('syndicate.chapter', { n: sy.id })}</b>
        <p>${t('ui.pendingOffPitch')}</p>
        <button class="accent" data-act="syndicate">${t('ui.view')}</button></div>` : ''}

      <h3>${t('career.assignments')}</h3>
      <div class="assignments">${assignments}</div>
      <div class="row-btns">
        <button data-act="rest">${t('career.rest')}</button>
        <button data-act="training">${t('training.title')}</button>
        <button data-act="academy">${t('academy.title')}</button>
        <button data-act="economy">${t('econ.title')}</button>
        <button data-act="press">${t('press.title')}</button>
        <button data-act="stats">${t('menu.stats')}</button>
        <button data-act="achievements">${t('menu.achievements')}</button>
        <button data-act="saves">${t('ui.save')}</button>
        <button data-act="quitToMenu">${t('menu.quit')}</button>
      </div>

      <div class="two-col">
        <div class="card"><h4>${t('press.title')}</h4><ul class="list">${news}</ul></div>
        <div class="card"><h4>${t('career.inbox')}</h4><ul class="list">${inbox}</ul></div>
      </div>`, { cls: 'hub' });
  }

  // ------------------------------------------------------------- previa

  preMatch(cfg, assignment) {
    const lineup = (side) => cfg.lineups[side].lineup.map(({ player }) =>
      `<li><b>${player.number}</b> ${esc(player.shortName)} <span class="muted">${player.role}</span></li>`).join('');
    const crew = cfg.crew;
    this.render(`
      <h2>${esc(cfg.home.name)} <span class="vs">vs</span> ${esc(cfg.away.name)}</h2>
      <p class="muted">${esc(cfg.competition.name)} · 🏟 ${esc(cfg.stadium.name)} (${cfg.stadium.capacity.toLocaleString('es')})
        · 🌤 ${t(`weather.${cfg.weatherId}`)} · ${t('career.pressure')}: ${t(`career.pressure.${assignment ? assignment.pressure : 'medium'}`)}</p>
      <div class="two-col">
        <div class="card"><h4 style="color:${cfg.home.colors.primary}">${esc(cfg.home.name)}</h4>
          <p class="muted">${cfg.home.formation} · ${t(`style.${cfg.home.style}`)} · ${t('ui.aggression')} ${cfg.home.aggression}
            · ${t('ui.coach')}: ${esc(cfg.home.coach.name)} (${t(`trait.${cfg.home.coach.trait}`)})</p>
          <ol class="list small">${lineup(0)}</ol></div>
        <div class="card"><h4 style="color:${cfg.away.colors.primary}">${esc(cfg.away.name)}</h4>
          <p class="muted">${cfg.away.formation} · ${t(`style.${cfg.away.style}`)} · ${t('ui.aggression')} ${cfg.away.aggression}
            · ${t('ui.coach')}: ${esc(cfg.away.coach.name)} (${t(`trait.${cfg.away.coach.trait}`)})</p>
          <ol class="list small">${lineup(1)}</ol></div>
      </div>
      <div class="card"><h4>${t('ui.crew')}</h4>
        <ul class="list small">
          <li>${t('assistant.ar1')}: ${esc(crew.ar1.name)} (${t('ui.accuracy')} ${crew.ar1.accuracy})</li>
          <li>${t('assistant.ar2')}: ${esc(crew.ar2.name)} (${t('ui.accuracy')} ${crew.ar2.accuracy})</li>
          <li>${t('assistant.fourth')}: ${esc(crew.fourth.name)}</li>
          ${crew.var ? `<li>VAR: ${esc(crew.var.name)} (${t('ui.criterion')} ${crew.var.criterion}) · AVAR: ${esc(crew.avar.name)}</li>`
        : `<li class="muted">${t('ui.noVar')}</li>`}
        </ul></div>
      <div class="card help">
        ${t('ui.controls')}
      </div>
      <div class="row-btns">
        <button class="primary big" data-act="kickoff">${t('ui.kickoff')}</button>
        <button data-act="hub">${t('ui.back')}</button>
      </div>`);
  }

  // -------------------------------------------------------- descanso

  halfTime(report, match) {
    const s = report.stats;
    const controversies = report.controversies.map((d) =>
      `<li>${d.minute}' — ${d.type} · <span class="g-${d.grade}">${t(`eval.${d.grade === 'mostly' ? 'mostly' : d.grade}`)}</span></li>`).join('')
      || `<li class="muted">${t('ui.nothing')}</li>`;
    const notes = report.notes.map((n) => `<li>${esc(n.name)}: ${n.calls} intervenciones, ${n.accuracy}% de acierto</li>`).join('')
      || `<li class="muted">${t('ui.noCalls')}</li>`;
    this.render(`
      <h2>${t('half.title')}</h2>
      <div class="scoreline">${esc(match.teams[0].name)} <b>${report.score[0]} - ${report.score[1]}</b> ${esc(match.teams[1].name)}</div>
      <div class="two-col">
        <div class="card"><h4>${t('report.decisions')}</h4>
          <p class="big-num">${report.rating.toFixed(2)}</p>
          <p class="muted">${t('hud.rating')}</p>
          <ul class="list small">
            <li>${t('report.possession')}: ${report.possession[0]}% – ${report.possession[1]}%</li>
            <li>${t('report.shots')}: ${s[0].shots} – ${s[1].shots}</li>
            <li>${t('report.fouls')}: ${s[0].fouls} – ${s[1].fouls}</li>
            <li>${t('report.yellows')}: ${s[0].yellows} – ${s[1].yellows}</li>
            <li>${t('report.reds')}: ${s[0].reds} – ${s[1].reds}</li>
          </ul></div>
        <div class="card"><h4>${t('half.controversies')}</h4><ul class="list small">${controversies}</ul>
          <h4>${t('half.notes')}</h4><ul class="list small">${notes}</ul></div>
      </div>
      <div class="row-btns"><button class="primary big" data-act="resumeHalf">${t('ui.continue')}</button></div>`);
  }

  // ------------------------------------------------- informe final

  matchReport(report, extra = {}) {
    const s = report.stats;
    const b = report.rating.breakdown;
    const bars = Object.entries(b).map(([k, v]) =>
      `<div class="bar-row"><span>${t(`stat.${k}`) !== `stat.${k}` ? t(`stat.${k}`) : k}</span>
        <div class="bar"><i style="width:${v * 10}%"></i></div><b>${v}</b></div>`).join('');
    const timeline = report.events.filter((e) => ['goal', 'yellow', 'red', 'secondYellow', 'penaltyScored', 'penaltyMissed', 'substitution', 'abandoned'].includes(e.kind))
      .map((e) => `<li><b>${e.minute}'</b> ${this.eventLabel(e)}</li>`).join('') || '<li class="muted">—</li>';
    const decisions = report.decisions.map((d) =>
      `<li><b>${d.minute}'</b> ${t(`dec.${d.type}`)} → ${this.actionLabel(d.decision)}
        <span class="g-${d.grade}">${t(`eval.${d.grade}`)}</span>
        <span class="muted">${t('eval.confidence')} ${Math.round((d.confidence || 0) * 100)}%</span></li>`).join('')
      || '<li class="muted">—</li>';
    const sup = report.supervisor.map((k) => `<li>“${t(k)}”</li>`).join('') || '<li class="muted">—</li>';

    this.render(`
      <h2>${t('report.title')}</h2>
      <div class="scoreline">${esc(report.teams[0])} <b>${report.score[0]} - ${report.score[1]}</b> ${esc(report.teams[1])}
        ${report.shootout ? `<span class="muted">(pen. ${report.shootout.score[0]}-${report.shootout.score[1]})</span>` : ''}</div>
      ${report.abandoned ? '<div class="banner bad">PARTIDO SUSPENDIDO</div>' : ''}

      <div class="final-rating">
        <div class="fr-value ${report.rating.overall >= 8 ? 'good' : report.rating.overall >= 6.5 ? 'ok' : 'bad'}">${report.rating.overall}</div>
        <div class="fr-label">${t('report.finalRating')}</div>
      </div>

      <div class="two-col">
        <div class="card"><h4>${t('report.breakdown')}</h4>${bars}</div>
        <div class="card"><h4>${t('ui.total')}</h4>
          <ul class="list small">
            <li>${t('report.possession')}: ${report.possession[0]}% – ${report.possession[1]}%</li>
            <li>${t('report.shots')}: ${s[0].shots} – ${s[1].shots} (${t('report.shotsOn')} ${s[0].shotsOn} – ${s[1].shotsOn})</li>
            <li>${t('report.fouls')}: ${s[0].fouls} – ${s[1].fouls}</li>
            <li>${t('report.yellows')}: ${s[0].yellows} – ${s[1].yellows} · ${t('report.reds')}: ${s[0].reds} – ${s[1].reds}</li>
            <li>${t('report.corners')}: ${s[0].corners} – ${s[1].corners} · ${t('report.offsides')}: ${s[0].offsides} – ${s[1].offsides}</li>
            <li>${t('report.penalties')}: ${s[0].penalties} – ${s[1].penalties}</li>
            <li>${t('report.decisions')}: ${report.counts.total}
              (<span class="g-correct">${report.counts.correct}</span> /
               <span class="g-mostly">${report.counts.mostly}</span> /
               <span class="g-debatable">${report.counts.debatable}</span> /
               <span class="g-incorrect">${report.counts.incorrect}</span>)</li>
            <li>${t('report.varReviews')}: ${report.rating.varCalls.used}</li>
          </ul>
          <h4>${t('report.assistants')}</h4>
          <ul class="list small">
            <li>${esc(report.crew.ar1.name)}: ${report.crew.ar1.rating} (${report.crew.ar1.accuracy ?? '—'}%)</li>
            <li>${esc(report.crew.ar2.name)}: ${report.crew.ar2.rating} (${report.crew.ar2.accuracy ?? '—'}%)</li>
            <li>${t('report.varTeam')}: ${report.crew.var.rating ? `${esc(report.crew.var.name)} — ${report.crew.var.rating} (${report.crew.var.reviews} revisiones)` : t('ui.noVar')}</li>
          </ul></div>
      </div>

      <div class="two-col">
        <div class="card"><h4>${t('report.timeline')}</h4><ul class="list small scroll">${timeline}</ul></div>
        <div class="card"><h4>${t('report.decisions')}</h4><ul class="list small scroll">${decisions}</ul></div>
      </div>

      <div class="card"><h4>${t('report.supervisor')}</h4><ul class="list">${sup}</ul></div>

      <div class="card"><h4>${t('review.title')}</h4>${this.clipList(report)}</div>

      ${extra.gainsHtml || ''}
      <div class="row-btns">${extra.buttons || `<button class="primary big" data-act="menu">${t('ui.continue')}</button>`}</div>`);
  }

  /** Traduce una decisión registrada a lenguaje de árbitro. */
  actionLabel(decision) {
    const map = {
      foul: 'act.freeKick', penalty: 'act.penalty', handball: 'act.handball',
      offside: 'act.offside', goal: 'act.goal', noGoal: 'act.noGoal',
      dive: 'act.dive', advantage: 'act.advantage', playon: 'act.playonShort',
      restart: 'act.restartShort', stop: 'act.stopShort', medics: 'act.medicsShort',
      protocol: 'act.protocolShort', abandon: 'act.abandon', card: 'card.reason',
      warning: 'act.warningShort',
    };
    const base = t(map[decision.action] || decision.action);
    const card = decision.card ? ` + ${t(`card.${decision.card}`)}` : decision.warning ? ` + ${t('act.warningShort')}` : '';
    return `${base}${card}`;
  }

  /** Botones de repetición de las jugadas guardadas. */
  clipList(report) {
    const clips = Object.values(report.clips || {});
    if (!clips.length) return `<p class="muted small">${t('review.none')}</p>`;
    const byId = new Map((report.incidents || []).map((i) => [i.id, i]));
    return `<div class="chips">${clips
      .sort((a, b) => a.minute - b.minute)
      .map((c) => {
        const inc = byId.get(c.id);
        const grade = inc && inc.grade ? ` <span class="g-${inc.grade}">●</span>` : '';
        return `<button class="chip-btn" data-act="review" data-id="${c.id}">
          ▶ ${c.minute}' ${t(`dec.${c.type}`) !== `dec.${c.type}` ? t(`dec.${c.type}`) : c.type}${grade}
        </button>`;
      }).join('')}</div>`;
  }

  /** Reproductor de una jugada guardada. */
  matchReview(clip, incident) {
    const label = t(`dec.${clip.type}`) !== `dec.${clip.type}` ? t(`dec.${clip.type}`) : clip.type;
    const decision = incident && incident.decision ? this.actionLabel(incident.decision) : null;
    this.render(`
      <div class="review-head">
        <h2>${clip.minute}' · ${esc(label)}</h2>
        ${incident && incident.grade
    ? `<span class="pill g-${incident.grade}">${t(`eval.${incident.grade}`)}</span>` : ''}
      </div>
      ${decision ? `<p class="muted">${t('eval.decisionTaken')}: ${esc(decision)}</p>` : ''}
      <div class="review-stage"><canvas id="review-canvas"></canvas></div>
      <div class="review-transport">
        <button class="chip-btn" data-rv="start">⏮</button>
        <button class="chip-btn" data-rv="back10">◀◀</button>
        <button class="chip-btn" data-rv="back1">◀|</button>
        <button class="chip-btn" data-rv="play">▶</button>
        <button class="chip-btn" data-rv="fwd1">|▶</button>
        <button class="chip-btn" data-rv="fwd10">▶▶</button>
        <button class="chip-btn" data-rv="speed">1×</button>
        <button class="chip-btn" data-rv="cam">${t('var.cam.main')}</button>
        <button class="chip-btn" data-rv="line">${t('var.offsideLine')}</button>
      </div>
      <div class="review-scrub"><input type="range" id="review-range" min="0" max="${clip.frames.length - 1}" value="0"></div>
      <div class="row-btns"><button data-act="closeReview">${t('review.back')}</button></div>`);
  }

  eventLabel(e) {
    switch (e.kind) {
      case 'goal': return `⚽ Gol — ${esc(e.player || '')}`;
      case 'yellow': return `🟨 ${esc(e.player)}`;
      case 'red': return `🟥 ${esc(e.player)}`;
      case 'secondYellow': return `🟨🟥 ${esc(e.player)}`;
      case 'penaltyScored': return `⚽ Penalti transformado — ${esc(e.player)}`;
      case 'penaltyMissed': return `✖ Penalti fallado — ${esc(e.player)}`;
      case 'substitution': return `🔄 ${esc(e.out)} → ${esc(e.in)}`;
      case 'abandoned': return `⛔ Partido suspendido`;
      default: return e.kind;
    }
  }

  // ------------------------------------------------------ rueda de prensa

  pressConference(conf, report) {
    const q = conf.questions[conf.current || 0];
    if (!q) return this.game.afterPressConference();
    this.render(`
      <h2>${t('press.conference')}</h2>
      <div class="card interview">
        <p class="journalist">🎙 “${t(q.key)}”</p>
        <div class="answers">
          ${q.answers.map((a) => `<button data-act="pressAnswer" data-q="${conf.current || 0}" data-key="${a.key}">${t(a.key)}</button>`).join('')}
        </div>
      </div>`);
  }

  // -------------------------------------------------------------- ética

  ethicsEvent(ev) {
    this.render(`
      <h2>${t('ethics.offerTitle')}</h2>
      <div class="card story"><p>${esc(ev.textKey ? t(ev.textKey, ev.textArgs || {}) : (ev.text || ''))}</p></div>
      <div class="row-btns">
        <button class="danger" data-act="ethics" data-choice="accept">${t('ethics.accept')}</button>
        <button class="primary" data-act="ethics" data-choice="refuse">${t('ethics.refuse')}</button>
        <button class="accent" data-act="ethics" data-choice="report">${t('ethics.report')}</button>
        <button data-act="ethics" data-choice="ignore">${t('ethics.ignore')}</button>
      </div>`);
  }

  syndicateScene() {
    const c = this.game.career;
    const ch = c.syndicate.pending();
    if (!ch) return this.careerHub();
    this.render(`
      <h2>${t('syndicate.title')} — ${t('syndicate.chapter', { n: ch.id })}</h2>
      <div class="card story"><p>${esc(t(`syn.${ch.id}.text`))}</p></div>
      <div class="row-btns">
        ${ch.options.map((o) => `<button data-act="syndicateChoose" data-chapter="${ch.id}" data-option="${o.id}">${esc(t(`syn.${ch.id}.${o.id}`))}</button>`).join('')}
      </div>
      <p class="muted">${t('syndicate.suspicion')}: ${Math.round(c.referee.suspicion)}% · ${t('syndicate.corruption')}: ${Math.round(c.referee.corruption)}%</p>`);
  }

  // ----------------------------------------------------------- academia

  academy() {
    const c = this.game.career;
    const ac = c ? c.academy : this.game.freeAcademy;
    const results = ac.results.slice(0, 6).map((r) =>
      `<li>${r.topic || 'General'} — ${Math.round(r.score * 100)}% <span class="${r.passed ? 'good' : 'bad'}">${r.passed ? t('academy.passed') : t('academy.failed')}</span></li>`).join('')
      || '<li class="muted">—</li>';
    this.render(`
      <h2>${t('academy.title')}</h2>
      <p class="muted">${t('ui.qualification')}: ${ac.examLevel}${c ? ` · ${t('ui.requiredToRise')}: ${ac.requiredFor(c.divisionId)}` : ''}</p>
      <div class="card">
        <h4>${t('academy.exam')}</h4>
        <div class="chips">
          <button class="chip-btn" data-act="startExam">${t('ui.general')}</button>
          ${ac.topics().map((tp) => `<button class="chip-btn" data-act="startExam" data-topic="${tp}">${t(`rulebook.${tp}`) !== `rulebook.${tp}` ? t(`rulebook.${tp}`) : tp}</button>`).join('')}
        </div>
      </div>
      <div class="card"><h4>${t('ui.history')}</h4><ul class="list small">${results}</ul></div>
      <div class="row-btns"><button data-act="${c ? 'hub' : 'menu'}">${t('ui.back')}</button></div>`);
  }

  examQuestion(exam, feedback) {
    const q = exam.questions[exam.index];
    if (!q) return null;
    this.render(`
      <h2>${t('academy.exam')} <span class="muted">${exam.index + 1}/${exam.questions.length}</span></h2>
      <div class="card">
        <p class="question">${esc(q.q)}</p>
        <div class="answers">
          ${q.options.map((o, i) => `<button data-act="answerExam" data-i="${i}">${esc(o)}</button>`).join('')}
        </div>
      </div>
      ${feedback ? `<div class="card ${feedback.ok ? 'good-box' : 'bad-box'}">
        <b>${feedback.ok ? '✔ Correcto' : '✖ Incorrecto'}</b><p>${esc(feedback.why)}</p></div>` : ''}`);
  }

  examResult(res) {
    this.render(`
      <h2>${res.passed ? t('academy.passed') : t('academy.failed')}</h2>
      <div class="final-rating"><div class="fr-value ${res.passed ? 'good' : 'bad'}">${Math.round(res.score * 100)}%</div>
        <div class="fr-label">${t('academy.score')} — ${res.right}/${res.total}</div></div>
      ${Object.keys(res.gains).length ? `<div class="card"><h4>${t('ui.gains')}</h4>
        <ul class="list small">${Object.entries(res.gains).map(([k, v]) => `<li>${t(`stat.${k}`)} +${v}</li>`).join('')}</ul></div>` : ''}
      <p class="muted">${t('ui.qualification')}: ${res.examLevel}</p>
      <div class="row-btns"><button class="primary" data-act="academy">${t('ui.continue')}</button></div>`);
  }

  // ------------------------------------------------------- entrenamiento

  training(msg) {
    const c = this.game.career;
    if (!c) return this.mainMenu();
    this.render(`
      <h2>${t('training.title')}</h2>
      <p class="muted">${t('training.fatigue')}: ${Math.round(c.fatigue)}% · ${t('stat.fitness')}: ${Math.round(c.referee.stats.fitness)}</p>
      ${msg ? `<div class="banner good">${msg}</div>` : ''}
      <div class="menu-grid">
        ${TRAINING.map((s) => `<button data-act="train" data-id="${s.id}">
          ${t(`training.${s.id}`)}<br><span class="muted small">${s.stat ? `+${t(`stat.${s.stat}`)}` : 'Recupera'} · ${s.fatigue > 0 ? `+${s.fatigue}% fatiga` : `${s.fatigue}% fatiga`}</span>
        </button>`).join('')}
      </div>
      <div class="row-btns"><button data-act="hub">${t('ui.back')}</button></div>`);
  }

  // ------------------------------------------------------------ economía

  economy(msg) {
    const c = this.game.career;
    if (!c) return this.mainMenu();
    const money = Math.round(c.referee.money);

    const cards = ASSETS.map((a) => {
      const owned = c.owns(a.id);
      const afford = money >= a.cost;
      return `<div class="card asset ${owned ? 'owned' : ''}">
        <h4>${t(`econ.${a.id}`)}</h4>
        <p class="muted small">${t(`econ.${a.id}.desc`)}</p>
        <p class="small">${a.cost.toLocaleString('es')} €${a.upkeep ? ` · ${a.upkeep} €/jornada de ${t('econ.upkeep')}` : ''}</p>
        ${owned
    ? `<span class="tag gold">${t('econ.owned')}</span>`
    : `<button class="${afford ? 'primary' : 'disabled'}" ${afford ? `data-act="buy" data-id="${a.id}"` : ''}>${t('econ.buy')}</button>`}
      </div>`;
    }).join('');

    const conceptLabel = (concept) => {
      if (concept.startsWith('buy:')) return `${t('ledger.buy')}: ${t(`econ.${concept.slice(4)}`)}`;
      return t(`ledger.${concept}`) !== `ledger.${concept}` ? t(`ledger.${concept}`) : concept;
    };
    const ledger = c.ledger.slice(0, 10).map((l) =>
      `<li><span class="${l.amount >= 0 ? 'good' : 'bad'}">${l.amount >= 0 ? '+' : ''}${l.amount.toLocaleString('es')} €</span>
        · ${conceptLabel(l.concept)} <span class="muted">T${l.season} J${l.round}</span></li>`).join('')
      || `<li class="muted">—</li>`;

    this.render(`
      <h2>${t('econ.title')}</h2>
      <div class="hub-kpis">
        <div class="kpi"><span>${t('econ.balance')}</span><b class="${money < 0 ? 'bad' : ''}">${money.toLocaleString('es')} €</b></div>
        <div class="kpi"><span>${t('econ.perRound')}</span><b>${c.livingCost().toLocaleString('es')} €</b></div>
        <div class="kpi"><span>${t('training.fatigue')}</span><b>${Math.round(c.fatigue)}%</b></div>
      </div>
      ${money < 0 ? `<div class="banner bad">${t('econ.inDebt')}</div>` : ''}
      ${msg ? `<div class="banner good">${msg}</div>` : ''}
      <h3>${t('econ.investments')}</h3>
      <div class="assignments">${cards}</div>
      <div class="card"><h4>${t('econ.ledger')}</h4><ul class="list small scroll">${ledger}</ul></div>
      <div class="row-btns"><button data-act="hub">${t('ui.back')}</button></div>`);
  }

  // -------------------------------------------------------------- prensa

  pressScreen(msg) {
    const c = this.game.career;
    if (!c) return this.mainMenu();
    const arts = c.press.articles.slice(0, 12).map((a) =>
      `<li class="news ${a.tone}">${esc(a.headline)} <span class="muted">T${a.season} J${a.round}</span></li>`).join('') || '<li class="muted">—</li>';
    const posts = c.press.posts.slice(0, 8).map((p) =>
      `<li>${p.topic} · ${p.tone} — ${t('ui.reach')} ${p.reach}, ${p.followersGained >= 0 ? '+' : ''}${p.followersGained} ${t('ui.followersGained')}, ${t('stat.reputation')} ${p.repDelta}</li>`).join('') || '<li class="muted">—</li>';
    this.render(`
      <h2>${t('press.title')}</h2>
      ${msg ? `<div class="banner good">${msg}</div>` : ''}
      <div class="two-col">
        <div class="card"><h4>${t('ui.headlines')}</h4><ul class="list small scroll">${arts}</ul></div>
        <div class="card"><h4>${t('press.blog')} · ${t('press.followers')}: ${c.referee.followers.toLocaleString('es')}</h4>
          <div class="chips">
            <button class="chip-btn" data-act="publish" data-tone="analysis">Análisis técnico</button>
            <button class="chip-btn" data-act="publish" data-tone="humble">Reflexión personal</button>
            <button class="chip-btn" data-act="publish" data-tone="polemic">Opinión polémica</button>
          </div>
          <ul class="list small scroll">${posts}</ul></div>
      </div>
      <div class="row-btns"><button data-act="hub">${t('ui.back')}</button></div>`);
  }

  // -------------------------------------------------------------- perfil

  profile() {
    const c = this.game.career;
    if (!c) return this.mainMenu();
    const ref = c.referee;
    const r = ref.record;
    const stats = REF_STATS.map((k) =>
      `<div class="bar-row"><span>${t(`stat.${k}`)}</span><div class="bar"><i style="width:${ref.stats[k]}%"></i></div><b>${Math.round(ref.stats[k])}</b></div>`).join('');
    const hist = c.history.slice(-10).reverse().map((h) =>
      `<li><b>${h.report.rating}</b> — ${esc(h.report.teams[0])} ${h.report.score[0]}-${h.report.score[1]} ${esc(h.report.teams[1])}
        <span class="muted">T${h.season} J${h.round}</span></li>`).join('') || '<li class="muted">—</li>';
    this.render(`
      <h2>${esc(ref.firstName)} ${esc(ref.lastName)}</h2>
      <p class="muted">${ref.age} ${t('ui.years')} · ${NATIONS.find((n) => n.id === ref.nationId)?.name} · ${esc(c.division.name)}
        · ${t('ui.globalAvg')} ${overall(ref)}</p>
      <div class="two-col">
        <div class="card"><h4>${t('ui.attributes')}</h4>${stats}</div>
        <div class="card"><h4>${t('ui.record')}</h4>
          <ul class="list small">
            <li>${t('career.matches')}: ${r.matches}</li>
            <li>${t('career.avgRating')}: ${avgRating(ref) ?? '—'}</li>
            <li>${t('report.yellows')}: ${r.yellows} · ${t('report.reds')}: ${r.reds}</li>
            <li>${t('report.penalties')}: ${r.penalties} · ${t('report.goals')}: ${r.goals}</li>
            <li>${t('ui.correctDec')}: ${r.correct} · ${t('ui.debatableDec')}: ${r.debatable} · ${t('ui.incorrectDec')}: ${r.incorrect}</li>
            <li>${t('report.varReviews')}: ${r.varReviews} · ${t('ui.promotions')}: ${r.promotions}</li>
            <li>${t('stat.reputation')}: ${Math.round(ref.reputation)} · ${t('stat.ethics')}: ${Math.round(ref.ethics)}</li>
            <li>${t('press.followers')}: ${ref.followers.toLocaleString('es')}</li>
          </ul>
          <h4>${t('ui.lastMatches')}</h4><ul class="list small">${hist}</ul></div>
      </div>
      <div class="row-btns">
        <button data-act="hub">${t('ui.back')}</button>
        <button class="danger" data-act="retire">${t('career.retire')}</button>
      </div>`);
  }

  achievements() {
    const sys = this.game.career ? this.game.career.achievements : this.game.freeAchievements;
    const all = sys.all();
    const done = all.filter((a) => a.unlocked).length;
    this.render(`
      <h2>${t('ach.title')} <span class="muted">${done}/${all.length}</span></h2>
      <div class="ach-grid">
        ${all.map((a) => `<div class="card ach ${a.unlocked ? 'on' : 'off'}">
          <b>${a.unlocked ? '🏅' : '🔒'} ${esc(a.name)}</b><p class="muted small">${esc(a.desc)}</p></div>`).join('')}
      </div>
      <div class="row-btns"><button data-act="${this.game.career ? 'hub' : 'menu'}">${t('ui.back')}</button></div>`);
  }

  // ------------------------------------------------------------ ajustes

  settings() {
    const s = this.game.settings;
    this.render(`
      <h2>${t('menu.settings')}</h2>
      <div class="card">
        <h4>${t('settings.language')}</h4>
        <div class="chips">${availableLocales().map((l) =>
      `<button class="chip-btn ${getLocale() === l.id ? 'on' : ''}" data-act="setLocale" data-id="${l.id}">${l.name}</button>`).join('')}</div>
        <h4>${t('settings.difficulty')}</h4>
        <div class="chips">${Object.values(DIFFICULTY).map((d) =>
      `<button class="chip-btn ${s.difficulty === d.id ? 'on' : ''}" data-act="setDifficulty" data-id="${d.id}">${t(d.label)}</button>`).join('')}</div>
        <h4>${t('ui.options')}</h4>
        <div class="chips">
          <button class="chip-btn ${s.sound ? 'on' : ''}" data-act="toggleSetting" data-key="sound">${t('settings.sound')}</button>
          <button class="chip-btn ${s.showEvaluation ? 'on' : ''}" data-act="toggleSetting" data-key="showEvaluation">${t('settings.showTruth')}</button>
          <button class="chip-btn ${s.autosave ? 'on' : ''}" data-act="toggleSetting" data-key="autosave">${t('settings.autosave')}</button>
        </div>
      </div>
      <div class="row-btns"><button data-act="${this.game.career ? 'hub' : 'menu'}">${t('ui.back')}</button></div>`);
  }

  saves() {
    const list = listSaves();
    this.render(`
      <h2>${t('menu.saves')}</h2>
      <div class="menu-grid saves">
        ${list.map((s) => `<div class="card save-slot">
          <b>${t('ui.slot')} ${s.slot}</b>
          ${s.empty ? `<p class="muted">${t('ui.empty')}</p>` : `<p>${esc(s.name)}<br><span class="muted small">${divisionById(s.division).name} · T${s.season} · ${s.matches} ${t('ui.matchesShort')} · nota ${s.rating ?? '—'}</span></p>`}
          <div class="chips">
            ${s.empty ? '' : `<button class="chip-btn" data-act="loadSlot" data-slot="${s.slot}">${t('ui.load')}</button>`}
            ${this.game.career ? `<button class="chip-btn" data-act="saveSlot" data-slot="${s.slot}">${t('ui.save')}</button>` : ''}
            ${s.empty ? '' : `<button class="chip-btn danger" data-act="deleteSlot" data-slot="${s.slot}">${t('ui.delete')}</button>`}
          </div>
        </div>`).join('')}
      </div>
      <div class="row-btns"><button data-act="${this.game.career ? 'hub' : 'menu'}">${t('ui.back')}</button></div>`);
  }

  // ------------------------------------------------------ classic/especiales

  classicSetup() {
    const world = this.game.classicWorld();
    const divs = DIVISIONS.filter((d) => !d.national);
    const clubs = clubsOfDivision(world, divs[0].id);
    this.render(`
      <h2>${t('menu.classic')}</h2>
      <div class="form-grid">
        <label>${t('career.division')}<select id="c-div">${divs.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}</select></label>
        <label>${t('ui.home')}<select id="c-home">${clubs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
        <label>${t('ui.away')}<select id="c-away">${clubs.map((c, i) => `<option value="${c.id}" ${i === 1 ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>${t('ui.weather')}<select id="c-weather">
          <option value="clear">Sol</option><option value="rain">Lluvia</option>
          <option value="storm">Tormenta</option><option value="wind">Viento</option>
          <option value="snow">Nieve</option><option value="heat">Calor</option></select></label>
        <label>${t('settings.difficulty')}<select id="c-diff">${Object.values(DIFFICULTY).map((d) => `<option value="${d.id}" ${d.id === this.game.settings.difficulty ? 'selected' : ''}>${t(d.label)}</option>`).join('')}</select></label>
        <label>${t('ui.importance')}<input id="c-imp" type="number" min="0" max="100" value="60"></label>
      </div>
      <div class="row-btns">
        <button class="primary" data-act="startClassic">${t('ui.play')}</button>
        <button data-act="menu">${t('ui.back')}</button>
      </div>`);
    const divSel = this.root.querySelector('#c-div');
    divSel.addEventListener('change', () => {
      const cs = clubsOfDivision(world, divSel.value);
      const opts = cs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      this.root.querySelector('#c-home').innerHTML = opts;
      this.root.querySelector('#c-away').innerHTML = opts;
      this.root.querySelector('#c-away').selectedIndex = 1;
    });
  }

  specials(kind) {
    const list = kind === 'historic' ? HISTORIC : SCENARIOS;
    this.render(`
      <h2>${kind === 'historic' ? t('menu.historic') : t('menu.scenarios')}</h2>
      <div class="menu-grid">
        ${list.map((s) => `<div class="card scenario">
          <b>${esc(s.name)}</b>
          <p class="muted small">${esc(s.desc)}</p>
          <p class="small">🎯 ${esc(s.goal)}</p>
          <button class="primary" data-act="startSpecial" data-id="${s.id}">${t('ui.play')}</button>
        </div>`).join('')}
      </div>
      <div class="row-btns"><button data-act="menu">${t('ui.back')}</button></div>`);
  }

  // ------------------------------------------------------------ reglamento

  rulebook() {
    const sections = ['fouls', 'cards', 'handball', 'offside', 'advantage', 'penalty', 'var', 'restarts'];
    this.render(`
      <h2>${t('rulebook.title')}</h2>
      ${sections.map((k) => {
      const items = t(`law.${k}`);
      const list = Array.isArray(items) ? items : [items];
      return `<div class="card"><h4>${t(`rulebook.${k}`)}</h4>
        <ul class="list small">${list.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
    }).join('')}
      <div class="row-btns"><button data-act="${this.game.career ? 'hub' : 'menu'}">${t('ui.back')}</button></div>`);
  }

  ending(end, career) {
    this.render(`
      <h2>${t('ui.careerEnd')}</h2>
      <div class="final-rating"><div class="fr-value good">${t(end.key)}</div>
        <div class="fr-label">${career.referee.firstName} ${career.referee.lastName} · ${career.referee.record.matches} ${t('ui.matchesShort')} · nota media ${avgRating(career.referee) ?? '—'}</div></div>
      <div class="card"><ul class="list small">
        <li>${t('ui.divisionReached')}: ${career.division.name}</li>
        <li>${t('stat.reputation')}: ${Math.round(career.referee.reputation)}</li>
        <li>${t('stat.ethics')}: ${Math.round(career.referee.ethics)} · ${t('syndicate.corruption')}: ${Math.round(career.referee.corruption)}</li>
        <li>${t('ui.promotions')}: ${career.referee.record.promotions}</li>
      </ul></div>
      <div class="row-btns"><button class="primary" data-act="menu">${t('ui.continue')}</button></div>`);
  }

  scenarioResult(special, report, passed) {
    this.render(`
      <h2>${esc(special.name)}</h2>
      <div class="banner ${passed ? 'good' : 'bad'}">${passed ? t('ui.goalAchieved') : t('ui.goalFailed')}</div>
      <div class="final-rating"><div class="fr-value ${passed ? 'good' : 'bad'}">${report.rating.overall}</div>
        <div class="fr-label">${esc(special.goal)} (${t('ui.minimum')} ${special.targetRating})</div></div>
      <div class="row-btns">
        <button class="primary" data-act="startSpecial" data-id="${special.id}">${t('ui.retry')}</button>
        <button data-act="${special.kind === 'historic' ? 'historic' : 'scenarios'}">${t('ui.back')}</button>
        <button data-act="menu">${t('menu.quit')}</button>
      </div>`);
  }
}

export default Screens;
