// Marcaje con tiempo de reacción.
//
// El motor tenía un problema de fondo que costó cuatro intentos encontrar: los
// defensores marcaban la posición **exacta** del atacante en cada fotograma.
// Un marcaje así es clarividente —reacciona antes de que el otro se mueva—, y
// con él ningún desmarque puede ganar un metro. De ahí salían tres síntomas
// que parecían independientes: casi ningún fuera de juego (2,5 por partido
// frente a los 3-5 reales), pocas faltas y ningún balón que llegara a la
// espalda de la defensa.
//
// Los tres intentos de arreglarlo por arriba —desmarques sueltos, peso al
// corredor en la elección del pase, balón al hueco coordinado— fracasaron y
// están documentados en NOTAS-DESARROLLO.md. También se probó un sistema
// completo de papeles sin balón (atacar la espalda, ofrecerse al pie, dar
// amplitud, desdoblarse) y resultó ser el problema y no la solución: costaba
// un 20% de los tiros. Lo que hacía falta era sólo esto.

const PASOS_POR_SEGUNDO = 30;   // el paso fijo de la simulación
const HISTORIA = 20;            // ~0,66 s, de sobra para el retardo máximo

/**
 * Cuánto tarda un defensor en reaccionar al movimiento de su par, en
 * segundos. Entre 0,22 s para el que mejor se coloca y 0,50 s para el peor:
 * es la diferencia entre leer la jugada e ir a remolque.
 */
export function reactionDelay(defender) {
  return 0.5 - (defender.player.positioning / 100) * 0.28;
}

/** Guarda la posición de este fotograma. */
export function recordHistory(e) {
  if (!e.hist) e.hist = [];
  e.hist.push({ x: e.pos.x, y: e.pos.y });
  if (e.hist.length > HISTORIA) e.hist.shift();
}

/** Dónde estaba un jugador hace `retraso` segundos. */
export function posHace(e, retraso) {
  const h = e.hist;
  if (!h || !h.length) return e.pos;
  const pasos = Math.min(h.length - 1, Math.max(0, Math.round(retraso * PASOS_POR_SEGUNDO)));
  return h[h.length - 1 - pasos] || e.pos;
}

export default { reactionDelay, recordHistory, posHace };
