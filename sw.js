// Service worker: hace que el juego se pueda jugar sin conexión.
//
// No hay compilación, así que la lista del casco de la aplicación se escribe
// a mano. Para que no se quede desfasada al añadir un módulo, hay una prueba
// (`test/systems.test.js`) que compara esta lista con los ficheros del disco
// y falla si sobra o falta alguno.

const VERSION = 'silbato-v1';

// (Se declara sin `export` a propósito: así el fichero sigue siendo un script
// clásico y lo admite cualquier navegador con service workers, no sólo los
// que soportan workers de tipo módulo.)
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'styles/tokens.css',
  'styles/main.css',
  'i18n/es.js',
  'i18n/en.js',
  'src/main.js',
  'src/game.js',
  'src/ai/autoReferee.js',
  'src/audio/audio.js',
  'src/career/academy.js',
  'src/career/achievements.js',
  'src/career/career.js',
  'src/career/press.js',
  'src/career/referee.js',
  'src/career/syndicate.js',
  'src/core/config.js',
  'src/core/events.js',
  'src/core/i18n.js',
  'src/core/rng.js',
  'src/core/save.js',
  'src/data/examQuestions.js',
  'src/data/formations.js',
  'src/data/generators.js',
  'src/data/names.js',
  'src/data/scenarios.js',
  'src/match/assistants.js',
  'src/match/incidents.js',
  'src/match/matchEngine.js',
  'src/match/offBall.js',
  'src/match/rating.js',
  'src/match/sim.js',
  'src/match/state.js',
  'src/match/var.js',
  'src/rules/ruleEngine.js',
  'src/ui/hud.js',
  'src/ui/renderer.js',
  'src/ui/screens.js',
];

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && 'caches' in self) {
  self.addEventListener('install', (e) => {
    e.waitUntil((async () => {
      const cache = await caches.open(VERSION);
      // Uno a uno: si un fichero falla, no se cae la instalación entera
      await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})));
      await self.skipWaiting();
    })());
  });

  self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
      for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
      await self.clients.claim();
    })());
  });

  // Servir desde caché y refrescar por detrás: se juega al instante y sin
  // conexión, y la siguiente carga ya trae los cambios.
  self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await net) || new Response('', { status: 504 });
    })());
  });
}
