// Boucle principale : toutes les N minutes, relève les mails, les analyse et crée les tickets
import { config } from './config.js';
import { creerClient, releverNonTraites, releverDernier, marquerTraite, deposerBrouillon, accepteMotsCles } from './imap.js';
import { analyserMail, testerMoteurs, moteursActifs } from './analyse.js';
import {
  fmSession, ticketExiste, creerTicket, trouverClient, chercherDans, donneesTicket, filemakerConfigure,
} from './filemaker.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const echecs = new Map(); // UID IMAP -> nombre d'échecs (évite de rappeler l'API en boucle)
const ECHECS_MAX = 3;

// En simulation rien n'est marqué dans la boîte : on retient ici les UID déjà analysés pour ne
// pas les réanalyser (et les payer) à chaque passage
const simules = new Set();

// UID à ne pas relever : abandonnés après ECHECS_MAX échecs (réessayés au prochain
// redémarrage) ou déjà analysés en simulation
const exclus = () => new Set([
  ...[...echecs].filter(([, n]) => n >= ECHECS_MAX).map(([uid]) => uid),
  ...simules,
]);

async function passage() {
  const imap = creerClient();
  try {
    await imap.connect();
    const verrou = await imap.getMailboxLock(config.imap.dossier);
    try {
      if (!accepteMotsCles(imap) && !config.imap.dossierTraites) {
        throw new Error(
          "Le serveur IMAP refuse les mots-clés personnalisés : renseigne IMAP_PROCESSED_FOLDER pour déplacer les mails traités.",
        );
      }

      const mails = await releverNonTraites(imap, exclus());
      if (!mails.length) return log('Aucun nouveau mail.');
      log(`${mails.length} mail(s) à traiter.`);

      const traiterTous = async (fm, token) => {
        for (const mail of mails) {
          try {
            await traiter(imap, fm, token, mail);
            echecs.delete(mail.uid);
          } catch (e) {
            const n = (echecs.get(mail.uid) || 0) + 1;
            echecs.set(mail.uid, n);
            log(`ERREUR « ${mail.objet} » (${n}/${ECHECS_MAX}) : ${e.message}`);
          }
        }
      };
      // Une session FileMaker par passage (login → traitement des mails → logout)
      if (config.dryRun) await traiterTous(null, null);
      else await fmSession(traiterTous);
    } finally {
      verrou.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

async function traiter(imap, fm, token, mail) {
  const analyse = await analyserMail(mail);

  if (config.dryRun) {
    log(`[SIMULATION] ${mail.objet}\n${JSON.stringify(analyse, null, 2)}`);
    simules.add(mail.uid);
    return; // en simulation, rien n'est écrit ni marqué
  }

  if (config.categoriesIgnorees.includes(analyse.categorie)) {
    log(`Ignoré (${analyse.categorie}) : ${mail.objet}`);
  } else if (await ticketExiste(fm, token, mail.messageId)) {
    log(`Ticket déjà existant : ${mail.objet}`);
  } else {
    const client = await trouverClient(fm, token, mail.expediteurEmail);
    const id = await creerTicket(fm, token, mail, analyse, client);
    log(`Ticket ${id} créé [${analyse.priorite} · ${analyse.categorie} · ${analyse.moteur}] ` +
      `${client ? `client ${client.numero} ${client.societe}` : 'client inconnu'} — ${mail.objet}`);
    if (analyse.reponse_necessaire) {
      // Le ticket existe déjà : un échec du brouillon ne doit pas faire retraiter le mail
      await deposerBrouillon(imap, mail, analyse.brouillon_reponse)
        .catch(e => log(`Brouillon non déposé pour « ${mail.objet} » : ${e.message}`));
    }
  }

  await marquerTraite(imap, mail.uid);
}

// Test sur le dernier mail reçu (traité ou non).
// DRY_RUN=true : affiche l'analyse, le client retrouvé et le ticket qui serait créé, sans rien écrire.
// DRY_RUN=false : crée réellement le ticket (sauf s'il existe déjà), dépose le brouillon et marque le mail.
async function dernier() {
  const imap = creerClient();
  try {
    await imap.connect();
    const verrou = await imap.getMailboxLock(config.imap.dossier);
    try {
      const mail = await releverDernier(imap);
      if (!mail) return log('Aucun mail dans le dossier.');
      log(`Dernier mail : « ${mail.objet} »\n   de ${mail.expediteurNom} <${mail.expediteurEmail}>, ` +
        `reçu le ${mail.date.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}` +
        `${mail.dejaTraite ? '\n   (déjà marqué comme traité)' : ''}`);

      if (!config.dryRun) {
        await fmSession((fm, token) => traiter(imap, fm, token, mail));
        return;
      }

      const analyse = await analyserMail(mail);
      let client = null;
      if (filemakerConfigure()) {
        // Lecture seule : recherche du client et du doublon, rien n'est écrit
        await fmSession(async (fm, token) => {
          client = await trouverClient(fm, token, mail.expediteurEmail);
          log(client
            ? `Client retrouvé (via ${client.source}) : ${client.numero} — ${client.societe}`
            : 'Aucun client ne correspond à cette adresse.');
          if (await ticketExiste(fm, token, mail.messageId)) log('Un ticket existe déjà pour ce mail.');
        });
      } else {
        log('FileMaker non configuré : recherche du client ignorée.');
      }

      const ignore = config.categoriesIgnorees.includes(analyse.categorie);
      log(`[SIMULATION] Moteur : ${analyse.moteur} · catégorie : ${analyse.categorie} · priorité : ${analyse.priorite}` +
        (ignore ? ' → aucun ticket (catégorie ignorée)' : ''));
      if (!ignore) {
        log(`[SIMULATION] Ticket qui serait créé dans ${config.filemaker.layout} :\n` +
          JSON.stringify(donneesTicket(mail, analyse, client), null, 2));
      }
      log('[SIMULATION] Rien n\'a été écrit. Passe DRY_RUN=false pour créer réellement ce ticket.');
    } finally {
      verrou.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Vérification des connexions et des moteurs, sans rien traiter
async function verifier() {
  const imap = creerClient();
  await imap.connect();
  const verrou = await imap.getMailboxLock(config.imap.dossier);
  log(`IMAP OK — ${imap.mailbox.exists} mail(s) dans ${config.imap.dossier}, mots-clés personnalisés : ${accepteMotsCles(imap) ? 'oui' : 'non'}`);
  verrou.release();

  // Liste des dossiers, pour renseigner IMAP_DRAFTS_FOLDER / IMAP_PROCESSED_FOLDER avec le nom exact
  const dossiers = await imap.list();
  log('Dossiers de la boîte :\n' + dossiers
    .map(d => `   ${d.path}${d.specialUse ? `   ← ${d.specialUse}` : ''}`)
    .join('\n'));
  const brouillons = dossiers.find(d => d.specialUse === '\\Drafts');
  if (config.imap.dossierBrouillons && !dossiers.some(d => d.path === config.imap.dossierBrouillons)) {
    log(`ATTENTION : le dossier IMAP_DRAFTS_FOLDER « ${config.imap.dossierBrouillons} » n'existe pas${brouillons ? ` — utiliser « ${brouillons.path} »` : ''}.`);
  }
  await imap.logout();

  if (filemakerConfigure()) {
    await fmSession(async (fm, token) => {
      log(`FileMaker OK (${config.filemaker.host}, base ${config.filemaker.base})`);
      // Le modèle des tickets existe-t-il ? (recherche d'un Message-ID fictif)
      try {
        await ticketExiste(fm, token, 'verification@exemple.invalid');
        log(`Modèle des tickets « ${config.filemaker.layout} » OK`);
      } catch (e) {
        log(`Modèle des tickets « ${config.filemaker.layout} » EN ÉCHEC : ${e.message}`);
      }
      // Recherche d'une adresse fictive : vérifie que les modèles et rubriques existent
      for (const s of config.sourcesClient) {
        if (!s.actif) { log(`Recherche client « ${s.nom} » désactivée (rubriques non renseignées)`); continue; }
        try {
          await chercherDans(fm, token, s, 'verification@exemple.invalid');
          log(`Recherche client « ${s.nom} » OK (modèle ${s.layout})`);
        } catch (e) {
          log(`Recherche client « ${s.nom} » EN ÉCHEC : ${e.message}`);
        }
      }
    });
  } else {
    log('FileMaker non configuré (FM_HOST, FM_AUTH ou FM_USER / FM_PASSWORD) : vérification ignorée.');
  }

  log(`Mails traités depuis le ${config.imap.depuis}`);
  await testerMoteurs({
    expediteurNom: 'Test', expediteurEmail: 'test@example.com', destinataires: config.imap.user,
    date: new Date(), objet: 'Test de connexion', piecesJointes: [], automatique: false,
    corps: 'Bonjour, ceci est un test de connexion, aucune action requise.',
  });
}

const args = process.argv.slice(2);
log(`Moteurs d'analyse : ${moteursActifs().map(m => m.nom).join(' → ') || 'aucun'}`);

if (args.includes('--check')) {
  verifier().catch(e => { log('ÉCHEC :', e.message); process.exit(1); });
} else if (args.includes('--dernier')) {
  dernier().catch(e => { log('ÉCHEC :', e.message); process.exit(1); });
} else if (args.includes('--once')) {
  passage().catch(e => { log('ÉCHEC :', e.message); process.exit(1); });
} else {
  log(`Démarrage — relève toutes les ${config.intervalleMinutes} min${config.dryRun ? ' (SIMULATION)' : ''}.`);
  let enCours = false;
  const tour = async () => {
    if (enCours) return; // pas de chevauchement si un passage dure plus longtemps que l'intervalle
    enCours = true;
    try { await passage(); } catch (e) { log('ÉCHEC du passage :', e.message); }
    finally { enCours = false; }
  };
  tour();
  setInterval(tour, config.intervalleMinutes * 60_000);
}
