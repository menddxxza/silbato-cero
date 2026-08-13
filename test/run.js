// Banco de pruebas headless. `node test/run.js [n]`
// Simula partidos completos sin UI y comprueba que el motor produce
// resultados creíbles y sin errores.

import { generateWorld, divisionById, generateCrew } from '../src/data/generators.js';
import { createMatch } from '../src/match/state.js';
import { MatchEngine } from '../src/match/matchEngine.js';
import { createReferee } from '../src/career/referee.js';
import { makeAutoReferee } from '../src/ai/autoReferee.js';
import { DIFFICULTY } from '../src/core/config.js';
import { RNG } from '../src/core/rng.js';

const N = Number(process.argv[2] || 5);
// Por defecto se simula una jornada de liga normal: 90 minutos, sin
// eliminatorias y con la temperatura media de un partido cualquiera. Es lo que
// juega el jugador la mayor parte del tiempo, y por tanto con lo que hay que
// comparar las medias reales. `node test/run.js 40 copa` mide el otro extremo:
// eliminatorias con prórroga y partidos calientes, donde todo sube.
const MODO = (process.argv[3] || 'liga').toLowerCase();
const COPA = MODO === 'copa';
const world = generateWorld('test-world');
const div = world.divisions.find((d) => d.id === 'primera');
const clubs = div.clubIds.map((id) => world.clubs[id]);

let failures = 0;
const agg = {
  goals: 0, fouls: 0, yellows: 0, reds: 0, offsides: 0, corners: 0, shots: 0,
  decisions: 0, incidents: 0, ratings: [], minutes: 0, penalties: 0, varReviews: 0,
};

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ' + msg); failures++; }
}

for (let i = 0; i < N; i++) {
  const rng = new RNG(`match-${i}`);
  const home = clubs[i % clubs.length];
  const away = clubs[(i + 7) % clubs.length];
  const referee = createReferee({ seed: `ref-${i}`, baseLevel: 68 });
  const match = createMatch({
    home, away, competition: div, seed: 1000 + i,
    weather: rng.pick(COPA ? ['clear', 'rain', 'wind', 'storm'] : ['clear', 'clear', 'clear', 'rain', 'wind']),
    importance: COPA ? rng.int(70, 95) : rng.int(35, 65),
    rivalry: COPA ? rng.int(50, 90) : rng.int(0, 40),
    difficulty: DIFFICULTY.normal, referee,
    crew: generateCrew(rng, div.level, true), varEnabled: true,
    knockout: COPA && i % 3 === 0,
  });

  const engine = new MatchEngine(match, {
    autoReferee: makeAutoReferee({ skill: 72, rng: match.rng }),
    speed: 1,
  });

  // El árbitro automático también se mueve: sigue al balón
  engine.on('match:start', () => {});
  engine.start();

  let guard = 0;
  const maxIters = 400000;
  while (!engine.finished && guard++ < maxIters) {
    // Seguimiento del balón por el árbitro virtual
    const dx = match.ball.pos.x - match.ref.pos.x;
    const dy = match.ball.pos.y - match.ref.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    engine.setInput({ dx: d > 14 ? dx / d : 0, dy: d > 14 ? dy / d : 0, sprint: d > 28 });
    if (match.phase === 'halftime') engine.resumeFromHalfTime();
    engine.update(1 / 30);
  }

  const r = match.report;
  if (!r) { console.error(`Partido ${i}: no generó informe (guard=${guard})`); failures++; continue; }

  agg.goals += r.score[0] + r.score[1];
  agg.fouls += r.stats[0].fouls + r.stats[1].fouls;
  agg.yellows += r.stats[0].yellows + r.stats[1].yellows;
  agg.reds += r.stats[0].reds + r.stats[1].reds;
  agg.offsides += r.stats[0].offsides + r.stats[1].offsides;
  agg.corners += r.stats[0].corners + r.stats[1].corners;
  agg.shots += r.stats[0].shots + r.stats[1].shots;
  agg.shotsOn = (agg.shotsOn||0) + r.stats[0].shotsOn + r.stats[1].shotsOn;
  agg.saves = (agg.saves||0) + r.stats[0].saves + r.stats[1].saves;
  agg.penalties += r.stats[0].penalties + r.stats[1].penalties;
  agg.decisions += r.counts.total;
  agg.incidents += r.incidents.length;
  agg.ratings.push(r.rating.overall);
  agg.minutes += match.clock / 60;

  console.log(
    `#${i} ${r.teams[0].slice(0, 18)} ${r.score[0]}-${r.score[1]} ${r.teams[1].slice(0, 18)}` +
    ` | ${Math.round(match.clock / 60)}' | faltas ${r.stats[0].fouls + r.stats[1].fouls}` +
    ` | TA ${r.stats[0].yellows + r.stats[1].yellows} TR ${r.stats[0].reds + r.stats[1].reds}` +
    ` | dec ${r.counts.total} (ok ${r.counts.correct}/dud ${r.counts.debatable}/mal ${r.counts.incorrect})` +
    ` | nota ${r.rating.overall}` +
    (r.shootout ? ` | penaltis ${r.shootout.score[0]}-${r.shootout.score[1]}` : '') +
    (r.abandoned ? ' | SUSPENDIDO' : ''),
  );

  assert(match.clock / 60 >= 89 || r.abandoned, `partido ${i} terminó antes de tiempo (${Math.round(match.clock / 60)}')`);
  assert(r.counts.total > 5, `partido ${i} con muy pocas decisiones (${r.counts.total})`);
  assert(r.rating.overall >= 1 && r.rating.overall <= 10, `nota fuera de rango en ${i}`);
  assert(r.possession[0] + r.possession[1] >= 99, `posesión incoherente en ${i}`);
}

const n = N;
console.log(`\n— MEDIAS POR PARTIDO (${COPA ? 'copa: eliminatorias y partidos calientes' : 'jornada de liga normal'}) —`);
console.log(`goles      ${(agg.goals / n).toFixed(2)}`);
console.log(`faltas     ${(agg.fouls / n).toFixed(1)}`);
console.log(`amarillas  ${(agg.yellows / n).toFixed(1)}`);
console.log(`rojas      ${(agg.reds / n).toFixed(2)}`);
console.log(`penaltis   ${(agg.penalties / n).toFixed(2)}`);
console.log(`fuera j.   ${(agg.offsides / n).toFixed(1)}`);
console.log(`córners    ${(agg.corners / n).toFixed(1)}`);
console.log(`tiros      ${(agg.shots / n).toFixed(1)} (a puerta ${(agg.shotsOn / n).toFixed(1)}, paradas ${(agg.saves/n).toFixed(1)})`);
console.log(`decisiones ${(agg.decisions / n).toFixed(1)}`);
console.log(`incidentes ${(agg.incidents / n).toFixed(1)}`);
console.log(`nota media ${(agg.ratings.reduce((a, b) => a + b, 0) / n).toFixed(2)}`);
console.log(`minutos    ${(agg.minutes / n).toFixed(1)}`);

if (failures) { console.error(`\n${failures} comprobaciones fallidas`); process.exit(1); }
console.log('\n✔ Todas las comprobaciones pasaron');
