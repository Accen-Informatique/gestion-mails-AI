// Boucle principale : toutes les N minutes, relève les mails, les analyse et crée les tickets
import { config } from './config.js';
import { creerClient, releverNonTraites, marquerTraite, deposerBrouillon, accepteMotsCles } from './imap.js';
import { analyserMail } from './analyse.js';
import { ouvrirSession, fermerSession, ticketExiste, creerTicket } from './filemaker.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const echecs = new Map(); // Message-ID -> nombre d'échecs (évite de rappeler l'API en boucle)
const ECHECS_MAX = 3;

async function passage() {
  const imap = creerClient();
  let token;
  try {
    await imap.connect();
    const verrou = await imap.getMailboxLock(config.imap.dossier);
    try {
      if (!accepteMotsCles(imap) && !config.imap.dossierTraites) {
        throw new Error(
          "Le serveur IMAP refuse les mots-clés personnalisés : renseigne IMAP_PROCESSED_FOLDER pour déplacer les mails traités.",
        );
      }

      const mails = await releverNonTraites(imap);
      if (!mails.length) return log('Aucun nouveau mail.');
      log(`${mails.length} mail(s) à traiter.`);

      if (!config.dryRun) token = await ouvrirSession();

      for (const mail of mails) {
        if ((echecs.get(mail.messageId) || 0) >= ECHECS_MAX) continue;
        try {
          await traiter(imap, token, mail);
          echecs.delete(mail.messageId);
        } catch (e) {
          const n = (echecs.get(mail.messageId) || 0) + 1;
          echecs.set(mail.messageId, n);
          log(`ERREUR « ${mail.objet} » (${n}/${ECHECS_MAX}) : ${e.message}`);
        }
      }
    } finally {
      verrou.release();
    }
  } finally {
    await fermerSession(token);
    await imap.logout().catch(() => {});
  }
}

async function traiter(imap, token, mail) {
  const analyse = await analyserMail(mail);

  if (config.dryRun) {
    log(`[SIMULATION] ${mail.objet}\n${JSON.stringify(analyse, null, 2)}`);
    return; // en simulation, rien n'est écrit ni marqué
  }

  if (config.categoriesIgnorees.includes(analyse.categorie)) {
    log(`Ignoré (${analyse.categorie}) : ${mail.objet}`);
  } else if (await ticketExiste(token, mail.messageId)) {
    log(`Ticket déjà existant : ${mail.objet}`);
  } else {
    const id = await creerTicket(token, mail, analyse);
    log(`Ticket ${id} créé [${analyse.priorite} · ${analyse.categorie}] ${mail.objet}`);
    if (analyse.reponse_necessaire) await deposerBrouillon(imap, mail, analyse.brouillon_reponse);
  }

  await marquerTraite(imap, mail.uid);
}

// Vérification des trois connexions, sans rien traiter
async function verifier() {
  const imap = creerClient();
  await imap.connect();
  const verrou = await imap.getMailboxLock(config.imap.dossier);
  log(`IMAP OK — ${imap.mailbox.exists} mail(s) dans ${config.imap.dossier}, mots-clés personnalisés : ${accepteMotsCles(imap) ? 'oui' : 'non'}`);
  verrou.release();
  await imap.logout();

  if (!config.dryRun) {
    const t = await ouvrirSession();
    log('FileMaker OK');
    await fermerSession(t);
  }

  const a = await analyserMail({
    expediteurNom: 'Test', expediteurEmail: 'test@example.com', destinataires: config.imap.user,
    date: new Date(), objet: 'Test de connexion', piecesJointes: [],
    corps: 'Bonjour, ceci est un test de connexion, aucune action requise.',
  });
  log(`Claude OK — catégorie proposée : ${a.categorie}`);
}

const args = process.argv.slice(2);
if (args.includes('--check')) {
  verifier().catch(e => { log('ÉCHEC :', e.message); process.exit(1); });
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
