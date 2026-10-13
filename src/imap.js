// Accès à la boîte IMAP : relève des mails non traités, marquage, dépôt des brouillons
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from './config.js';

export function creerClient() {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    logger: false,
  });
}

// Le serveur accepte-t-il les mots-clés personnalisés sur ce dossier ?
export function accepteMotsCles(client) {
  const flags = client.mailbox?.permanentFlags;
  return !!flags && (flags.has('\\*') || flags.has(config.imap.motCleTraite));
}

// Retourne les mails pas encore traités (analysés et décodés), du plus ancien au plus récent
export async function releverNonTraites(client) {
  const critere = { since: new Date(config.imap.depuis) };
  if (accepteMotsCles(client)) critere.unKeyword = config.imap.motCleTraite;

  const uids = (await client.search(critere, { uid: true })) || [];
  if (!uids.length) return [];

  const lot = uids.sort((a, b) => a - b).slice(0, config.imap.lotMax);
  const bruts = [];
  // Important : on lit tout avant de modifier quoi que ce soit (imapflow ne permet pas
  // d'envoyer d'autres commandes pendant un fetch en cours)
  for await (const msg of client.fetch(lot, { uid: true, source: true, flags: true }, { uid: true })) {
    if (msg.flags?.has(config.imap.motCleTraite)) continue;
    bruts.push({ uid: msg.uid, source: msg.source });
  }

  const mails = [];
  for (const b of bruts) {
    const p = await simpleParser(b.source);
    const de = p.from?.value?.[0] || {};
    mails.push({
      uid: b.uid,
      messageId: p.messageId || `uid-${b.uid}@${config.imap.host}`,
      references: p.references,
      date: p.date || new Date(),
      expediteurNom: de.name || '',
      expediteurEmail: de.address || '',
      destinataires: [p.to, p.cc].filter(Boolean).flatMap(x => x.value || []).map(v => v.address).join(', '),
      objet: p.subject || '(sans objet)',
      corps: (p.text || htmlVersTexte(p.html) || '').trim(),
      piecesJointes: (p.attachments || []).filter(a => !a.related).map(a => a.filename || 'sans-nom'),
    });
  }
  return mails;
}

// Marque le mail comme traité (mot-clé ou déplacement selon la config)
export async function marquerTraite(client, uid) {
  if (accepteMotsCles(client)) {
    await client.messageFlagsAdd(uid, [config.imap.motCleTraite], { uid: true });
  }
  if (config.imap.dossierTraites) {
    await client.messageMove(uid, config.imap.dossierTraites, { uid: true });
  }
}

// Dépose un brouillon de réponse dans le dossier Brouillons (rien n'est envoyé)
export async function deposerBrouillon(client, mail, texte) {
  if (!config.imap.dossierBrouillons || !texte) return;
  const refs = [].concat(mail.references || [], mail.messageId).filter(Boolean);
  const raw = await new MailComposer({
    from: config.imap.user,
    to: mail.expediteurNom ? `"${mail.expediteurNom}" <${mail.expediteurEmail}>` : mail.expediteurEmail,
    subject: /^re\s*:/i.test(mail.objet) ? mail.objet : `RE: ${mail.objet}`,
    text: texte,
    inReplyTo: mail.messageId,
    references: refs.join(' '),
  }).compile().build();
  await client.append(config.imap.dossierBrouillons, raw, ['\\Draft', '\\Seen']);
}

function htmlVersTexte(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n');
}
