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
import { makeChallengeIncident, makeHandballIncident, makeOffsideIncident } from '../src/match/incidents.js';
import { tackleCaution } from '../src/match/sim.js';
import { reactionDelay, recordHistory, posHace } from '../src/match/offBall.js';

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

  t('un penalti se marca tres de cada cuatro veces', () => {
    // Con atributos fijos: si no, el resultado depende de qué lanzador y qué
    // portero toquen, y varía diez puntos entre mundos. Aquí se mide el
    // modelo, no la suerte del sorteo.
    const { match, engine } = playMatch({ seed: 950, home: 3, away: 8, soloCrear: true, importance: 60 });
    const lanzador = match.entities.find((e) => e.side === 0 && e.role !== 'GK');
    const portero = match.entities.find((e) => e.side === 1 && e.role === 'GK');
    Object.assign(lanzador.player, { shooting: 70, technique: 70 });
    Object.assign(portero.player, { positioning: 70, technique: 70 });
    // El lanzador elegido es el de más disparo: se rebaja al resto
    for (const e of match.entities) {
      if (e.side === 0 && e !== lanzador) e.player.shooting = 40;
    }

    let marcados = 0;
    const N = 1200;
    for (let i = 0; i < N; i++) {
      const antes = match.score[0];
      engine._takePenalty(0);
      if (match.score[0] > antes) marcados++;
      match.score[0] = 0; match.score[1] = 0;
      match.phase = 'play';
      match.restart = null;
      match.clock = 600;
    }
    const tasa = marcados / N;
    between(tasa, 0.71, 0.79, `los penaltis se marcan el ${(tasa * 100).toFixed(1)}% de las veces`);
  });

  t('quien pita una entrada temeraria la amonesta', () => {
    // La tarjeta no puede ser una segunda tirada a ciegas: para llegar a esa
    // fase el árbitro ya ha pitado y se ha acercado al jugador. Con dos
    // tiradas independientes se perdían dos tercios de las amarillas que el
    // reglamento pedía (1,6 mostradas de 4,5 debidas).
    const rng = new RNG('tarjetas');
    const auto = makeAutoReferee({ skill: 72, rng });
    const inc = { type: 'challenge', clarity: 0.7, truth: { card: 'yellow', cardReason: 'foul.recklessTackle' } };
    let mostradas = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (auto(inc, [], {}, { cardPhase: true }).card === 'yellow') mostradas++;
    }
    const tasa = mostradas / N;
    check(tasa > 0.68, `sólo amonesta el ${(tasa * 100).toFixed(0)}% de las entradas temerarias que ya ha pitado`);
  });

  t('un amonestado entra con miedo a la segunda', () => {
    // Sin esto, un jugador con amarilla entraba igual que uno limpio y las
    // expulsiones por doble amarilla se iban a 0,47 por partido (real 0,1-0,2).
    const limpio = { yellow: 0 };
    const amonestado = { yellow: 1 };
    check(tackleCaution(amonestado, false) < tackleCaution(limpio, false) * 0.6,
      'un amonestado debería medir mucho más la entrada fuera del área');
    check(tackleCaution(amonestado, true) < tackleCaution(limpio, true),
      'y también dentro de su área');
    check(tackleCaution(limpio, true) < tackleCaution(limpio, false) * 0.3,
      'dentro del área se entra mucho menos que fuera');
  });

  t('la segunda amarilla enseña también la roja', () => {
    // Emitiendo sólo la amarilla, la interfaz expulsaba a un jugador mientras
    // en pantalla salía una cartulina amarilla: la roja no aparecía nunca.
    const { match, engine } = playMatch({ seed: 970, home: 1, away: 6, soloCrear: true });
    const jugador = match.entities.find((e) => e.side === 0 && e.role === 'DF');
    const vistas = [];
    engine.on('card', ({ card }) => vistas.push(card));
    const inc = { truth: { cardReason: 'foul.recklessTackle' } };

    engine._giveCard(jugador, 'yellow', inc);
    check(vistas.join(',') === 'yellow', `la primera debería ser sólo amarilla: ${vistas}`);

    vistas.length = 0;
    engine._giveCard(jugador, 'yellow', inc);
    check(vistas.join(',') === 'yellow,red', `la segunda debería enseñar amarilla y roja: ${vistas}`);
    check(jugador.red === true && jugador.onPitch === false, 'y dejarlo fuera del campo');
  });

  t('las demoras no son todas descaradas', () => {
    // El retraso se calculaba sumando el acumulado entero, así que salía
    // casi siempre por encima de los 12 s que el reglamento considera
    // descarados: la pérdida de tiempo llegó a ser el 43% de las amarillas
    // del partido (1,63 por partido, real 0,3-0,5), y de ahí salían casi
    // todas las dobles amarillas.
    const { match, engine } = playMatch({ seed: 980, home: 2, away: 9, soloCrear: true });
    const demoras = [];
    engine._raise = (inc) => {
      if (inc && inc.type === 'timewasting') demoras.push(inc.truth.delaySeconds);
      return null;
    };

    match.score[0] = 2; match.score[1] = 1;
    // La demora sólo se plantea de vez en cuando: hacen falta muchas pasadas
    // para tener muestra, pero no se simula nada.
    for (let i = 0; i < 6000; i++) {
      match.clock = 70 * 60;
      match.restart = { type: 'throwIn', side: 0, pos: { x: 50, y: 2 } };
      engine.timeWastingRaised = false;
      engine.delayAccum = 7;
      engine._checkTimeWasting(0.5);
    }
    check(demoras.length > 30, `pocas demoras para medir: ${demoras.length}`);
    const descaradas = demoras.filter((d) => d > 12).length / demoras.length;
    check(descaradas < 0.35,
      `demasiadas demoras son descaradas de salida: ${(descaradas * 100).toFixed(0)}%`);
  });

  t('el fuera de juego se juzga en el instante del pase', () => {
    // Se medía la posición de recepción, no la del momento en que se jugó el
    // balón, que es lo que dice el reglamento. Con eso, un delantero que
    // arrancaba desde atrás y recibía adelantado salía «fuera de juego», y uno
    // que partía adelantado y esperaba salía habilitado: justo al revés.
    const { match } = playMatch({ seed: 990, home: 4, away: 7, soloCrear: true });
    const pasador = match.entities.find((e) => e.side === 0 && e.role === 'MF');
    const receptor = match.entities.find((e) => e.side === 0 && e.role === 'FW');
    const dir = match.entities[0].side === 0 ? 1 : 1;

    // Defensa en x=60; el receptor recibe en x=70 (por delante), pero cuando
    // se jugó el balón estaba en x=50, claramente habilitado.
    const snapshot = {
      defenders: [{ x: 60, y: 30 }, { x: 61, y: 38 }],
      attackers: { [receptor.id]: { x: 50, y: 34 } },
      ballX: 55,
    };
    receptor.pos = { x: 70, y: 34 };
    const inc = makeOffsideIncident(match, pasador, receptor, snapshot);
    check(inc.truth.offside === false,
      `partiendo desde atrás no puede ser fuera de juego (margen ${inc.margin.toFixed(1)} m)`);

    // Y al revés: partía adelantado aunque reciba retrasado
    const snapshot2 = {
      defenders: [{ x: 60, y: 30 }, { x: 61, y: 38 }],
      attackers: { [receptor.id]: { x: 68, y: 34 } },
      ballX: 55,
    };
    receptor.pos = { x: 58, y: 34 };
    const inc2 = makeOffsideIncident(match, pasador, receptor, snapshot2);
    check(inc2.truth.offside === true,
      `partiendo adelantado sí es fuera de juego (margen ${inc2.margin.toFixed(1)} m)`);
  });

  t('el marcaje reacciona con retraso, no adivina', () => {
    // El defensor marcaba la posición exacta del atacante en cada fotograma:
    // un marcaje clarividente con el que ningún desmarque puede ganar un
    // metro. De ahí salían 2,5 fueras de juego por partido en vez de 3-5, y
    // ningún balón llegaba a la espalda de la defensa.
    const bueno = { player: { positioning: 90 } };
    const malo = { player: { positioning: 20 } };
    check(reactionDelay(bueno) < reactionDelay(malo),
      'quien mejor se coloca debería reaccionar antes');
    check(reactionDelay(bueno) > 0.1 && reactionDelay(malo) < 0.7,
      'los retardos deberían estar en décimas de segundo, no en segundos');

    // Un atacante que arranca deja atrás al que le marca
    const atacante = { pos: { x: 0, y: 30 } };
    // El motor guarda la posición al final del paso, después de mover
    for (let i = 0; i < 20; i++) {
      atacante.pos = { x: atacante.pos.x + 0.25, y: 30 };   // 7,5 m/s
      recordHistory(atacante);
    }
    const visto = posHace(atacante, reactionDelay(malo));
    const ventaja = atacante.pos.x - visto.x;
    check(ventaja > 2, `el desmarque debería ganar metros al marcador: ${ventaja.toFixed(1)} m`);
    check(posHace(atacante, 0).x === atacante.pos.x,
      'sin retardo se ve la posición actual');

    // Y que el motor lo use de verdad, no sólo que exista
    const { match } = playMatch({ seed: 991, home: 0, away: 3 });
    const conHistoria = match.entities.filter((e) => e.hist && e.hist.length > 5).length;
    check(conHistoria >= 20,
      `los jugadores deberían guardar su rastro para el marcaje: sólo ${conHistoria}`);
  });

  t('el VAR llama al árbitro ante un error claro', () => {
    // El protocolo real: la sala revisa en silencio TODAS las jugadas
    // revisables y llama cuando hay un error claro y manifiesto. El árbitro no
    // pide la revisión, se la piden. Sin esto el VAR sólo existía si el propio
    // árbitro lo pedía, y se quedaban sin corregir 0,10 penaltis claros por
    // partido; con ello, las llamadas caen a 0,28 por partido (real ~0,3).
    const { match, engine } = playMatch({ seed: 995, home: 2, away: 5, soloCrear: true });
    const def = match.entities.find((e) => e.side === 1 && e.role === 'DF');
    const att = match.entities.find((e) => e.side === 0 && e.role === 'FW');

    const penaltiClaro = () => {
      const inc = makeChallengeIncident(match, def, att, { diff: -30, speedDiff: 9 });
      inc.truth = { ...inc.truth, isFoul: true, penalty: true, restart: 'penalty', card: null };
      inc.inBox = true;
      inc.reviewable = true;
      return inc;
    };

    // Dejar seguir un penalti de manual: error claro
    let llamadas = 0;
    engine.on('var:calls', () => { llamadas++; });
    let intentos = 0;
    while (llamadas === 0 && intentos++ < 40) {
      const inc = penaltiClaro();
      engine.pending = { incident: inc, options: [], timeLeft: 8 };
      match.pending = engine.pending;
      engine.decide({ action: 'playon' });
      if (engine.var.session) engine.var.close({ action: 'penalty' });
      if (engine.pendingCards) engine.decide({ card: null });
    }
    check(llamadas > 0, 'el VAR debería llamar ante un penalti claro no pitado');

    // Y no llamar cuando la decisión es la correcta
    let llamadasCorrectas = 0;
    engine.on('var:calls', () => { llamadasCorrectas++; });
    const antes = llamadas;
    for (let i = 0; i < 25; i++) {
      const inc = penaltiClaro();
      engine.pending = { incident: inc, options: [], timeLeft: 8 };
      match.pending = engine.pending;
      engine.decide({ action: 'penalty' });
      if (engine.var.session) engine.var.close({ action: 'penalty' });
      if (engine.pendingCards) engine.decide({ card: null });
      match.score[0] = 0; match.score[1] = 0;
    }
    check(llamadas === antes, `no debería llamar con la decisión correcta (llamó ${llamadas - antes} veces)`);
  });

  t('las medias de un partido son creíbles', () => {
    const agg = { goles: 0, faltas: 0, amarillas: 0, rojas: 0, corners: 0, tiros: 0, penaltis: 0 };
    // Doce partidos, no seis: con seis, un emparejamiento desequilibrado
    // arrastraba la media fuera de rango y la prueba saltaba sin que el motor
    // hubiera cambiado. La calibración fina se mide con `node test/run.js 60`.
    const N = 12;
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
    between(agg.corners / N, 4, 16, `córners por partido fuera de rango: ${(agg.corners / N).toFixed(1)}`);
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
