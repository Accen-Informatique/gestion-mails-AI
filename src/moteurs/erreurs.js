// Erreur d'un moteur d'analyse.
// bloquant = le moteur ne pourra pas répondre avant un moment (crédit épuisé, clé refusée,
// quota atteint) : il est alors mis de côté pendant AI_PAUSE_MINUTES.
export class ErreurMoteur extends Error {
  constructor(message, { bloquant = false } = {}) {
    super(message);
    this.bloquant = bloquant;
  }
}
