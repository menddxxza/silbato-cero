// Pruebas de los sistemas que rodean al partido: mundo, guardado, idiomas,
// carrera, economía y academia. Todo sin navegador.

import { suite, check, between } from './harness.js';
import { generateWorld, clubsOfDivision, DIVISIONS } from '../src/data/generators.js';
import { createMatch, colorDistance } from '../src/match/state.js';
import { Career, ASSETS } from '../src/career/career.js';
import { createReferee, addExperience, trainStat, overall } from '../src/career/referee.js';
import { DIFFICULTY } from '../src/core/config.js';
import { t as traducir } from '../src/core/i18n.js';
import { es } from '../i18n/es.js';
import { en } from '../i18n/en.js';
import { QUESTIONS } from '../src/data/examQuestions.js';
import { ACHIEVEMENT_IDS } from '../src/career/achievements.js';
import { allSpecials } from '../src/data/scenarios.js';
import { RNG } from '../src/core/rng.js';
import { Renderer } from '../src/ui/renderer.js';

export default suite('Sistemas', (t) => {
  // ------------------------------------------------------------- mundo

  t('el mundo tiene más de 100 clubes y 16 selecciones', () => {
    const w = generateWorld('pruebas');
    check(w.allClubIds.length >= 100, `sólo hay ${w.allClubIds.length} clubes`);
    check(Object.keys(w.nationalTeams).length === 16, 'deberían ser 16 selecciones');
  });

  t('la misma semilla genera el mismo mundo', () => {
    const a = generateWorld('igual');
    const b = generateWorld('igual');
    check(a.clubs[a.allClubIds[7]].name === b.clubs[b.allClubIds[7]].name, 'los nombres deberían coincidir');
    check(a.clubs[a.allClubIds[7]].squad[3].pace === b.clubs[b.allClubIds[7]].squad[3].pace,
      'los atributos deberían coincidir');
  });

  t('semillas distintas generan mundos distintos', () => {
    const a = generateWorld('uno');
    const b = generateWorld('dos');
    check(a.clubs[a.allClubIds[0]].name !== b.clubs[b.allClubIds[0]].name, 'deberían diferir');
  });

  t('cada club tiene plantilla completa y entrenador', () => {
    const w = generateWorld('plantillas');
    for (const id of w.allClubIds.slice(0, 25)) {
      const c = w.clubs[id];
      check(c.squad.length >= 22, `${c.name} tiene ${c.squad.length} jugadores`);
      check(c.squad.filter((p) => p.role === 'GK').length >= 2, `${c.name} necesita porteros`);
      check(!!c.coach && !!c.coach.trait, `${c.name} sin entrenador`);
      check(!!c.stadium.name, `${c.name} sin estadio`);
    }
  });

  t('todas las divisiones con clubes se pueden poblar', () => {
    const w = generateWorld('divisiones');
    for (const d of DIVISIONS) {
      const clubs = clubsOfDivision(w, d.id);
      check(clubs.length >= 2, `${d.id} no tiene equipos suficientes`);
    }
  });

  // ------------------------------------------------------- equipaciones

  t('local y visitante siempre se distinguen', () => {
    const w = generateWorld('kits');
    const div = w.divisions.find((d) => d.id === 'primera');
    const clubs = div.clubIds.map((id) => w.clubs[id]);
    const ref = createReferee({ seed: 'k' });
    let worst = Infinity;
    for (let i = 0; i < clubs.length; i++) {
      for (let j = 0; j < clubs.length; j++) {
        if (i === j) continue;
        const m = createMatch({
          home: clubs[i], away: clubs[j], competition: div, seed: i * 31 + j,
          difficulty: DIFFICULTY.normal, referee: ref,
        });
        worst = Math.min(worst, colorDistance(m.kits[0].primary, m.kits[1].primary));
      }
    }
    check(worst >= 200, `el peor contraste entre equipaciones es ${worst.toFixed(0)}`);
  });

  // ------------------------------------------------------------ idiomas

  t('inglés y español tienen exactamente las mismas claves', () => {
    const esKeys = Object.keys(es).sort();
    const enKeys = Object.keys(en).sort();
    const faltanEn = esKeys.filter((k) => !(k in en));
    const faltanEs = enKeys.filter((k) => !(k in es));
    check(faltanEn.length === 0, `faltan en inglés: ${faltanEn.slice(0, 8).join(', ')}`);
    check(faltanEs.length === 0, `faltan en español: ${faltanEs.slice(0, 8).join(', ')}`);
  });

  t('ninguna traducción está vacía', () => {
    for (const [bundle, name] of [[es, 'es'], [en, 'en']]) {
      for (const [k, v] of Object.entries(bundle)) {
        const empty = Array.isArray(v) ? v.some((x) => !x || !x.trim()) : !String(v).trim();
        check(!empty, `clave vacía en ${name}: ${k}`);
      }
    }
  });

  t('los textos con variables las declaran en los dos idiomas', () => {
    const vars = (v) => (Array.isArray(v) ? v.join(' ') : String(v)).match(/\{(\w+)\}/g) || [];
    for (const k of Object.keys(es)) {
      if (!(k in en)) continue;
      const a = new Set(vars(es[k]));
      const b = new Set(vars(en[k]));
      for (const v of a) check(b.has(v), `${k}: falta ${v} en inglés`);
      for (const v of b) check(a.has(v), `${k}: falta ${v} en español`);
    }
  });

  t('la interfaz no usa claves inexistentes', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const files = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = `${dir}/${f}`;
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.js')) files.push(p);
      }
    };
    walk(new URL('../src', import.meta.url).pathname);

    // Los comentarios traen ejemplos como t('clave'): no cuentan
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const missing = new Set();
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      // Sólo claves literales: las dinámicas se comprueban a mano
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9._]+)'/g)) {
        const key = m[1];
        if (!(key in es)) missing.add(`${key} (${f.split('/').pop()})`);
      }
    }
    check(missing.size === 0, `claves sin traducción: ${[...missing].slice(0, 10).join(', ')}`);
  });

  t('todo módulo que traduce importa t()', async () => {
    // `career.js` llamaba a t() sin importarlo: la oferta de soborno reventaba
    // con «t is not defined» y se llevaba por delante la carrera. La prueba de
    // arriba no lo veía porque la clave sí existía; lo que faltaba era la
    // función. Esto cubre la clase entera de fallo.
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const files = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = `${dir}/${f}`;
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.js')) files.push(p);
      }
    };
    walk(new URL('../src', import.meta.url).pathname);

    const sinImportar = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (!/(^|[^\w.$'"])t\(/m.test(src)) continue;        // no traduce: nada que comprobar
      if (f.endsWith('i18n.js')) continue;                 // el propio módulo de i18n
      const importaT = /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][^'"]*i18n\.js['"]/.test(src);
      const defineT = /\b(?:const|let|var|function)\s+t\s*[=(]/.test(src);
      if (!importaT && !defineT) sinImportar.push(f.split('/').slice(-2).join('/'));
    }
    check(sinImportar.length === 0, `usan t() sin tenerlo: ${sinImportar.join(', ')}`);
  });

  t('la oferta de soborno se genera, se lee y se puede responder', () => {
    // Se fuerza el evento en vez de esperar a que salga por azar (~7%).
    const c = new Career({ worldSeed: 'etica' });
    c.referee.corruption = 40;
    let ev = null;
    for (let i = 0; i < 300 && !ev; i++) ev = c._maybeEthicsEvent(c.assignments[0]);
    check(!!ev, 'nunca se generó una oferta en 300 intentos');
    check(!!ev.textKey && (ev.textKey in es), `la oferta no trae clave traducible: ${ev.textKey}`);
    check(!ev.text, 'la lógica no debe guardar el texto ya traducido');
    check(typeof ev.amount === 'number' && ev.amount > 0, 'la oferta necesita una cantidad');

    // El texto se compone de verdad, con sus datos dentro
    const texto = traducir(ev.textKey, ev.textArgs || {});
    check(!texto.includes('{'), `quedaron huecos sin rellenar: ${texto}`);
    check(texto.includes(ev.textArgs.club), 'el texto no nombra al club que soborna');

    // Y las cuatro respuestas funcionan
    for (const choice of ['accept', 'refuse', 'report', 'ignore']) {
      const c2 = new Career({ worldSeed: 'etica2' });
      c2.pendingEthics = { ...ev };
      const res = c2.resolveEthics(choice);
      check(!!res && !!res.type, `la respuesta «${choice}» no devuelve resultado`);
    }
  });

  t('las claves construidas al vuelo existen en los dos idiomas', async () => {
    // La prueba anterior sólo ve `t('clave')` literal. Estas se arman con
    // plantillas (`t(\`kit.${id}\`)`), así que se comprueban desde los datos:
    // añadir un capítulo, un uniforme o un estilo sin texto falla aquí.
    const { KITS } = await import('../src/career/referee.js');
    const { STYLE_IDS } = await import('../src/data/formations.js');
    const { COACH_TRAITS } = await import('../src/data/generators.js');
    const { CHAPTERS } = await import('../src/career/syndicate.js');
    const { WEATHER } = await import('../src/core/config.js');

    const esperadas = [];
    for (const k of KITS) esperadas.push(`kit.${k.id}`);
    for (const s of STYLE_IDS) esperadas.push(`style.${s}`);
    for (const tr of COACH_TRAITS) esperadas.push(`trait.${tr}`);
    for (const w of Object.keys(WEATHER)) esperadas.push(`weather.${w}`);
    for (const ch of CHAPTERS) {
      esperadas.push(`syn.${ch.id}.text`);
      for (const o of ch.options) esperadas.push(`syn.${ch.id}.${o.id}`);
    }

    for (const key of esperadas) {
      for (const [bundle, lang] of [[es, 'es'], [en, 'en']]) {
        check(!!bundle[key], `falta ${key} en ${lang}`);
      }
    }
  });

  // ------------------------------------------------------------ carrera

  t('una carrera nueva arranca coherente', () => {
    const c = new Career({ worldSeed: 'carrera' });
    check(c.divisionId === 'regional', 'debería empezar en regional');
    check(c.assignments.length === 3, 'debería ofrecer tres designaciones');
    check(c.referee.money > 0, 'debería empezar con algo de dinero');
    for (const a of c.assignments) {
      check(a.homeId !== a.awayId, 'un equipo no puede jugar contra sí mismo');
      check(!!a.stadium && !!a.weather, 'la designación necesita estadio y clima');
    }
  });

  t('guardar y cargar conserva la carrera', () => {
    const c = new Career({ worldSeed: 'guardado', mode: 'syndicate' });
    c.referee.money = 4321;
    c.referee.reputation = 55;
    c.buy('kit');
    c.academy.examLevel = 2;
    c.syndicate.chapter = 2;
    c.syndicate.flags.contacted = true;
    c.advanceRound();

    const data = JSON.parse(JSON.stringify(c.serialize()));
    const back = Career.deserialize(data);

    check(back.referee.money === c.referee.money, 'el dinero no coincide');
    check(back.referee.name === c.referee.name, 'el nombre no coincide');
    check(back.round === c.round && back.season === c.season, 'la jornada no coincide');
    check(back.owns('kit') === true, 'las compras no se conservan');
    check(back.academy.examLevel === 2, 'la titulación no se conserva');
    check(back.syndicate.chapter === 2 && back.syndicate.flags.contacted, 'la trama no se conserva');
    check(back.mode === 'syndicate', 'el modo no se conserva');
  });

  t('la experiencia sube de nivel de forma progresiva', () => {
    const ref = createReferee({ seed: 'xp' });
    const nivelesPrimero = addExperience(ref, 200).length;
    const nivelInicial = ref.level;
    addExperience(ref, 200);
    check(nivelesPrimero >= 1, 'debería subir al menos un nivel');
    check(ref.level > nivelInicial, 'debería seguir subiendo');
    check(ref.experience >= 0, 'la experiencia no puede quedar negativa');
  });

  t('entrenar cuesta más cuanto mejor eres', () => {
    const novato = createReferee({ seed: 'a', stats: { accuracy: 20 } });
    const veterano = createReferee({ seed: 'b', stats: { accuracy: 92 } });
    const g1 = trainStat(novato, 'accuracy', 2);
    const g2 = trainStat(veterano, 'accuracy', 2);
    check(g1 > g2, `el novato debería mejorar más (${g1} vs ${g2})`);
    check(veterano.stats.accuracy <= 99, 'no puede pasar de 99');
  });

  // ----------------------------------------------------------- economía

  t('las compras descuentan dinero y tienen efecto', () => {
    const c = new Career({ worldSeed: 'eco' });
    c.referee.money = 50000;
    const reglasAntes = c.referee.stats.rules;
    const res = c.buy('course');
    check(res.ok === true, 'la compra debería completarse');
    check(c.referee.money === 50000 - 1600, 'el dinero no se descontó bien');
    check(c.referee.stats.rules > reglasAntes, 'el curso debería subir el conocimiento de reglas');
    check(c.buy('course').ok === false, 'no se puede comprar dos veces');
  });

  t('no se puede comprar sin dinero', () => {
    const c = new Career({ worldSeed: 'eco2' });
    c.referee.money = 10;
    const res = c.buy('home');
    check(res.ok === false && res.reason === 'money', 'debería rechazarse por dinero');
    check(c.referee.money === 10, 'no debería descontar nada');
  });

  t('el gasto por jornada crece con la categoría', () => {
    const bajo = new Career({ worldSeed: 'e3', divisionId: 'regional' });
    const alto = new Career({ worldSeed: 'e4', divisionId: 'primera' });
    check(alto.livingCost() > bajo.livingCost(), 'arriba debería costar más vivir');
  });

  t('el mantenimiento se suma al gasto fijo', () => {
    const c = new Career({ worldSeed: 'e5' });
    const antes = c.livingCost();
    c.referee.money = 50000;
    c.buy('home');
    check(c.livingCost() > antes, 'el piso debería añadir mantenimiento');
  });

  t('los bienes cambian de verdad la recuperación', () => {
    const sin = new Career({ worldSeed: 'e6' });
    const con = new Career({ worldSeed: 'e6' });
    con.referee.money = 50000;
    con.buy('gym');
    sin.fatigue = 60; con.fatigue = 60;
    sin.advanceRound(); con.advanceRound();
    check(con.fatigue < sin.fatigue, `el gimnasio debería recuperar más (${con.fatigue} vs ${sin.fatigue})`);
  });

  // ------------------------------------------------------------ academia

  t('el examen baraja las opciones y corrige bien', () => {
    const c = new Career({ worldSeed: 'examen' });
    const ex = c.academy.startExam(null, 6);
    check(ex.questions.length === 6, 'debería haber seis preguntas');
    let posiciones = new Set();
    for (const q of ex.questions) {
      check(q.options.length >= 2, 'cada pregunta necesita opciones');
      check(q.correct >= 0 && q.correct < q.options.length, 'el índice correcto está fuera de rango');
      check(!!q.why, 'toda pregunta debe explicar el porqué');
      posiciones.add(q.correct);
    }
    check(posiciones.size > 1, 'la respuesta correcta no puede caer siempre en el mismo sitio');

    for (const q of ex.questions) c.academy.answer(q.correct);
    const res = c.academy.finishExam();
    check(res.passed === true && res.perfect === true, 'contestando bien debería aprobar');
    check(res.examLevel >= 1, 'debería subir la titulación');
  });

  t('el banco de preguntas está completo en los dos idiomas', () => {
    for (const q of QUESTIONS) {
      for (const loc of ['es', 'en']) {
        const body = q[loc];
        check(!!body, `pregunta ${q.topic} sin ${loc}`);
        check(body.options.length >= 3, 'necesita al menos tres opciones');
        check(body.correct >= 0 && body.correct < body.options.length, 'índice correcto inválido');
        check(!!body.why && body.why.length > 20, 'la explicación es demasiado corta');
      }
      check(q.es.options.length === q.en.options.length, 'las opciones deben coincidir en número');
    }
  });

  // -------------------------------------------------------------- varios

  t('todos los logros tienen nombre y descripción en los dos idiomas', () => {
    check(ACHIEVEMENT_IDS.length >= 20, 'deberían ser al menos veinte');
    check(new Set(ACHIEVEMENT_IDS).size === ACHIEVEMENT_IDS.length, 'hay identificadores repetidos');
    for (const id of ACHIEVEMENT_IDS) {
      for (const [bundle, lang] of [[es, 'es'], [en, 'en']]) {
        check(!!bundle[`ach.${id}.name`], `falta ach.${id}.name en ${lang}`);
        check(!!bundle[`ach.${id}.desc`], `falta ach.${id}.desc en ${lang}`);
      }
    }
  });

  t('los escenarios están bien definidos', () => {
    const all = allSpecials();
    check(all.length >= 8, 'deberían ser al menos ocho');
    for (const s of all) {
      check(!!s.name && !!s.desc && !!s.goal, `escenario incompleto: ${s.id}`);
      between(s.targetRating, 1, 10, `objetivo fuera de rango en ${s.id}`);
      check(DIVISIONS.some((d) => d.id === s.divisionId), `división desconocida en ${s.id}`);
    }
  });

  t('el generador aleatorio es reproducible y está bien repartido', () => {
    const a = new RNG('semilla'); const b = new RNG('semilla');
    for (let i = 0; i < 50; i++) check(a.next() === b.next(), 'la secuencia debería repetirse');
    const r = new RNG('reparto');
    let suma = 0; const N = 20000;
    const cubos = new Array(10).fill(0);
    for (let i = 0; i < N; i++) { const v = r.next(); suma += v; cubos[Math.floor(v * 10)]++; }
    between(suma / N, 0.47, 0.53, 'la media debería rondar 0,5');
    for (const c of cubos) between(c / N, 0.07, 0.13, 'el reparto por décimas está sesgado');
  });

  // -------------------------------------------------------- animación

  // El renderizador necesita un lienzo, que aquí no existe: se prueba la
  // parte que no dibuja (fases, efectos y su caducidad) sobre una instancia
  // desnuda y un contexto de mentira.
  const bareRenderer = () => {
    const r = Object.create(Renderer.prototype);
    r.anim = new Map(); r.cards = []; r.rings = []; r.confetti = [];
    r.time = 0; r.motion = 1;
    r.worldToScreen = () => [0, 0];
    return r;
  };
  const fakeCtx = () => new Proxy({}, {
    get: (o, k) => (k === 'canvas' ? {} : (o[k] !== undefined ? o[k] : () => {})),
    set: (o, k, v) => { o[k] = v; return true; },
  });

  t('cada jugador corre con su propia fase: no marchan al unísono', () => {
    const r = bareRenderer();
    const fases = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5'].map((id) => r._animOf(id).phase);
    check(new Set(fases).size === fases.length, 'las fases iniciales se repiten');
    check(r._animOf('p-1').phase === fases[0], 'la fase de un jugador debería ser estable');
  });

  t('los efectos del campo caducan solos', () => {
    const r = bareRenderer();
    const ctx = fakeCtx();
    r.showCard({ x: 20, y: 30 }, 'yellow');
    r.whistle({ x: 20, y: 30 });
    r.burst(0);
    check(r.cards.length === 1 && r.rings.length === 1 && r.confetti.length > 0, 'no se han creado');
    for (let i = 0; i < 400; i++) r.drawEffects(ctx, 6, { x: 52, y: 34 }, 1 / 30);
    check(r.cards.length === 0, 'la tarjeta se queda pegada en pantalla');
    check(r.rings.length === 0, 'la onda del silbato no se apaga');
    check(r.confetti.length === 0, 'los papelillos no desaparecen');
  });

  // ---------------------------------------------------------- sin conexión

  t('el service worker cachea exactamente los ficheros del juego', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const root = new URL('../', import.meta.url).pathname;

    // La lista vive en sw.js como literal: se lee del fichero para no
    // obligar al service worker a ser un módulo.
    const src = readFileSync(`${root}sw.js`, 'utf8');
    const block = src.match(/const SHELL = \[([\s\S]*?)\];/);
    check(!!block, 'no se encuentra la lista SHELL en sw.js');
    const listed = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

    // Lo que de verdad necesita el navegador para arrancar el juego
    const needed = new Set(['./', 'index.html', 'manifest.webmanifest', 'icon.svg']);
    const walk = (dir, prefix) => {
      for (const f of readdirSync(`${root}${dir}`)) {
        const rel = `${dir}/${f}`;
        if (statSync(`${root}${rel}`).isDirectory()) walk(rel, prefix);
        else if (f.endsWith('.js') || f.endsWith('.css')) needed.add(rel);
      }
    };
    walk('src'); walk('styles'); walk('i18n');

    const faltan = [...needed].filter((f) => !listed.has(f));
    const sobran = [...listed].filter((f) => !needed.has(f));
    check(faltan.length === 0, `sin cachear (el juego no abriría sin conexión): ${faltan.join(', ')}`);
    check(sobran.length === 0, `en la caché pero ya no existen: ${sobran.join(', ')}`);
  });

  t('con movimiento reducido no se lanzan partículas', () => {
    const r = bareRenderer();
    r.motion = 0;
    r.burst(0);
    check(r.confetti.length === 0, 'debería respetarse prefers-reduced-motion');
  });

  t('el juego se empaqueta en un solo fichero', async () => {
    // La versión de un solo fichero es la que se reparte para jugar sin
    // servidor. Si alguien añade un módulo con una dependencia circular, o dos
    // módulos exportan lo mismo, el empaquetado deja de construirse: mejor que
    // falle aquí que descubrirlo con el fichero ya repartido.
    const { execFileSync } = await import('child_process');
    const { readFileSync, existsSync, unlinkSync } = await import('fs');
    const raiz = new URL('..', import.meta.url).pathname;
    const salida = `${raiz}silbato-cero.html`;
    const habia = existsSync(salida);

    try {
      execFileSync(process.execPath, [`${raiz}tools/bundle.mjs`], { cwd: raiz, stdio: 'pipe' });
    } catch (e) {
      // El empaquetador aborta con un motivo claro (ciclo, nombre repetido,
      // import que no existe): que se lea como fallo de prueba, no como
      // excepción que se lleva por delante la suite entera.
      const motivo = String(e.stderr || e.message).split('\n').find((l) => l.startsWith('Error:')) || e.message;
      check(false, `no se pudo empaquetar: ${motivo.trim()}`);
    }
    const html = readFileSync(salida, 'utf8');

    check(html.length > 200000, `el fichero salió demasiado corto: ${html.length} bytes`);
    check(html.includes('__m("src/main.js")'), 'el empaquetado no arranca el juego');
    check(!/from\s+['"]\.\.?\//.test(html), 'quedaron imports relativos sin resolver');
    check(!/<script[^>]+src=/.test(html), 'quedó un guion externo: no funcionaría suelto');
    check(!/<link[^>]+stylesheet/.test(html), 'quedó una hoja de estilos externa');
    for (const m of ['ruleEngine', 'matchEngine', 'autoReferee', 'generators']) {
      check(html.includes(`src/`) && html.includes(m), `falta ${m} en el empaquetado`);
    }
    if (!habia) unlinkSync(salida);
  });
});
