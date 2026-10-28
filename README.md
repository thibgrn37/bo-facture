# Factures BO

Application pour réunir, classer et suivre toutes les factures et tickets de caisse de BO, à deux associés.

- Photo d'un ticket depuis le téléphone, avec lecture automatique : fournisseur, date, TTC, HT, TVA, catégorie, n° de facture et 4 derniers chiffres de la carte.
- Import de PDF et d'images, y compris plusieurs à la fois ou par glisser-déposer sur ordinateur.
- Qui a payé et avec quel moyen. Une dépense payée en CB perso ou en espèces perso est marquée « à rembourser ».
- Suivi des remboursements de frais par associé, avec un historique.
- Factures à payer avec leur échéance.
- Synthèse par mois, par catégorie et par payeur, avec la TVA récupérable.
- Export CSV pour le comptable.
- Installable sur l'écran d'accueil du téléphone, comme une appli.

Technique : site statique (HTML/JS, aucune compilation) hébergé sur Netlify (ou GitHub Pages), avec les données, les photos et la connexion sur Supabase. La lecture des tickets passe par une fonction serveur Supabase qui appelle l'API Claude d'Anthropic.

---

## Mise en route (une seule fois, environ 20 minutes)

### 1. Créer la base de données

1. Dans Supabase, ouvrez **SQL Editor** puis **New query**.
2. Copiez tout le contenu de [`supabase/schema.sql`](supabase/schema.sql).
3. **Remplacez les deux adresses e-mail d'exemple** (`associe1@exemple.fr`, `associe2@exemple.fr`) par celles des deux associés.
4. Cliquez sur **Run**. Le message attendu est « Success. No rows returned ».

Seules ces deux adresses peuvent voir et modifier les factures. Pour en ajouter une plus tard :
`insert into public.members (email) values ('nouvelle@adresse.fr');`

### 2. Créer les comptes des deux associés

1. **Authentication > Sign In / Providers** : désactivez **Allow new users to sign up**, pour que personne d'autre ne puisse créer de compte.
2. **Authentication > Users > Add user > Create new user** : saisissez l'e-mail et un mot de passe, cochez **Auto Confirm User**, puis validez. Faites-le pour chaque associé.

### 3. Activer la lecture automatique des tickets

1. Créez une clé API sur **console.anthropic.com** : *Settings > API Keys > Create Key*. Ajoutez quelques euros de crédit dans *Billing*. Une lecture coûte environ 1 à 2 centimes.
2. Dans Supabase, ouvrez **Edge Functions > Secrets** et ajoutez le secret `ANTHROPIC_API_KEY` avec la clé comme valeur.
3. Ouvrez **Edge Functions > Deploy a new function > Via Editor**. Nommez la fonction **`read-receipt`**, remplacez le code d'exemple par le contenu de [`supabase/functions/read-receipt/index.ts`](supabase/functions/read-receipt/index.ts), puis cliquez sur **Deploy function**.

La clé API reste sur le serveur Supabase : elle n'est jamais envoyée dans l'app ni dans ce dépôt. Sans cette étape, l'app fonctionne quand même, mais vous remplissez les champs à la main.

### 4. Mettre l'app en ligne

**Avec Netlify (gratuit, dépôt privé possible)**

1. Allez sur **app.netlify.com** et connectez-vous avec **GitHub**.
2. Cliquez sur **Add new site > Import an existing project > GitHub**, autorisez Netlify, puis choisissez `bo-facture`.
3. Laissez les réglages tels quels (ils viennent de `netlify.toml`) et cliquez sur **Deploy**.
4. L'adresse de l'app s'affiche, du type `https://xxxx.netlify.app`. Vous pouvez la renommer dans *Site configuration > Change site name*. Chaque modification du code est ensuite mise en ligne automatiquement.

**Ou avec GitHub Pages (seulement si le dépôt est public, ou avec GitHub Pro)** : *Settings > Pages > Deploy from a branch > main / (root)*.

Ensuite, dans Supabase, ouvrez **Authentication > URL Configuration** et collez l'adresse de l'app dans **Site URL**. C'est nécessaire pour le lien « Mot de passe oublié ».

### 5. Installer l'app sur les téléphones

- **iPhone (Safari)** : ouvrez l'adresse, touchez **Partager**, puis **Sur l'écran d'accueil**.
- **Android (Chrome)** : ouvrez l'adresse, touchez le menu **⋮**, puis **Installer l'application**.

Ensuite, dans l'onglet **Réglages** de l'app, mettez vos prénoms, touchez « C'est moi » et ajoutez les 4 derniers chiffres de vos cartes, pro et perso.

---

## Sécurité

- `config.js` contient l'adresse du projet Supabase et la clé « anon ». Les deux sont publiques par conception. La protection vient des règles d'accès (RLS) de `schema.sql` : sans compte autorisé, on ne voit rien.
- Les photos sont dans un espace de stockage **privé**. L'app les affiche avec des liens temporaires valables une heure.
- Ne mettez jamais la clé `service_role` ni la clé API Anthropic dans ce dépôt.

## Organisation des fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css`, `app.js` | L'application |
| `config.js` | Adresse et clé publique du projet Supabase |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installation sur téléphone et ouverture rapide |
| `vendor/` | Bibliothèques Supabase et PDF.js (copiées ici pour ne dépendre d'aucun service externe) |
| `supabase/schema.sql` | Tables, règles d'accès et stockage |
| `supabase/functions/read-receipt/` | Lecture automatique des tickets |

## Modifier l'app

Pour changer la version de l'app sur les téléphones après une modification, augmentez le numéro dans `sw.js` (`bo-facture-v1` devient `bo-facture-v2`). Le modèle Claude utilisé pour la lecture se change avec le secret facultatif `RECEIPT_MODEL`.
