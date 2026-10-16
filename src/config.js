// Configuration lue depuis les variables d'environnement (fichier .env)
import './env.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

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

function liste(valeur) {
  return valeur.split(',').map(s => s.trim()).filter(Boolean);
}

// Date à partir de laquelle les mails sont traités.
// Sans PROCESS_SINCE, la date du tout premier démarrage est mémorisée dans data/etat.json :
// un redémarrage le lendemain ne fait donc pas « sauter » les mails de la nuit.
function dateDepuis() {
  if (process.env.PROCESS_SINCE) return process.env.PROCESS_SINCE;
  const dossier = new URL('../data/', import.meta.url);
  const fichier = new URL('etat.json', dossier);
  try {
    const etat = JSON.parse(readFileSync(fichier, 'utf8'));
    if (etat.depuis) return etat.depuis;
  } catch { /* premier démarrage */ }
  const aujourdhui = new Date().toISOString().slice(0, 10);
  mkdirSync(dossier, { recursive: true });
  writeFileSync(fichier, JSON.stringify({ depuis: aujourdhui }, null, 2));
  return aujourdhui;
}

// Source de recherche du client (modèle + rubriques), lue depuis PREFIXE_LAYOUT, PREFIXE_EMAIL_FIELDS…
function source(nom, prefixe, layoutParDefaut) {
  return {
    nom,
    layout: process.env[`${prefixe}_LAYOUT`] || layoutParDefaut,
    // Rubriques contenant une adresse mail (une ou plusieurs, séparées par des virgules)
    champsEmail: liste(process.env[`${prefixe}_EMAIL_FIELDS`] || ''),
    champNumero: process.env[`${prefixe}_NUMBER_FIELD`] || '',   // ex : AC1301
    champSociete: process.env[`${prefixe}_COMPANY_FIELD`] || '', // nom de la société
    // Rubriques téléphone, dans l'ordre de préférence (si l'IA n'a pas trouvé de numéro dans le mail)
    champsTelephone: liste(process.env[`${prefixe}_PHONE_FIELDS`] || ''),
    get actif() { return this.champsEmail.length > 0 && !!this.champNumero; },
  };
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
    depuis: dateDepuis(),
    // Dossier des brouillons ; vide = brouillon uniquement dans le ticket FileMaker
    dossierBrouillons: process.env.IMAP_DRAFTS_FOLDER || '',
    // Nombre maximum de mails traités par passage
    lotMax: Number(process.env.MAX_PER_RUN || 25),
  },

  // Analyse des mails : réglages communs à tous les moteurs
  ia: {
    // Moteurs essayés dans l'ordre ; si l'un échoue, on passe au suivant.
    // claude = API Anthropic (payant) · gratuit = API compatible OpenAI (Ollama, Groq, Gemini…)
    // regles = tri par mots-clés, sans IA, toujours disponible
    moteurs: liste(process.env.AI_ENGINES || 'claude,gratuit,regles'),
    // Un moteur sans crédit / clé refusée est mis de côté pendant ce délai avant d'être retenté
    pauseMinutes: Number(process.env.AI_PAUSE_MINUTES || 60),
    // Contexte métier injecté dans l'analyse (qui tu es, ton activité, ton ton de réponse)
    contexte:
      process.env.BUSINESS_CONTEXT ||
      "Support de la société Accen (location de matériel, logiciel de gestion sous FileMaker). Les réponses sont en français, vouvoiement, ton professionnel et cordial.",
    // « \n » dans le .env est converti en vrai retour à la ligne
    signature: (process.env.REPLY_SIGNATURE || 'Cordialement,\\nLe support Accen').replace(/\\n/g, '\n'),
    categories: liste(process.env.CATEGORIES ||
      'SAV,Commercial,Facturation,Fournisseur,Administratif,Interne,Notification automatique,Spam,Autre'),
    tailleMaxCorps: Number(process.env.MAX_BODY_CHARS || 15000),
  },

  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    modele: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
    // Seulement si la clé n'est rattachée à aucun workspace de la console (sinon laisser vide)
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || '',
  },

  // Moteur gratuit : toute API compatible OpenAI (/chat/completions)
  gratuit: {
    url: (process.env.FREE_AI_URL || '').replace(/\/$/, ''), // ex : http://localhost:11434/v1
    apiKey: process.env.FREE_AI_KEY || '',
    modele: process.env.FREE_AI_MODEL || '',
    modeJson: booleen('FREE_AI_JSON_MODE', true),
    delaiSecondes: Number(process.env.FREE_AI_TIMEOUT_SECONDS || 120),
  },

  // Catégories pour lesquelles on ne crée pas de ticket (mail tout de même marqué comme traité)
  categoriesIgnorees: liste(process.env.SKIP_CATEGORIES || 'Spam'),

  filemaker: {
    host: dryRun ? process.env.FM_HOST || '' : requis('FM_HOST'), // ex : https://172.16.1.21
    base: process.env.FM_DATABASE || 'Hotline',
    layout: process.env.FM_LAYOUT || 'WEB_SAV',
    // Authentification : FM_AUTH = en-tête complet « Basic xxxx » (comme config.fmpwd des autres
    // projets), ou bien FM_USER + FM_PASSWORD
    auth: process.env.FM_AUTH || '',
    user: process.env.FM_USER || '',
    pass: process.env.FM_PASSWORD || '',
    // false (par défaut) = certificat auto-signé accepté, comme IS_PRODUCTION = false
    verifierCertificat: booleen('FM_VERIFY_TLS', false),
    delaiSecondes: Number(process.env.FM_TIMEOUT_SECONDS || 30),
  },

  // Rattachement du ticket au client, à partir de l'adresse de l'expéditeur.
  // Les sources sont essayées dans l'ordre : contacts des clients, puis fiches Clients.
  // Une source est désactivée tant que ses rubriques mail et numéro client ne sont pas renseignées.
  // Une rubrique liée s'écrit « Table::Rubrique » (elle doit être placée sur le modèle).
  sourcesClient: [
    source('contacts', 'FM_CONTACTS', 'Contacts'),
    source('clients', 'FM_CLIENTS', 'Clients'),
  ],

  // Valeurs fixes posées sur chaque ticket créé depuis un mail
  ticket: {
    forme: process.env.TICKET_FORME || 'Email',
    statut: process.env.TICKET_STATUT || 'Ouvert',
    userInterne: process.env.TICKET_USER_INTERNE || '',
  },
};

