// Pruebas del motor de partido: invariantes que deben cumplirse siempre,
// pase lo que pase dentro de la simulación.

import { suite, check, between } from './harness.js';
import { generateWorld, generateCrew } from '../src/data/generators.js';
import { createMatch } from '../src/match/state.js';
import { MatchEngine } from '../src/match/matchEngine.js';
import { createReferee } from '../src/career/referee.js';
import { makeAutoReferee } from '../src/ai/autoReferee.js';
import { DIFFICULTY, FIELD, SIM } from '../src/core/config.js';
import { RNG } from '../src/core/rng.js';
import { makeChallengeIncident, makeHandballIncident } from '../src/match/incidents.js';

const world = generateWorld('motor');
const div = world.divisions.find((d) => d.id === 'primera');
const clubs = div.clubIds.map((id) => world.clubs[id]);

/** Juega un partido completo con árbitro automático y devuelve el estado. */
function playMatch(opts = {}) {
  const rng = new RNG(opts.seed || 1);
  const match = createMatch({
    home: clubs[opts.home ?? 0],
    away: clubs[opts.away ?? 5],
    competition: div,
    seed: opts.seed || 1,
    weather: opts.weather || 'clear',
    importance: opts.importance ?? 60,
    rivalry: opts.rivalry ?? 30,
    difficulty: opts.difficulty || DIFFICULTY.normal,
    referee: createReferee({ seed: 'auto', baseLevel: 70 }),
    crew: generateCrew(rng, div.level, true),
    varEnabled: true,
    knockout: !!opts.knockout,
  });
  const engine = new MatchEngine(match, {
    autoReferee: makeAutoReferee({ skill: opts.skill ?? 75, rng: match.rng }),
  });
  const seen = { positions: true, phases: new Set() };
  if (opts.onShot) {
    const prev = engine.hooks.onShot;
    engine.hooks.onShot = (carrier, target, d) => { opts.onShot(d); return prev && prev(carrier, target, d); };
  }
  engine.start();
  // Algunas pruebas sólo necesitan un partido colocado, no jugado
  if (opts.soloCrear) return { match, engine, report: null, seen };

  let guard = 0;
  while (!engine.finished && guard++ < 400000) {
    const dx = match.ball.pos.x - match.ref.pos.x;
    const dy = match.ball.pos.y - match.ref.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    engine.setInput({ dx: d > 14 ? dx / d : 0, dy: d > 14 ? dy / d : 0, sprint: d > 28 });
    if (match.phase === 'halftime') engine.resumeFromHalfTime();
    engine.update(SIM.dt);
    seen.phases.add(match.phase);

    // Invariantes por tick
    for (const e of match.entities) {
      if (!e.onPitch) continue;
      if (e.pos.x < -2 || e.pos.x > FIELD.length + 2 || e.pos.y < -3 || e.pos.y > FIELD.width + 3) {
        seen.positions = false;
      }
      if (!Number.isFinite(e.pos.x) || !Number.isFinite(e.pos.y)) seen.positions = false;
    }
  }
  return { match, engine, report: match.report, guard, seen };
}

