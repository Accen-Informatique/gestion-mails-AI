# mail-tickets

Service Node.js qui, toutes les 5 minutes :

1. relève les nouveaux mails de la boîte IMAP ;
2. les fait analyser par Claude : **résumé**, **action à faire**, **catégorie**, **priorité** et **brouillon de réponse** ;
3. crée un **ticket dans FileMaker** (Data API) ;
4. dépose le brouillon dans le dossier *Brouillons* de la boîte (rien n'est jamais envoyé) ;
5. marque le mail avec le mot-clé IMAP `TicketCree` pour ne jamais le traiter deux fois.

Le mail reste dans la boîte de réception, non lu si tu ne l'as pas ouvert.

## 1. Préparer FileMaker

Les tickets sont créés dans la **table SAV existante**. Correspondance des rubriques actuelles :

| Rubrique existante | Valeur écrite par le service |
|---|---|
| `commentaire` | Texte du mail (commentaire de départ) |
| `forme` | `Mail entrant` (à ajouter à la liste de valeurs) |
| `statut` | `Ouvert` |
| `user_interne` | Vide par défaut (`TICKET_USER_INTERNE`) |
| `telephone` | Numéro repéré dans la signature, sinon vide |
| `societe`, `client` | Non écrites : à remplir par FileMaker à partir de l'adresse de l'expéditeur |

Rubriques **à ajouter** à la table (toutes de type Texte, sauf indication) :

| Rubrique | Contenu |
|---|---|
| `mail_message_id` | Identifiant unique du mail (anti-doublon) — **indexation activée** |
| `mail_date_reception` | Horodatage |
| `mail_expediteur_nom` | |
| `mail_expediteur_email` | Sert à retrouver le client |
| `mail_objet` | |
| `mail_pieces_jointes` | Noms des fichiers, un par ligne |
| `ia_societe_detectee` | Société repérée par Claude dans le mail (indication) |
| `ia_categorie` | SAV, Commercial, Facturation… |
| `ia_priorite` | Urgente / Haute / Normale / Basse |
| `ia_justification_priorite` | |
| `ia_resume` | |
| `ia_action` | Action à faire |
| `ia_brouillon_reponse` | Vide si aucune réponse nécessaire |

Les noms sont modifiables dans `src/config.js` → `rubriques`.

Puis :

- un modèle **`API_SAV_Mail`** basé sur la table SAV, contenant toutes ces rubriques (ne pas utiliser `WEB_SAV`, pour qu'une modification de l'écran ne casse pas l'import) ;
- un compte dédié (ex. `api_mail`) avec un jeu de privilèges limité à cette table et le privilège étendu **`fmrest`** ;
- la **Data API** activée dans la console d'administration de FileMaker Server.

## 2. Configurer

```bash
cp .env.example .env
# compléter IMAP_*, ANTHROPIC_API_KEY, FM_*
```

La clé API Claude se crée sur https://console.anthropic.com. Le modèle par défaut est `claude-haiku-5-5`, rapide et peu coûteux ; `claude-sonnet-5-5` donne des brouillons plus fins.

`BUSINESS_CONTEXT` améliore beaucoup la qualité : décris ton activité, tes clients, ton ton de réponse.

## 3. Tester puis lancer

```bash
npm install

# Vérifie IMAP, FileMaker et Claude sans rien traiter
node --env-file=.env src/index.js --check

# Avec DRY_RUN=true : analyse les mails et affiche le résultat, sans rien écrire
node --env-file=.env src/index.js --once

# Quand le résultat convient : DRY_RUN=false dans .env, puis lancement permanent avec PM2
npm install -g pm2
pm2 start src/index.js --name mail-tickets --node-args="--env-file=.env"
pm2 save
pm2 startup
```

Suivi : `pm2 logs mail-tickets` · après modification du `.env` : `pm2 restart mail-tickets`.

## Points à connaître

- **Premier démarrage** : seuls les mails reçus depuis `PROCESS_SINCE` (par défaut le jour du démarrage) sont traités, pour ne pas ticketer tout l'historique.
- **Mots-clés IMAP** : la plupart des serveurs (Dovecot, etc.) les acceptent. Sinon, `--check` l'indique ; renseigne alors `IMAP_PROCESSED_FOLDER` pour déplacer les mails traités dans un dossier.
- **Erreurs** : un mail en échec n'est pas marqué et sera retenté au passage suivant, 3 fois maximum jusqu'au prochain redémarrage.
- **Spam** : catégorisés puis marqués comme traités, sans ticket (`SKIP_CATEGORIES`).
- **Sécurité** : le contenu des mails est transmis à l'API Anthropic pour l'analyse. Claude n'a aucun pouvoir d'action : il renvoie seulement l'analyse, rien n'est envoyé ni supprimé. Les consignes cachées dans un mail sont traitées comme du texte.
- **Certificat FileMaker auto-signé** : ajouter `NODE_EXTRA_CA_CERTS=/chemin/vers/ca.pem` plutôt que de désactiver la vérification TLS.
