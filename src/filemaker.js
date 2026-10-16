// Tickets et recherche client dans FileMaker — mêmes conventions que le module documentation :
// fmSession (login → action → logout), fm_find, exact(), codes « aucun enregistrement » 401 / 101,
// horodatages « MM/JJ/AAAA HH:MM:SS ». Aucune suppression dans FileMaker.
import fmrestapi from './fmrestapi.js';
import { config, rubriques } from './config.js';

const FM = config.filemaker;

// Codes FileMaker « aucun enregistrement » : 401 (recherche vide), 101 (enregistrement absent)
const NO_RECORD = ['401', '101'];

// Erreur FileMaker avec le détail { code, message } pour les logs
export class FmError extends Error {
  constructor(message, detail) {
    super(detail ? `${message} [FileMaker ${detail.code} : ${detail.message}]` : message);
    this.detail = detail;
  }
}

// Authentification : FM_AUTH (« Basic xxxx », comme config.fmpwd) ou FM_USER / FM_PASSWORD
function auth() {
  if (FM.auth) return FM.auth;
  return 'Basic ' + Buffer.from(`${FM.user}:${FM.pass}`).toString('base64');
}

// FileMaker est-il configuré ? (en simulation, ses champs peuvent rester vides)
export const filemakerConfigure = () => !!(FM.host && FM.base && (FM.auth || (FM.user && FM.pass)));

// login → action → logout (toujours)
export async function fmSession(action) {
  const fm = new fmrestapi(FM.base);
  const pkglogin = await fm.login(auth());
  if (pkglogin.code != 0) throw new FmError('Connexion FileMaker refusée', pkglogin);
  const token = pkglogin.data;
  try {
    return await action(fm, token);
  } finally {
    await fm.logout(token);
  }
}

// ---------- Fonctions communes ----------

function field(r, name) {
  const v = r.fieldData[name];
  return v === undefined || v === null ? '' : String(v);
}

// Recherche exacte : échappe les opérateurs FileMaker
export function exact(value) {
  return '==' + String(value).replace(/([@*#?!=<>"~\\/]|\.\.)/g, '\\$1');
}

async function fm_find(fm, token, layout, query, limit = 100) {
  const pkgfind = await fm.findRecords(token, layout, query, [], limit);
  if (NO_RECORD.includes(String(pkgfind.code))) return [];
  if (pkgfind.code != 0) throw new FmError(`Recherche dans ${layout} en échec`, pkgfind);
  return pkgfind.data.data;
}

async function fm_create(fm, token, layout, data) {
  const pkgcreate = await fm.createRecord(token, layout, data, {}, '');
  if (pkgcreate.code != 0) throw new FmError(`Création dans ${layout} en échec`, pkgcreate);
  return pkgcreate.data.recordId;
}

// Date → horodatage FileMaker « MM/JJ/AAAA HH:MM:SS » (heure de Paris)
function fm_ts(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d).map(x => [x.type, x.value]),
  );
  return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

// ---------- Tickets (WEB_SAV) ----------

// Vrai si un ticket existe déjà pour ce Message-ID (anti-doublon)
export async function ticketExiste(fm, token, messageId) {
  const list = await fm_find(fm, token, FM.layout, [{ [rubriques.messageId]: exact(messageId) }], 1);
  return list.length > 0;
}

export function creerTicket(fm, token, mail, analyse, client = null) {
  return fm_create(fm, token, FM.layout, donneesTicket(mail, analyse, client));
}

// Contenu exact du ticket, rubrique par rubrique (aussi utilisé pour l'aperçu en simulation)
export function donneesTicket(mail, analyse, client = null) {
  const valeurs = {
    client: client?.numero || '',
    societe: client?.societe || '',
    corps: mail.corps,
    telephone: analyse.telephone || client?.telephone || '',
    forme: config.ticket.forme,
    statut: config.ticket.statut,
    userInterne: config.ticket.userInterne,
    messageId: mail.messageId,
    dateReception: fm_ts(mail.date),
    expediteurNom: mail.expediteurNom,
    expediteurEmail: mail.expediteurEmail,
    objet: mail.objet,
    piecesJointes: mail.piecesJointes.join('\r'),
    societeDetectee: analyse.societe || '',
    categorie: analyse.categorie,
    priorite: analyse.priorite,
    justificationPriorite: analyse.justification_priorite,
    resume: analyse.resume,
    actionAFaire: analyse.action_a_faire,
    brouillonReponse: analyse.reponse_necessaire ? analyse.brouillon_reponse : '',
    moteur: analyse.moteur,
  };
  const fieldData = {};
  for (const [cle, rubrique] of Object.entries(rubriques)) {
    if (rubrique) fieldData[rubrique] = valeurs[cle] ?? '';
  }
  return fieldData;
}

// ---------- Recherche du client (API_Contacts, puis Clients) ----------

// Retourne { numero, societe, telephone, source } ou null (aucune correspondance, ou plusieurs clients différents)
export async function trouverClient(fm, token, email) {
  const adresse = String(email || '').trim().toLowerCase();
  if (!adresse) return null;
  for (const source of config.sourcesClient) {
    if (!source.actif) continue;
    const client = await chercherDans(fm, token, source, adresse);
    if (client) return { ...client, source: source.nom };
  }
  return null;
}

export async function chercherDans(fm, token, c, adresse) {
  // Recherche « phrase » (entre guillemets) : trouve l'adresse même si la rubrique en contient
  // plusieurs. Une requête par rubrique mail = recherche OU sur toutes ces rubriques.
  const query = c.champsEmail.map(champ => ({ [champ]: `"${adresse.replace(/"/g, '')}"` }));
  const list = await fm_find(fm, token, c.layout, query, 20);

  // FileMaker ignore la casse et cherche des mots : on revérifie l'adresse exacte
  const fiches = list.filter(r => c.champsEmail.some(champ =>
    field(r, champ).toLowerCase().split(/[\s,;]+/).includes(adresse)));

  const numeros = [...new Set(fiches.map(r => field(r, c.champNumero).trim()).filter(Boolean))];
  if (numeros.length !== 1) return null; // aucun, ou ambigu : on laisse vide
  const fiche = fiches.find(r => field(r, c.champNumero).trim() === numeros[0]);
  return {
    numero: numeros[0],
    societe: c.champSociete ? field(fiche, c.champSociete).trim() : '',
    // Premier numéro valable (au moins 8 chiffres : écarte « a quitté la société »…)
    telephone: c.champsTelephone
      .map(champ => field(fiche, champ).trim())
      .find(v => (v.match(/\d/g) || []).length >= 8) || '',
  };
}
