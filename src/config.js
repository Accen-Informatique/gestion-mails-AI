// Configuration lue depuis les variables d'environnement (.env / docker-compose)

function requis(nom) {
  const v = process.env[nom];
  if (!v) throw new Error(`Variable d'environnement manquante : ${nom}`);
  return v;
}

function booleen(nom, defaut = false) {
  const v = process.env[nom];
  if (v === undefined || v === '') return defaut;
  return ['1', 'true', 'oui', 'yes'].includes(v.toLowerCase());
}

const dryRun = booleen('DRY_RUN', false);

export const config = {
  dryRun,

  // Fréquence de relève (minutes)
  intervalleMinutes: Number(process.env.POLL_INTERVAL_MINUTES || 5),

  imap: {
    host: requis('IMAP_HOST'),
    port: Number(process.env.IMAP_PORT || 993),
    secure: booleen('IMAP_SECURE', true),
    user: requis('IMAP_USER'),
    pass: requis('IMAP_PASSWORD'),
    dossier: process.env.IMAP_FOLDER || 'INBOX',
    // Mot-clé IMAP posé sur chaque mail traité, pour ne jamais le traiter deux fois
    motCleTraite: process.env.IMAP_PROCESSED_KEYWORD || 'TicketCree',
    // Si le serveur refuse les mots-clés personnalisés : déplacer dans ce dossier (optionnel)
    dossierTraites: process.env.IMAP_PROCESSED_FOLDER || '',
    // Ne traite que les mails reçus à partir de cette date (évite de traiter tout l'historique)
    depuis: process.env.PROCESS_SINCE || new Date().toISOString().slice(0, 10),
    // Dossier des brouillons ; vide = brouillon uniquement dans le ticket FileMaker
    dossierBrouillons: process.env.IMAP_DRAFTS_FOLDER || '',
    // Nombre maximum de mails traités par passage
    lotMax: Number(process.env.MAX_PER_RUN || 25),
  },

  claude: {
    apiKey: requis('ANTHROPIC_API_KEY'),
    modele: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
    // Contexte métier injecté dans l'analyse (qui tu es, ton activité, ton ton de réponse)
    contexte:
      process.env.BUSINESS_CONTEXT ||
      "Support de la société Accen (location de matériel, logiciel de gestion sous FileMaker). Les réponses sont en français, vouvoiement, ton professionnel et cordial.",
    // « \n » dans le .env est converti en vrai retour à la ligne
    signature: (process.env.REPLY_SIGNATURE || 'Cordialement,\\nLe support Accen').replace(/\\n/g, '\n'),
    categories: (process.env.CATEGORIES ||
      'SAV,Commercial,Facturation,Fournisseur,Administratif,Interne,Notification automatique,Spam')
      .split(',').map(s => s.trim()).filter(Boolean),
    tailleMaxCorps: Number(process.env.MAX_BODY_CHARS || 15000),
  },

  // Catégories pour lesquelles on ne crée pas de ticket (mail tout de même marqué comme traité)
  categoriesIgnorees: (process.env.SKIP_CATEGORIES || 'Spam')
    .split(',').map(s => s.trim()).filter(Boolean),

  filemaker: {
    host: dryRun ? process.env.FM_HOST || '' : requis('FM_HOST'), // ex : https://fm.accen.fr
    base: dryRun ? process.env.FM_DATABASE || '' : requis('FM_DATABASE'),
    layout: process.env.FM_LAYOUT || 'API_SAV_Mail',
    user: dryRun ? process.env.FM_USER || '' : requis('FM_USER'),
    pass: dryRun ? process.env.FM_PASSWORD || '' : requis('FM_PASSWORD'),
  },

  // Valeurs fixes posées sur chaque ticket créé depuis un mail
  ticket: {
    forme: process.env.TICKET_FORME || 'Mail entrant',
    statut: process.env.TICKET_STATUT || 'Ouvert',
    userInterne: process.env.TICKET_USER_INTERNE || '',
  },
};

// Correspondance entre les données du ticket et les rubriques de la table SAV.
// Mettre '' pour ne pas renseigner une rubrique.
export const rubriques = {
  // Rubriques existantes
  corps: 'commentaire',          // commentaire de départ = texte du mail
  telephone: 'telephone',        // numéro repéré dans la signature, si présent
  forme: 'forme',
  statut: 'statut',
  userInterne: 'user_interne',
  // Rubriques à ajouter
  messageId: 'mail_message_id',
  dateReception: 'mail_date_reception',
  expediteurNom: 'mail_expediteur_nom',
  expediteurEmail: 'mail_expediteur_email',
  objet: 'mail_objet',
  piecesJointes: 'mail_pieces_jointes',
  societeDetectee: 'ia_societe_detectee',
  categorie: 'ia_categorie',
  priorite: 'ia_priorite',
  justificationPriorite: 'ia_justification_priorite',
  resume: 'ia_resume',
  actionAFaire: 'ia_action',
  brouillonReponse: 'ia_brouillon_reponse',
};
