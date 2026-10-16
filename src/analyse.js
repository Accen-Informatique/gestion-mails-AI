// Analyse d'un mail : essaie les moteurs dans l'ordre (AI_ENGINES) jusqu'à ce que l'un réponde.
// Ex. : Claude → moteur gratuit → règles par mots-clés.
import { config } from './config.js';
import { normaliser } from './schema.js';
import * as claude from './moteurs/claude.js';
import * as gratuit from './moteurs/gratuit.js';
import * as regles from './moteurs/regles.js';

const tous = { claude, gratuit, regles };
const log = (...a) => console.log(new Date().toISOString(), ...a);

const inconnus = config.ia.moteurs.filter(n => !tous[n]);
if (inconnus.length) throw new Error(`AI_ENGINES : moteur inconnu « ${inconnus.join(', ')} » (claude, gratuit, regles)`);

// Moteur -> date jusqu'à laquelle il est mis de côté (crédit épuisé, clé refusée…)
const enPause = new Map();

export function moteursActifs() {
  return config.ia.moteurs.map(n => tous[n]).filter(m => m.disponible());
}

export async function analyserMail(mail) {
  const moteurs = moteursActifs();
  if (!moteurs.length) throw new Error('Aucun moteur d’analyse configuré (voir AI_ENGINES)');

  const erreurs = [];
  for (const moteur of moteurs) {
    if ((enPause.get(moteur.nom) || 0) > Date.now()) continue;
    try {
      const analyse = normaliser(await moteur.analyser(mail));
      return { ...analyse, moteur: moteur.nom };
    } catch (e) {
      erreurs.push(e.message);
      if (e.bloquant) {
        enPause.set(moteur.nom, Date.now() + config.ia.pauseMinutes * 60_000);
        log(`Moteur « ${moteur.nom} » mis en pause ${config.ia.pauseMinutes} min : ${e.message}`);
      } else {
        log(`Moteur « ${moteur.nom} » en échec, moteur suivant : ${e.message}`);
      }
    }
  }
  throw new Error(`Aucun moteur n'a pu analyser le mail — ${erreurs.join(' | ') || 'tous en pause'}`);
}

// Pour --check : teste chaque moteur séparément
export async function testerMoteurs(mail) {
  for (const moteur of moteursActifs()) {
    try {
      const a = normaliser(await moteur.analyser(mail));
      log(`Moteur « ${moteur.nom} » OK — catégorie proposée : ${a.categorie}`);
    } catch (e) {
      log(`Moteur « ${moteur.nom} » EN ÉCHEC : ${e.message}`);
    }
  }
  const ignores = config.ia.moteurs.filter(n => !tous[n].disponible());
  if (ignores.length) log(`Moteur(s) non configuré(s), ignoré(s) : ${ignores.join(', ')}`);
}