export default suite('Motor de partido', (t) => {
  t('un partido termina y genera informe', () => {
    const { report, match, guard } = playMatch({ seed: 7 });
    check(!!report, `no hubo informe (iteraciones ${guard})`);
    between(match.clock / 60, 90, 130, 'la duración se ha ido de madre');
    check(report.counts.total > 5, 'demasiadas pocas decisiones');
  });

  t('nadie se sale del campo ni acaba en NaN', () => {
    const { seen } = playMatch({ seed: 12, weather: 'storm' });
    check(seen.positions, 'algún jugador salió del campo o quedó en NaN');
  });

  t('la posesión suma 100% y las estadísticas son coherentes', () => {
    const { report } = playMatch({ seed: 21 });
    check(report.possession[0] + report.possession[1] >= 99, 'la posesión no cuadra');
    for (const s of report.stats) {
      check(s.shotsOn <= s.shots, 'no puede haber más tiros a puerta que tiros');
      check(s.goals <= s.shots + s.penalties, 'goles sin tiros');
      check(s.reds <= 11, 'no se puede expulsar a más de once');
    }
  });

  t('nunca quedan menos de siete jugadores por equipo', () => {
    const { match } = playMatch({ seed: 33, skill: 40 });
    for (const side of [0, 1]) {
      const enCampo = match.entities.filter((e) => e.side === side && e.onPitch && !e.red).length;
      check(enCampo >= 7, `un equipo se quedó con ${enCampo}`);
    }
  });

  t('el descuento se calcula y se juega', () => {
    const { match } = playMatch({ seed: 44 });
    check(match.clock / 60 > 90, 'debería jugarse algo de descuento');
  });

  t('la eliminatoria empatada llega a prórroga o penaltis', () => {
    let vistos = 0;
    for (const seed of [3, 8, 15, 23, 42]) {
      const { match } = playMatch({ seed, knockout: true });
      if (match.shootout || match.half >= 3) vistos++;
      if (match.shootout) {
        check(match.shootout.score[0] !== match.shootout.score[1], 'la tanda debe tener ganador');
      }
    }
    check(vistos >= 1, 'ninguna eliminatoria pasó del tiempo reglamentario en cinco intentos');
  });

  t('cada decisión queda registrada con su calificación', () => {
    const { report } = playMatch({ seed: 55 });
    for (const d of report.decisions) {
      check(!!d.grade, 'decisión sin calificar');
      check(['correct', 'mostly', 'debatable', 'incorrect'].includes(d.grade), `calificación rara: ${d.grade}`);
      check(typeof d.minute === 'number' && d.minute >= 0, 'minuto inválido');
      check(!!d.rule, 'decisión sin regla aplicable');
    }
    const suma = report.counts.correct + report.counts.mostly + report.counts.debatable + report.counts.incorrect;
    check(suma === report.counts.total, 'el recuento de decisiones no cuadra');
  });

  t('la nota se mueve con el acierto del árbitro', () => {
    const bueno = playMatch({ seed: 61, skill: 97 }).report.rating.overall;
    const malo = playMatch({ seed: 61, skill: 25 }).report.rating.overall;
    check(bueno > malo, `el buen árbitro debería puntuar más (${bueno} vs ${malo})`);
    between(bueno, 1, 10, 'nota fuera de rango');
    between(malo, 1, 10, 'nota fuera de rango');
  });

  t('el mismo partido con la misma semilla da el mismo resultado', () => {
    const a = playMatch({ seed: 77 });
    const b = playMatch({ seed: 77 });
    check(a.report.score[0] === b.report.score[0] && a.report.score[1] === b.report.score[1],
      'el marcador debería repetirse');
    check(a.report.counts.total === b.report.counts.total, 'las decisiones deberían repetirse');
  });

  t('se guardan repeticiones de las jugadas destacadas', () => {
    const { report } = playMatch({ seed: 88 });
    const clips = Object.values(report.clips || {});
    check(clips.length > 0, 'debería guardarse alguna jugada');
    for (const c of clips) {
      check(c.frames.length > 4, 'clip demasiado corto');
      check(c.frames[0].players.length > 12, 'el clip debería contener a los jugadores');
      check(c.frames[c.frames.length - 1].t > c.frames[0].t, 'los fotogramas deben avanzar en el tiempo');
    }
  });

  t('no quedan repeticiones sin cerrar al acabar', () => {
    const { engine, report } = playMatch({ seed: 91 });
    check(engine.pendingClips.length === 0, 'quedaron clips sin volcar');
    const ultima = [...(report.decisions || [])].reverse()
      .find((d) => d.decision.card || d.impact === 'critical' || d.impact === 'high');
    if (ultima) {
      check(!!report.clips[ultima.incidentId],
        'la última jugada destacada debería tener repetición');
    }
  });

  t('dentro del área se defiende con más cuidado que fuera', () => {
    // Lo que de verdad se fue de madre en la calibración fueron los penaltis:
    // 0,63 por partido contra los 0,25 reales. La causa no era el reglamento,
    // sino con qué frecuencia se daban los hechos que lo activan. Aquí se fija
    // esa diferencia, que es barata y determinista de medir; el número final
    // por partido se vigila con `node test/run.js 60`.
    const { match } = playMatch({ seed: 900, home: 1, away: 4, soloCrear: true });
    const dentroX = 8, fueraX = 45;

    const medir = (x) => {
      let faltas = 0, jugoBalon = 0;
      const N = 600;
      for (let i = 0; i < N; i++) {
        const def = match.entities[3], att = match.entities[14];
        def.pos = { x: x + 1.2, y: FIELD.width / 2 };
        att.pos = { x, y: FIELD.width / 2 };
        const inc = makeChallengeIncident(match, def, att, { diff: -3, speedDiff: 6 });
        if (inc.truth.isFoul) faltas++;
        if (inc.facts.playedBall) jugoBalon++;
      }
      return { faltas: faltas / N, jugoBalon: jugoBalon / N };
    };

    const area = medir(dentroX);
    const centro = medir(fueraX);
    check(area.jugoBalon > centro.jugoBalon + 0.15,
      `en el área debería jugarse el balón mucho más (${(area.jugoBalon * 100).toFixed(0)}% vs ${(centro.jugoBalon * 100).toFixed(0)}%)`);
    check(area.faltas < centro.faltas,
      `en el área deberían pitarse menos faltas (${(area.faltas * 100).toFixed(0)}% vs ${(centro.faltas * 100).toFixed(0)}%)`);
  });

  t('la mano deliberada dentro del área es rarísima', () => {
    const { match } = playMatch({ seed: 901, home: 2, away: 6, soloCrear: true });
    const contar = (x) => {
      let penaltis = 0;
      const N = 800;
      for (let i = 0; i < N; i++) {
        const def = match.entities[4];
        def.pos = { x, y: FIELD.width / 2 };
        const inc = makeHandballIncident(match, def, null, {});
        if (inc.truth.penalty) penaltis++;
      }
      return penaltis / N;
    };
    const area = contar(8);
    check(area < 0.14, `demasiadas manos son penalti dentro del área: ${(area * 100).toFixed(0)}%`);
  });

  t('se dispara sobre todo desde cerca, no desde la frontal', () => {
    // Con una urgencia por disparar lineal en la distancia, dos tercios de los
    // tiros salían de fuera del área y la conversión se hundía al 6%. Aquí se
    // vigila el reparto, que es lo que de verdad se rompió.
    const dist = [];
    for (let i = 0; i < 6; i++) playMatch({ seed: 500 + i, home: i % 10, away: (i + 4) % 10, onShot: (d) => dist.push(d) });
    check(dist.length > 80, `pocos tiros para medir: ${dist.length}`);
    const lejanos = dist.filter((d) => d >= 22).length / dist.length;
    const cerca = dist.filter((d) => d < 16).length / dist.length;
    check(lejanos < 0.17, `demasiados tiros lejanos: ${(lejanos * 100).toFixed(0)}%`);
    check(cerca > 0.40, `pocos tiros desde dentro del área: ${(cerca * 100).toFixed(0)}%`);
  });

  t('las medias de un partido son creíbles', () => {
    const agg = { goles: 0, faltas: 0, amarillas: 0, rojas: 0, corners: 0, tiros: 0, penaltis: 0 };
    const N = 6;
    for (let i = 0; i < N; i++) {
      const { report } = playMatch({ seed: 200 + i, home: i % 10, away: (i + 5) % 10 });
      agg.goles += report.score[0] + report.score[1];
      agg.faltas += report.stats[0].fouls + report.stats[1].fouls;
      agg.amarillas += report.stats[0].yellows + report.stats[1].yellows;
      agg.rojas += report.stats[0].reds + report.stats[1].reds;
      agg.corners += report.stats[0].corners + report.stats[1].corners;
      agg.tiros += report.stats[0].shots + report.stats[1].shots;
      agg.penaltis += report.stats[0].penalties + report.stats[1].penalties;
    }
    between(agg.goles / N, 1.2, 4.5, 'goles por partido fuera de rango');
    between(agg.faltas / N, 12, 34, 'faltas por partido fuera de rango');
    between(agg.amarillas / N, 0.8, 6, 'amarillas por partido fuera de rango');
    between(agg.rojas / N, 0, 1.2, 'rojas por partido fuera de rango');
    between(agg.corners / N, 4, 16, 'córners por partido fuera de rango');
    between(agg.tiros / N, 14, 45, 'tiros por partido fuera de rango');
    between(agg.penaltis / N, 0, 1.2, 'penaltis por partido fuera de rango');
  });

  t('los cambios responden al marcador y al desgaste', () => {
    let motivos = new Set();
    let total = 0;
    for (const seed of [301, 302, 303, 304]) {
      const match = createMatch({
        home: clubs[1], away: clubs[6], competition: div, seed,
        difficulty: DIFFICULTY.normal, referee: createReferee({ seed: 's', baseLevel: 70 }),
        crew: generateCrew(new RNG(seed), div.level, true), varEnabled: true,
      });
      const engine = new MatchEngine(match, { autoReferee: makeAutoReferee({ skill: 78, rng: match.rng }) });
      engine.on('substitution', ({ reason }) => { motivos.add(reason); total++; });
      engine.start();
      let guard = 0;
      while (!engine.finished && guard++ < 400000) {
        if (match.phase === 'halftime') engine.resumeFromHalfTime();
        engine.update(SIM.dt);
      }
      for (const side of [0, 1]) check(match.subsUsed[side] <= SIM.maxSubsPerTeam, 'demasiados cambios');
    }
    check(total > 0, 'no hubo cambios en cuatro partidos');
    check(motivos.size >= 2, `los cambios deberían responder a varios motivos: ${[...motivos]}`);
  });

  t('un escenario arranca en el minuto que dice', () => {
    const rng = new RNG(909);
    const match = createMatch({
      home: clubs[2], away: clubs[7], competition: div, seed: 909,
      difficulty: DIFFICULTY.normal, referee: createReferee({ seed: 'e', baseLevel: 70 }),
      crew: generateCrew(rng, div.level, true), varEnabled: true,
      startMinute: 88, half: 2, kickoffScore: [1, 1],
    });
    const engine = new MatchEngine(match, { autoReferee: makeAutoReferee({ skill: 75, rng: match.rng }) });
    engine.start();
    check(match.half === 2, `debería arrancar en la segunda parte, no en la ${match.half}`);
    between(match.clock / 60, 87.9, 89, 'debería arrancar cerca del minuto 88');
    check(match.score[0] === 1 && match.score[1] === 1, 'debería respetar el marcador de partida');

    let guard = 0;
    while (!engine.finished && guard++ < 400000) {
      if (match.phase === 'halftime') engine.resumeFromHalfTime();
      engine.update(SIM.dt);
    }
    check(!!match.report, 'el escenario debería terminar y dar informe');
    between(match.clock / 60, 89, 105, 'un escenario de últimos minutos no puede durar un partido entero');
  });

  t('el clima cambia el juego', () => {
    const seco = playMatch({ seed: 400, weather: 'clear' }).report;
    const nieve = playMatch({ seed: 400, weather: 'snow' }).report;
    check(seco.weather === 'clear' && nieve.weather === 'snow', 'el clima debería quedar registrado');
    check(JSON.stringify(seco.score) !== JSON.stringify(nieve.score)
      || seco.counts.total !== nieve.counts.total, 'el clima no está afectando a nada');
  });

  t('la dificultad realista es más exigente con la nota', () => {
    const facil = playMatch({ seed: 500, difficulty: DIFFICULTY.easy, skill: 65 }).report.rating.overall;
    const dura = playMatch({ seed: 500, difficulty: DIFFICULTY.realistic, skill: 65 }).report.rating.overall;
    check(dura <= facil, `realista debería puntuar igual o más bajo (${dura} vs ${facil})`);
  });
});
