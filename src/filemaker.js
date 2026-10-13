// Création des tickets via la Data API FileMaker
import { config, rubriques } from './config.js';

const fm = config.filemaker;
const base = () => `${fm.host.replace(/\/$/, '')}/fmi/data/vLatest/databases/${encodeURIComponent(fm.base)}`;

async function appel(chemin, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base()}${chemin}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  const msg = json.messages?.[0] || {};
  return { ok: res.ok && msg.code === '0', code: msg.code, message: msg.message, data: json.response };
}

export async function ouvrirSession() {
  const auth = Buffer.from(`${fm.user}:${fm.pass}`).toString('base64');
  const res = await fetch(`${base()}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: '{}',
  });
  const json = await res.json().catch(() => ({}));
  const token = json.response?.token;
  if (!token) throw new Error(`Connexion FileMaker refusée : ${json.messages?.[0]?.message || res.status}`);
  return token;
}

export async function fermerSession(token) {
  if (token) await appel(`/sessions/${token}`, { method: 'DELETE' }).catch(() => {});
}

// Vrai si un ticket existe déjà pour ce Message-ID (sécurité anti-doublon)
export async function ticketExiste(token, messageId) {
  const r = await appel(`/layouts/${encodeURIComponent(fm.layout)}/_find`, {
    method: 'POST',
    token,
    body: { query: [{ [rubriques.messageId]: `==${echapper(messageId)}` }], limit: 1 },
  });
  if (r.ok) return (r.data?.data?.length || 0) > 0;
  if (r.code === '401') return false; // 401 = aucun enregistrement trouvé
  throw new Error(`Recherche FileMaker en échec (${r.code}) : ${r.message}`);
}

export async function creerTicket(token, mail, analyse) {
  const valeurs = {
    corps: mail.corps,
    telephone: analyse.telephone || '',
    forme: config.ticket.forme,
    statut: config.ticket.statut,
    userInterne: config.ticket.userInterne,
    messageId: mail.messageId,
    dateReception: horodatageFM(mail.date),
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
  };
  const fieldData = {};
  for (const [cle, rubrique] of Object.entries(rubriques)) {
    if (rubrique) fieldData[rubrique] = valeurs[cle] ?? '';
  }

  const r = await appel(`/layouts/${encodeURIComponent(fm.layout)}/records`, {
    method: 'POST', token, body: { fieldData },
  });
  if (!r.ok) throw new Error(`Création du ticket FileMaker en échec (${r.code}) : ${r.message}`);
  return r.data?.recordId;
}

// Format horodatage attendu par la Data API : MM/JJ/AAAA HH:MM:SS (heure de Paris)
function horodatageFM(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d).map(x => [x.type, x.value]),
  );
  return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

// Échappe les caractères spéciaux de recherche FileMaker
function echapper(v) {
  return String(v).replace(/([@*#?!=<>"~\\])/g, '\\$1');
}