if (!dryRun && !config.filemaker.auth && !(config.filemaker.user && config.filemaker.pass)) {
  throw new Error("Identifiants FileMaker manquants : renseigner FM_AUTH, ou FM_USER et FM_PASSWORD");
}

// Correspondance entre les données du ticket et les rubriques de la table SAV.
// Mettre '' pour ne pas renseigner une rubrique.
export const rubriques = {
  // Rubriques existantes
  client: 'client',              // numéro client, retrouvé via l'adresse de l'expéditeur
  societe: 'societe',            // nom de la société du client retrouvé
  corps: 'commentaire',          // commentaire de départ = texte du mail
  telephone: 'telephone',        // numéro repéré dans la signature, si présent
  forme: 'forme',
  statut: 'statut',
  userInterne: 'user_interne',
  // Rubriques à ajouter
  messageId: 'mail_message_id',
  dateReception: 'mail_date_reception',
  expediteurNom: 'mail_expediteur_nom',
  expediteurEmail: 'mail_expediteur',     // adresse mail complète de l'expéditeur
  objet: 'mail_objet',
  piecesJointes: 'mail_pieces_jointes',
  societeDetectee: 'ia_societe_detectee',
  categorie: '',                 // ia_categorie : laissée vide pour le moment
  priorite: 'ia_priorite',
  justificationPriorite: 'ia_justification_priorite',
  resume: 'ia_resume',
  actionAFaire: 'ia_action',
  brouillonReponse: 'ia_brouillon_reponse',
  moteur: 'ia_moteur',           // moteur qui a fait l'analyse : claude, gratuit ou regles
};
