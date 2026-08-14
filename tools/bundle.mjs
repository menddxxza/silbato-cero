// Empaqueta el juego entero en un solo fichero HTML.
//
// Para qué: el juego normal son 32 módulos ES sueltos y necesita un servidor
// HTTP para abrirse. Este empaquetado produce un `silbato-cero.html` que se
// abre haciendo doble clic —sin servidor, sin conexión y sin instalar nada— y
// que se puede mandar por correo o guardar en un pendrive.
//
// Cómo: cada módulo se envuelve en una función que devuelve sus exportaciones,
// y los `import` se convierten en desestructuraciones de esa función. Así cada
// módulo conserva su propio ámbito: el primer intento metía todo en un ámbito
// común y dos módulos declaraban `L`, que habría dado un juego roto en
// silencio. El orden de evaluación se calcula por dependencias.
//
//   node tools/bundle.mjs
//
// La versión servida por HTTP sigue siendo la principal: ésta es para repartir.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => readFileSync(resolve(raiz, p), 'utf8');

// ---------------------------------------------------------------- módulos

const modulos = [];
const walk = (dir) => {
  for (const f of readdirSync(resolve(raiz, dir)).sort()) {
    const rel = `${dir}/${f}`;
    if (statSync(resolve(raiz, rel)).isDirectory()) walk(rel);
    else if (f.endsWith('.js')) modulos.push(rel);
  }
};
walk('src');
walk('i18n');

// `import ... from '...'`, en una o varias líneas
const RE_IMPORT = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;

const resolver = (desde, spec) =>
  relative(raiz, resolve(raiz, dirname(desde), spec)).replace(/\\/g, '/');

const fuente = new Map();
const deps = new Map();
for (const m of modulos) {
  const src = leer(m);
  fuente.set(m, src);
  deps.set(m, [...src.matchAll(RE_IMPORT)]
    .filter(([, , spec]) => spec.startsWith('.'))
    .map(([, , spec]) => resolver(m, spec)));
}

// ------------------------------------------------------- orden topológico

const orden = [];
const estado = new Map();
const visitar = (m, pila = []) => {
  if (estado.get(m) === 'listo') return;
  if (estado.get(m) === 'viendo') throw new Error(`ciclo: ${[...pila, m].join(' → ')}`);
  estado.set(m, 'viendo');
  for (const d of deps.get(m) || []) {
    if (!fuente.has(d)) throw new Error(`${m} importa ${d}, que no existe`);
    visitar(d, [...pila, m]);
  }
  estado.set(m, 'listo');
  orden.push(m);
};
for (const m of modulos) visitar(m);

// ------------------------------------------------- exportaciones y cuerpo

/** Nombres que exporta un módulo, y su cuerpo ya sin las palabras `export`. */
function transformar(ruta, src) {
  const exports = new Set();
  let porDefecto = null;

  // import → desestructuración del módulo ya evaluado
  let out = src.replace(RE_IMPORT, (linea, clausula, spec) => {
    if (!spec.startsWith('.')) return linea;                 // no debería haber
    const destino = JSON.stringify(resolver(ruta, spec));
    const c = clausula.trim();
    const conLlaves = c.match(/^([A-Za-z_$][\w$]*)\s*,\s*(\{[\s\S]*\})$/);
    if (conLlaves) {                                          // `X, { a, b }`
      return `const ${conLlaves[2].replace(/\s+/g, ' ')} = __m(${destino});\n`
        + `const ${conLlaves[1]} = __m(${destino}).default;`;
    }
    if (c.startsWith('{')) return `const ${c.replace(/\s+/g, ' ')} = __m(${destino});`;
    return `const ${c} = __m(${destino}).default;`;           // sólo por defecto
  });

  // export { a, b };
  out = out.replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (l, lista) => {
    for (const n of lista.split(',')) {
      const nombre = n.split(/\s+as\s+/).pop().trim();
      if (nombre) exports.add(nombre);
    }
    return '';
  });

  // export default <expresión>;
  out = out.replace(/^export\s+default\s+([\s\S]*?);[ \t]*$/gm, (l, expr) => {
    porDefecto = expr.trim();
    return '';
  });

  // export const/let/var/function/class/async function
  out = out.replace(/^export\s+(const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/gm,
    (l, tipo, nombre) => { exports.add(nombre); return `${tipo} ${nombre}`; });

  // export const { a } = ... (desestructurado)
  out = out.replace(/^export\s+(const|let|var)\s+(?=[[{])/gm, '$1 ');

  return { cuerpo: out.trim(), exports: [...exports], porDefecto };
}

const trozos = [];
for (const m of orden) {
  const { cuerpo, exports, porDefecto } = transformar(m, fuente.get(m));
  const devuelve = [
    ...exports.map((n) => `${n}`),
    ...(porDefecto ? [`default: ${porDefecto}`] : []),
  ];
  trozos.push(
    `__def(${JSON.stringify(m)}, () => {\n${cuerpo}\nreturn { ${devuelve.join(', ')} };\n});`,
  );
}

// ------------------------------------------------------------------ HTML

const arranque = `
// Registro de módulos: cada uno se evalúa una vez, la primera que se pide.
const __fab = {}; const __cache = {};
const __def = (id, f) => { __fab[id] = f; };
const __m = (id) => {
  if (!(id in __cache)) {
    if (!__fab[id]) throw new Error('módulo no empaquetado: ' + id);
    __cache[id] = __fab[id]();
  }
  return __cache[id];
};
`;

// Los módulos se registran en orden de dependencias y el último es el arranque
const entrada = orden.includes('src/main.js') ? 'src/main.js' : orden[orden.length - 1];

let html = leer('index.html');
const css = ['styles/tokens.css', 'styles/main.css'].map(leer).join('\n');

html = html
  .replace(/<link[^>]+rel="stylesheet"[^>]*>/g, '')
  .replace(/<script[^>]+type="module"[^>]*><\/script>/g, '')
  .replace(/<link[^>]+rel="manifest"[^>]*>/g, '')   // no hay service worker: ya está todo dentro
  .replace('</head>', `<style>\n${css}\n</style>\n</head>`)
  .replace('</body>',
    `<script type="module">\n${arranque}\n${trozos.join('\n')}\n__m(${JSON.stringify(entrada)});\n</script>\n</body>`);

const salida = resolve(raiz, 'silbato-cero.html');
writeFileSync(salida, html);
console.log(`✔ ${orden.length} módulos → silbato-cero.html (${Math.round(html.length / 1024)} KB)`);

// Variante para incrustar en una página que ya trae su propio esqueleto
// (`<!doctype>`, `<head>`, `<body>`): sólo el título, los estilos, el marcado
// del juego y el guion.
if (process.argv.includes('--incrustable')) {
  const cuerpoHtml = leer('index.html')
    .replace(/[\s\S]*<body>/, '')
    .replace(/<\/body>[\s\S]*/, '')
    .replace(/<script[^>]*><\/script>/g, '');
  const trozo = `<title>Silbato Cero</title>\n<style>\n${css}\n</style>\n${cuerpoHtml}\n`
    + `<script type="module">\n${arranque}\n${trozos.join('\n')}\n__m(${JSON.stringify(entrada)});\n</script>\n`;
  const p2 = resolve(raiz, 'silbato-cero.incrustable.html');
  writeFileSync(p2, trozo);
  console.log(`✔ variante incrustable (${Math.round(trozo.length / 1024)} KB)`);
}
