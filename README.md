# mail-tickets

Service Node.js qui, toutes les 5 minutes :

1. relève les nouveaux mails de la boîte IMAP ;
2. les fait analyser : **résumé**, **action à faire**, **catégorie**, **priorité** et **brouillon de réponse** — par Claude, ou par une IA gratuite en secours, ou à défaut par des règles de mots-clés (voir « Moteurs d'analyse ») ;
3. crée un **ticket dans FileMaker** (Data API) ;
4. dépose le brouillon dans le dossier *Brouillons* de la boîte (rien n'est jamais envoyé) ;
5. marque le mail avec le mot-clé IMAP `TicketCree` pour ne jamais le traiter deux fois.

Le mail reste dans la boîte de réception, non lu si tu ne l'as pas ouvert.

## 1. Préparer FileMaker

Les tickets sont créés dans la **table SAV existante**. Correspondance des rubriques actuelles :

| Rubrique existante | Valeur écrite par le service |
|---|---|
| `commentaire` | Texte du mail (commentaire de départ) |
| `forme` | `Email` |
| `statut` | `Ouvert` |
| `user_interne` | Vide par défaut (`TICKET_USER_INTERNE`) |
| `telephone` | Numéro repéré dans la signature, sinon vide |
| `client`, `societe` | Numéro et nom du client retrouvé dans le modèle `Clients` à partir de l'adresse de l'expéditeur (`FM_CLIENTS_*`). Vides si aucune adresse ne correspond, ou si plusieurs clients correspondent |

Rubriques **à ajouter** à la table (toutes de type Texte, sauf indication) :

| Rubrique | Contenu |
|---|---|
| `mail_message_id` | Identifiant unique du mail (anti-doublon) — **indexation activée** |
| `mail_date_reception` | Horodatage |
| `mail_expediteur_nom` | |
| `mail_expediteur` | Adresse mail complète de l'expéditeur |
| `mail_objet` | |
| `mail_pieces_jointes` | Noms des fichiers, un par ligne |
| `ia_societe_detectee` | Société repérée par Claude dans le mail (indication) |
| `ia_categorie` | Laissée vide pour le moment (`rubriques.categorie` dans `src/config.js`) |
| `ia_priorite` | Urgente / Haute / Normale / Basse |
| `ia_justification_priorite` | |
| `ia_resume` | |
| `ia_action` | Action à faire |
| `ia_brouillon_reponse` | Vide si aucune réponse nécessaire |
| `ia_moteur` | Moteur qui a fait l'analyse : `claude`, `gratuit` ou `regles` |

Les noms sont modifiables dans `src/config.js` → `rubriques`.

Puis :

- le modèle **`WEB_SAV`** (`FM_LAYOUT`) doit contenir toutes ces rubriques ;
- un compte dédié (ex. `api_mail`) avec un jeu de privilèges limité à cette table et le privilège étendu **`fmrest`** ;
- la **Data API** activée dans la console d'administration de FileMaker Server.

## 2. Configurer

```bash
cp .env.example .env
# compléter IMAP_*, FM_* et au moins un moteur d'analyse (chaque champ est commenté)
```

`BUSINESS_CONTEXT` améliore beaucoup la qualité : décris ton activité, tes clients, ton ton de réponse.

### Moteurs d'analyse

`AI_ENGINES` donne l'ordre des moteurs (par défaut `claude,gratuit,regles`). Si un moteur échoue, le suivant prend le relais pour ce mail. Un moteur sans crédit, dont la clé est refusée ou dont le quota est atteint est mis de côté pendant `AI_PAUSE_MINUTES` (60 par défaut) puis retenté. Un moteur non configuré est simplement ignoré.

| Moteur | Coût | Qualité | Remarques |
|---|---|---|---|
| `claude` | Payant | La meilleure | Clé sur https://console.anthropic.com. `claude-haiku-5-5` par défaut, `claude-sonnet-5-5` pour des brouillons plus fins |
| `gratuit` | Gratuit | Correcte | Toute API compatible OpenAI : **Ollama** (local, les mails ne sortent pas de ta machine), Groq, Gemini, Mistral… Exemples prêts dans `.env.example` |
| `regles` | Gratuit | Basique | Tri par mots-clés, sans IA ni brouillon. Toujours disponible : aucun mail n'est bloqué |

Le moteur utilisé est écrit dans `ia_moteur` : tu repères ainsi les tickets à requalifier.

**Confidentialité** : avec une offre gratuite en ligne (Gemini, Mistral, Groq…), vérifie les conditions du fournisseur : certaines offres gratuites autorisent l'utilisation des données envoyées pour améliorer leurs modèles. Pour des mails clients, Ollama en local évite la question.

## 3. Tester puis lancer

```bash
npm install

# Vérifie IMAP, FileMaker et chaque moteur d'analyse sans rien traiter
npm run check

# Avec DRY_RUN=true : analyse les mails et affiche le résultat, sans rien écrire
npm run once

# Teste sur le DERNIER mail reçu uniquement (même déjà traité) :
# avec DRY_RUN=true, affiche l'analyse, le client retrouvé et le ticket qui serait créé ;
# avec DRY_RUN=false, crée réellement ce ticket
npm run dernier

# Quand le résultat convient : DRY_RUN=false dans .env, puis lancement permanent avec PM2
npm install -g pm2
pm2 start src/index.js --name mail-tickets
pm2 save
pm2 startup
```

Suivi : `pm2 logs mail-tickets` · après modification du `.env` : `pm2 restart mail-tickets`.

## Points à connaître

- **Premier démarrage** : seuls les mails reçus depuis `PROCESS_SINCE` sont traités, pour ne pas ticketer tout l'historique. Sans `PROCESS_SINCE`, la date du tout premier démarrage est mémorisée dans `data/etat.json` (pas de mails « sautés » après un redémarrage).
- **Simulation** (`DRY_RUN=true`) : rien n'est écrit ni marqué ; les mails déjà analysés sont retenus en mémoire pour ne pas être réanalysés à chaque passage.
- **Mots-clés IMAP** : la plupart des serveurs (Dovecot, etc.) les acceptent. Sinon, `--check` l'indique ; renseigne alors `IMAP_PROCESSED_FOLDER` pour déplacer les mails traités dans un dossier.
- **Erreurs** : un mail en échec n'est pas marqué et sera retenté au passage suivant, 3 fois maximum jusqu'au prochain redémarrage. Les mails abandonnés ne bloquent pas les suivants.
- **Spam** : catégorisés puis marqués comme traités, sans ticket (`SKIP_CATEGORIES`).
- **Sécurité** : le contenu des mails est transmis au moteur d'analyse (API Anthropic, ou le fournisseur gratuit choisi). L'IA n'a aucun pouvoir d'action : il renvoie seulement l'analyse, rien n'est envoyé ni supprimé. Les consignes cachées dans un mail sont traitées comme du texte.
- **Certificat FileMaker auto-signé** : ajouter `NODE_EXTRA_CA_CERTS=/chemin/vers/ca.pem` plutôt que de désactiver la vérification TLS.

## Installer sur un serveur

- **Node 18 minimum** (20 ou 22 conseillé) : `node -v` pour vérifier. Si le serveur a une version plus ancienne
  utilisée par d'autres projets, installer Node 22 uniquement pour ce service avec nvm :
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.bashrc
  nvm install 22
  ```
  puis lancer PM2 avec cet interpréteur : `pm2 start src/index.js --name mail-tickets --interpreter $(nvm which 22)`.
- Le fichier **`.env` n'est pas dans git** : le recréer sur le serveur (`cp .env.example .env`, puis compléter).
- Le serveur doit joindre `ssl0.ovh.net:993` (IMAP), le FileMaker Server (`FM_HOST`) et l'API de l'IA.
