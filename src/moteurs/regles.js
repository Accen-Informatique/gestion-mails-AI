// Moteur « règles » : tri par mots-clés, sans IA. Gratuit et toujours disponible.
// Dernier recours : pas de brouillon de réponse, résumé = début du mail.
// Les mots-clés ci-dessous seront remplacés par tes propres règles de tri.

export const nom = 'regles';
export const disponible = () => true;

// Première règle qui correspond (objet + corps, sans accents ni majuscules) = catégorie retenue
const CATEGORIES = [
  { categorie: 'Facturation', mots: ['facture', 'avoir', 'paiement', 'reglement', 'relance', 'impaye', 'virement', 'echeance'] },
  { categorie: 'Commercial', mots: ['devis', 'tarif', 'tarifs', 'prix', 'commande', 'proposition', 'disponibilite'] },
  { categorie: 'SAV', mots: ['panne', 'ne fonctionne', 'ne marche', 'erreur', 'bloque', 'probleme', 'reparation', 'sav', 'casse', 'bug'] },
];

const URGENT = ['urgent', 'urgente', 'urgence', 'bloquant', 'bloquante', 'asap', 'immediatement', 'au plus vite', 'en panne'];
// Début de l'adresse : no-reply@…, no-reply-c9aW6…@…, notifications@…
const EXPEDITEURS_AUTO = /^(no-?reply|do-?not-?reply|ne-?pas-?repondre|notifications?|newsletter|mailer-daemon|postmaster)\b/i;

const sansAccents = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Mot ou expression entière (« sav » ne correspond pas à « savoir »)
const contient = (texte, mot) => new RegExp(`(^|[^a-z0-9])${mot}([^a-z0-9]|$)`).test(texte);

export async function analyser(mail) {
  const texte = sansAccents(`${mail.objet}\n${mail.corps}`);
  const automatique = mail.automatique || EXPEDITEURS_AUTO.test(mail.expediteurEmail);

  let categorie = 'Autre';
  if (automatique) categorie = 'Notification automatique';
  else {
    const regle = CATEGORIES.find(r => r.mots.some(m => contient(texte, m)));
    if (regle) categorie = regle.categorie;
  }

  const urgent = !automatique && URGENT.some(m => contient(texte, m));
  const priorite = automatique ? 'Basse' : urgent ? 'Urgente' : 'Normale';

  const extrait = mail.corps.replace(/\s+/g, ' ').trim().slice(0, 400);

  return {
    categorie,
    priorite,
    justification_priorite: automatique
      ? 'Envoi automatique.'
      : urgent ? 'Mot-clé d’urgence repéré dans le mail.' : 'Priorité par défaut (analyse sans IA).',
    resume: `${mail.objet} — ${extrait}${mail.corps.length > 400 ? '…' : ''}`,
    action_a_faire: automatique ? 'Aucune action' : 'À lire et qualifier (analysé sans IA)',
    societe: '',
    telephone: trouverTelephone(mail.corps),
    reponse_necessaire: false,
    brouillon_reponse: '',
  };
}

// Numéro français (fixe ou mobile, avec ou sans +33)
function trouverTelephone(texte) {
  const m = texte.match(/(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/);
  return m ? m[0] : '';
}
