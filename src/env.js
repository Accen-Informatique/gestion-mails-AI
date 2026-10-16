// Chargement du fichier .env (sans dépendance, quelle que soit la version de Node)
// et contrôle de la version de Node. Importé en tout premier par config.js.
import { readFileSync, existsSync } from 'node:fs';

const majeure = Number(process.versions.node.split('.')[0]);
if (majeure < 18) {
  console.error(
    `Node ${process.versions.node} est trop ancien : ce service demande Node 18 minimum (20 ou 22 conseillé).\n` +
    'Voir le README, section « Installer sur un serveur ».',
  );
  process.exit(1);
}

const fichier = new URL('../.env', import.meta.url);
if (existsSync(fichier)) {
  for (const ligne of readFileSync(fichier, 'utf8').split(/\r?\n/)) {
    const m = ligne.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue; // ligne vide ou commentaire
    let valeur = m[2].trim();
    // Valeur entre guillemets : on retire les guillemets ; sinon un « # » précédé d'un espace commence un commentaire
    if (/^(['"]).*\1$/.test(valeur)) valeur = valeur.slice(1, -1);
    else valeur = valeur.replace(/\s+#.*$/, '');
    // Les variables déjà définies (pm2, ligne de commande) sont prioritaires
    if (process.env[m[1]] === undefined) process.env[m[1]] = valeur;
  }
} else {
  console.error("Fichier .env introuvable : copier .env.example en .env et le compléter.");
}
