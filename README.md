# Money Express Mobile

Application web responsive en français avec comptes client et administrateur, demandes suivies, adresses des agences et logo Money Express.

## Déploiement recommandé : application complète sur Render

Pour publier le site avec l’inscription, la connexion et les demandes opérationnelles, utilisez le Blueprint Render `render.yaml`. Il crée un seul service Node.js qui sert le site et son API, configure HTTPS et conserve les comptes et les demandes sur un disque persistant.

1. Placez les fichiers du projet dans un dépôt GitHub privé. N’y ajoutez jamais `.env` ni `data/` : ces éléments sont exclus par `.gitignore`.
2. Dans Render, choisissez **New → Blueprint**, associez votre dépôt et confirmez le déploiement. Render lit `render.yaml`, construit l’application et crée le disque persistant. Le service utilise le forfait Starter payant, nécessaire au disque persistant.
3. Quand Render le demande, définissez `ADMIN_EMAIL`, `ADMIN_NAME` et `ADMIN_PASSWORD`. Utilisez un mot de passe administrateur unique d’au moins 12 caractères. Générez aussi `NETLIFY_PROXY_SECRET` avec la commande ci-dessous et gardez-le confidentiel ; la configuration du backend en a besoin au démarrage. Conservez sa valeur si vous prévoyez d’héberger le site statique séparément sur Netlify. Ne publiez aucun de ces paramètres dans le dépôt.
4. Une fois le service créé, ouvrez son URL HTTPS et vérifiez que `/api/health` affiche `{"status":"ok"}`. Le service par défaut est `https://money-express-mobile.onrender.com`. Si ce nom est déjà pris ou si vous ajoutez un domaine personnalisé, mettez à jour `APP_ORIGIN` et `ALLOWED_HOSTS` dans le tableau de bord Render pour qu’ils correspondent à la nouvelle adresse avant le prochain déploiement.

Le site et son API sont ainsi hébergés ensemble, sans backend séparé ni configuration Netlify. Le secret `NETLIFY_PROXY_SECRET` reste obligatoire au démarrage du serveur ; pour un hébergement uniquement sur Render, aucune autre plateforme n’a besoin de partager sa valeur. Si le disque persistant est supprimé, la base de données et les comptes qu’il contient risquent d’être perdus.

## Publier sur Netlify

Netlify héberge le site statique dans **`dist/`**, généré par `scripts/build.js`. La configuration `netlify.toml` configure la commande de génération, le dossier publié et la fonction proxy des API. Cette configuration statique ne suffit pas à faire fonctionner l’application complète : Netlify doit acheminer l’API vers un backend HTTPS séparé.

Pour conserver le site sur Netlify, hébergez le backend Node.js avec le Blueprint Render ci-dessus, puis :

1. Dans `APP_ORIGIN` du service Render, renseignez l’URL HTTPS exacte du site publié sur Netlify.
2. Dans les variables Netlify accessibles aux **Netlify Functions**, définissez `MONEY_EXPRESS_API_ORIGIN` sur l’URL HTTPS exacte du service Render et `NETLIFY_PROXY_SECRET` sur la même valeur secrète.
3. Connectez le projet à Netlify : `scripts/build.js` génère `dist/`, copie le logo et prépare le site et ses règles de sécurité. La fonction proxy transmet les appels `/api/*` à Render.
4. Vérifiez l’inscription client, la connexion administrateur, ainsi que la création et le suivi des demandes. Configurez aussi `APP_ORIGIN` pour chaque domaine de prévisualisation autorisé, si nécessaire.

Pour générer le secret partagé, exécutez localement :

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Saisissez la valeur obtenue directement dans la variable secrète Render `NETLIFY_PROXY_SECRET`. Si vous utilisez également Netlify, configurez exactement la même valeur dans les variables des fonctions Netlify.

La commande de génération locale est :

```powershell
node .\scripts\build.js
```

## Démarrer localement

Utilisez Node.js **22.13 ou supérieur**. Copiez `.env.example` vers `.env` et définissez un mot de passe administrateur unique d’au moins 12 caractères. Pour un démarrage local sur le port 3000, conservez `APP_ORIGIN=http://localhost:3000`, puis lancez :

```powershell
node --env-file=.env .\server.js
```

Ouvrez `http://localhost:3000` ; n’ouvrez pas directement `index.html` pour vous connecter. Les comptes, sessions et demandes sont enregistrés dans `data/money-express.sqlite`. L’inscription publique crée exclusivement des comptes clients. Les mots de passe sont hachés avec `scrypt` et les sessions utilisent un cookie `HttpOnly`, `SameSite=Strict`.

## Agences

- Massengo : 02, rue Moutala marché Massengo.
- Kinsoudi : 18, rue Ngangouoni Château d’eau Kinsoudi.
- Mfilou : 72, avenue Ngamaba Mfilou.

Le fichier `logo.jpg` contient le logo officiel copié dans `dist/assets/` lors de la génération. Vérifiez les adresses avant publication.

## Sécurité et opérations financières

Quand Netlify transmet les appels API, sa fonction signe l’adresse IP du client avec `NETLIFY_PROXY_SECRET` afin que les limites anti-abus du backend continuent de distinguer les clients. Gardez ce secret confidentiel et synchronisé entre Netlify et Render ; ne l’insérez jamais dans les fichiers `dist/`. Une préparation de transfert ne réalise aucun transfert ni paiement. Avant toute utilisation avec de vrais clients, protégez les secrets d’administration, sauvegardez le stockage persistant et faites vérifier par l’entreprise sa politique de gestion et de conservation des données.

Dans `app.js`, configurez également `WHATSAPP_NUMBER` avec le numéro officiel confirmé au format international, sans `+`, espaces ni tirets.
