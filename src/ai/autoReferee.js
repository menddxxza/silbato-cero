// Árbitro automático: resuelve incidentes sin jugador humano.
// Se usa para pruebas, para el tutorial y para simular partidos de fondo.

import { clamp } from '../core/rng.js';

/**
 * @param {object} opts - { skill 0..100, bias, rng }
 * @returns {function} (incident, options, match, ctx) -> payload
 */
export function makeAutoReferee(opts = {}) {
  const skill = clamp(opts.skill ?? 65, 5, 99) / 100;
  const rng = opts.rng;

  const doubt = () => (rng ? rng.next() : Math.random());

  // Lo que el árbitro ve depende sobre todo de la jugada; su nivel decide en
  // las dudosas. Con el modelo anterior el nivel pesaba igual en todas, así
  // que un árbitro decente fallaba una falta clarísima de cada tres.
  const roll = (clarity) => {
    const p = clamp(0.23 + clarity * 0.46 + skill * 0.26, 0.05, 0.98);
    return (rng ? rng.next() : Math.random()) < p;
  };

  return function autoReferee(inc, options, match, ctx = {}) {
    const truth = inc.truth || {};

    if (ctx.cardPhase) {
      // La tarjeta no es una tirada a ciegas como la del instante de la
      // entrada: para llegar aquí el árbitro ya ha pitado, ha parado el juego
      // y se ha acercado al jugador, así que juzga con más información.
      const need = truth.card || null;
      const juzgaBien = roll(Math.min(1, (inc.clarity ?? 0.7) + 0.3));
      return { card: juzgaBien ? need : (need === 'red' ? 'yellow' : null) };
    }

    const sees = roll(inc.clarity ?? 0.7);

    switch (inc.type) {
      case 'challenge':
      case 'penaltyShout': {
        if (truth.simulation) return sees ? { action: 'dive', card: 'yellow' } : { action: 'playon' };
        if (!truth.isFoul) {
          if (sees) return { action: 'playon' };
          // Equivocarse no es lo mismo que inventarse un penalti. Ante la duda
          // dentro del área el árbitro deja seguir; sólo a veces compra la
          // protesta. Fuera del área el coste del error es mucho menor.
          if (!inc.inBox) return { action: 'foul' };
          return doubt() < 0.28 ? { action: 'penalty' } : { action: 'playon' };
        }
        if (inc.inBox) return sees ? { action: 'penalty' } : { action: 'playon' };
        // Ventaja si procede
        if (sees && (inc.spa || inc.dogso === false) && match.possession === inc.victimSide
          && doubt() < 0.3) {
          return { action: 'advantage' };
        }
        return sees ? { action: 'foul' } : { action: 'playon' };
      }
      case 'handball': {
        const sanciona = sees ? truth.offence : !truth.offence;
        if (!sanciona) return { action: 'playon' };
        // Misma cautela: una mano dudosa en el área rara vez acaba en penalti
        if (inc.inBox && !truth.offence) {
          return doubt() < 0.28 ? { action: 'penalty' } : { action: 'playon' };
        }
        return { action: inc.inBox ? 'penalty' : 'handball' };
      }
      case 'offside':
        return (sees ? truth.offside : !truth.offside) ? { action: 'offside' } : { action: 'playon' };
      case 'outOfPlay': {
        const right = sees;
        const type = inc.truth.type;
        const toSide = right ? inc.truth.toSide : 1 - inc.truth.toSide;
        return { action: 'restart', restartType: type, toSide };
      }
      case 'goal':
        return (sees ? truth.goal : !truth.goal) ? { action: 'goal' } : { action: 'noGoal' };
      case 'dissent':
        return truth.card === 'yellow' && sees ? { action: 'card', card: 'yellow' } : { action: 'warning' };
      case 'timewasting':
        return truth.card === 'yellow' && sees ? { action: 'card', card: 'yellow' } : { action: 'warning' };
      case 'violence':
        return sees ? { action: 'card', card: 'red' } : { action: 'card', card: 'yellow' };
      case 'injury':
        return truth.stopPlay ? { action: 'medics' } : { action: 'playon' };
      case 'crowd':
        return { action: truth.protocol === 'stop' ? 'stop' : 'protocol' };
      default:
        return { action: 'playon' };
    }
  };
}

export default makeAutoReferee;
