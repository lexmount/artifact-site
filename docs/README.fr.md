<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/artifact-site-banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/artifact-site-banner.png">
    <img src="assets/artifact-site-banner.png" alt="artifact-site — Un espace commun pour les pages et documents générés par l'IA, sur votre propre serveur. Open source, auto-hébergé, prêt pour les agents." width="1000">
  </picture>
</p>

<h1 align="center">artifact-site</h1>

<p align="center">
  <a href="../README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.de.md">Deutsch</a> |
  <strong>Français</strong> |
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/lexmount/artifact-site/actions/workflows/ci.yml"><img src="https://github.com/lexmount/artifact-site/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#licence"><img src="https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue.svg" alt="Licence : Apache-2.0 OR MIT"></a>
  <a href="../.nvmrc"><img src="https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen.svg" alt="Node 24"></a>
  <a href="../ROADMAP.md"><img src="https://img.shields.io/badge/roadmap-what's%20next-8a5a2b.svg" alt="Feuille de route"></a>
</p>

<p align="center"><sub>Cette traduction est maintenue en parallèle de la <a href="../README.md">version anglaise</a> ; en cas de divergence, l'anglais fait foi.</sub></p>

Les outils d'IA produisent chaque jour davantage de travail fini : graphiques interactifs, rapports d'analyse, prototypes web et présentations. Ce travail finit souvent dispersé entre historiques de conversation, dossiers locaux et outils divers, sans lieu commun pour le parcourir, le partager ou le maintenir. Le montrer à quelqu'un suppose encore de le déployer, d'envoyer des fichiers ou de faire une capture d'écran ; retrouver plus tard la dernière version demande un effort supplémentaire.

**artifact-site rassemble ce travail sur votre propre serveur, sous forme de liens que vous pouvez partager, mettre à jour et rechercher.** Voyez-le comme un espace de travail auto-hébergé pour les artefacts de votre équipe, comparable à Claude Artifacts ou OpenAI Sites : vos outils d'IA ou vos outils internes créent le travail, artifact-site le publie et le gère. Téléversez du HTML, des sites statiques ou des documents pour que votre équipe puisse les consulter en ligne, en contrôler l'accès et en conserver les révisions. Les agents de codage peuvent eux aussi publier, mettre à jour, rechercher et lire le travail existant.

> **Essayez sans rien installer :** [artifact-site.app.lexmount.com](https://artifact-site.app.lexmount.com/) fait tourner ce code comme service hébergé. Déposez un fichier pour publier anonymement (les sites anonymes y expirent après quelques jours), ou connectez-vous pour conserver votre travail. C'est une démo partagée : considérez ce que vous y publiez comme public.

<p align="center"><img src="assets/demo.gif" alt="Un tableau de bord HTML déposé sur artifact-site : il devient un lien en quelques secondes, s'affiche dans un cadre isolé, et le panneau de partage copie le lien" width="820"></p>
<p align="center"><sub><b>Déposez un fichier, obtenez un lien, partagez-le.</b> Consultez votre travail publié en ligne et choisissez qui peut l'ouvrir dans les réglages de partage.</sub></p>

## Pourquoi artifact-site

- **Gardez le travail à un seul endroit.** Organisez pages et documents dans des dossiers et retrouvez-les par recherche plein texte, y compris en chinois. Les membres de l'équipe et les agents trouvent le travail auquel ils ont accès.
- **Déposez et partagez.** Téléversez du HTML, un dossier de build, un ZIP ou un document pour obtenir un lien. Les sites volumineux sont envoyés par morceaux. Partagez avec tout le monde, les utilisateurs connectés, des personnes nommées ou les détenteurs d'un code d'accès.
- **Continuez d'améliorer le travail publié.** Modifiez le texte ou la source HTML dans le navigateur, ou laissez un agent mettre à jour tout le site. Chaque modification conserve une version, avec retour en arrière et possibilité d'enregistrer une copie.
- **Laissez les agents reprendre là où ils s'étaient arrêtés.** Publiez et mettez à jour via le guide, la CLI ou MCP, puis recherchez par contenu et lisez le texte extractible. Par exemple, retrouvez un rapport précédent et mettez-le à jour à la même adresse pour que votre équipe le consulte.

## Sommaire

- [Ce que vous pouvez publier](#ce-que-vous-pouvez-publier)
- [Démarrage rapide (déploiement local)](#démarrage-rapide-déploiement-local)
- [Connecter un agent de codage](#connecter-un-agent-de-codage)
- [Déployer pour votre équipe](#déployer-pour-votre-équipe)
- [Fonctionnement](#fonctionnement)
- [Documentation](#documentation)
- [Contribuer](#contribuer)
- [Licence](#licence)

## Ce que vous pouvez publier

| Contenu | Ce que vous pouvez faire |
| --- | --- |
| HTML, dossiers de sites statiques, ZIP | Téléverser et prévisualiser des sites d'une ou plusieurs pages, y compris la sortie de build comme `dist/`. Les pages HTML acceptent l'édition visuelle du texte et l'édition de la source. |
| PDF | Lire en ligne, rechercher et extraire le texte. |
| Documents Office, comme PPTX et DOCX | Stocker et télécharger les originaux ; activer Gotenberg pour l'aperçu en ligne. |

Compilez les projets web en fichiers statiques avant de les téléverser ; la plateforme n'exécute ni backends d'application ni tâches de build. Les documents PDF et Office ne prennent pas en charge l'édition HTML visuelle, et les images numérisées ne passent pas automatiquement par l'OCR.

Les pages hébergées s'exécutent dans un bac à sable et ne peuvent pas utiliser la session de connexion de la plateforme. Les connexions à des API externes exigent une liste d'origines autorisées. Voir les [limites d'exécution](../src/content/publish-skill.md) et la [conception de la sécurité](../SECURITY.md).

## Démarrage rapide (déploiement local)

Avec Git, Make, Docker 24+ et le plugin Compose 2.24+ installés, exécutez ces commandes sur une machine Linux. Aucune installation de Node, aucun domaine ni fournisseur d'identité n'est nécessaire.

```bash
git clone https://github.com/lexmount/artifact-site.git && cd artifact-site
cp .env.example .env
make build up
```

Une fois démarré, ouvrez **http://127.0.0.1:4300** et déposez du HTML, un dossier de site statique ou un PDF pour voir votre travail. Les nouveaux sites sont privés par défaut ; créez un lien avec l'accès voulu dans le partage (Sharing) avant de l'envoyer à quelqu'un.

Le premier lancement télécharge les dépendances et construit l'image, puis démarre l'application et Postgres. Utilisez ces commandes dans un clone tout neuf. Le service n'est accessible qu'en local par défaut ; `make down` l'arrête et conserve les données. Pour le rendre accessible à votre équipe, suivez [Déployer pour votre équipe](#déployer-pour-votre-équipe).

<details>
<summary>Besoin d'un fichier pour essayer ? Créez une page d'exemple</summary>

```bash
printf '<!doctype html><meta charset="utf-8"><title>Hello</title><h1>Hello, artifact-site!</h1>' > hello.html
```

Déposez `hello.html` sur la page d'accueil (ou choisissez **Upload**). Vous devriez voir « Hello, artifact-site! ». Copiez un lien depuis les réglages de partage ; les liens d'un déploiement local ne s'ouvrent que sur la même machine.

</details>

## Connecter un agent de codage

Ouvrez **Agent guide** (le guide des agents) sur votre déploiement pour choisir la voie du prompt, de la CLI ou de MCP. `/for-agents#cli` et `/for-agents#mcp` fournissent les commandes propres au serveur, les étapes d'authentification et la configuration des clients. Le MCP distant authentifie chaque requête : ChatGPT, Claude et les autres clients compatibles OAuth se connectent via la page de consentement du serveur, les autres clients portent un jeton personnel. Publier, mettre à jour, partager et supprimer via la CLI exigent un jeton ; la publication crée par défaut un partage public. Utilisez `--share none` (CLI) ou `share: false` (MCP) pour ne pas partager.

<p align="center"><img src="assets/agent.gif" alt="Un agent de codage publie un dossier de build avec la CLI artifact-site et renvoie le lien de partage" width="820"></p>
<p align="center"><sub><b>Ou laissez faire votre agent de codage.</b> Avec le guide des agents (<code>/for-agents.md</code>), la CLI ou le serveur MCP, « publie ceci et donne-moi un lien » tient en une seule instruction — et le site peut être mis à jour, recherché et lu de la même façon.</sub></p>

Donnez cette instruction à Claude Code, Cursor, Codex ou tout autre agent de codage capable de lire des URL, avec une adresse de serveur qu'il peut atteindre. La page d'accueil propose aussi un bouton de copie avec l'adresse de votre serveur déjà renseignée :

```text
Publie la sortie de ce projet sur artifact-site. Guide de publication : https://your-server/for-agents.md
```

Les déploiements d'équipe avec OIDC prennent en charge l'approbation de connexion d'appareil ; l'installation locale anonyme ci-dessus n'en a pas besoin. L'agent suit le guide et la politique de publication du serveur pour choisir l'authentification. Un agent dans le cloud ne peut pas atteindre directement `127.0.0.1` sur votre ordinateur.

La CLI requiert Node 24+. En attendant la publication du paquet npm, suivez les [instructions d'installation de la CLI](../cli/README.md) pour la compiler et l'installer depuis la source, puis exécutez :

```bash
artifact-site login --base https://your-server        # connexion d'appareil, une seule fois
artifact-site publish dist/ --title "Q3 dashboard"    # publier et renvoyer les liens
artifact-site find "quota"                           # rechercher par contenu
artifact-site read YOUR_SITE_SLUG                    # remplacer par le slug d'un site pour lire son texte
```

L'exemple de connexion requiert OIDC. Le MCP distant est un point d'entrée distinct et complet à l'adresse `https://your-server/mcp` : aucune installation de la CLI n'est nécessaire. ChatGPT, Claude et tout client qui implémente l'autorisation MCP se connectent avec la seule adresse et s'authentifient via la page de consentement OAuth du serveur ; pour les autres clients, la page `/for-agents#mcp` du déploiement crée un jeton personnel et copie la configuration authentifiée. Il prend en charge la publication, la mise à jour, la recherche, la lecture, le partage, les versions, l'export et la suppression, y compris les fichiers binaires et l'envoi de répertoires via les outils MCP.

Voir les [commandes de la CLI](../cli/README.md) et la [configuration et les outils du MCP distant](MCP.md).

## Déployer pour votre équipe

Partez de [.env.example](../.env.example) et suivez [SELFHOST.md](../SELFHOST.md) pour un déploiement en production. Utilisez une adresse publique stable pour `ARTIFACT_PUBLIC_URL` : les rappels de connexion, les vérifications d'origine des requêtes et l'adresse donnée aux agents en dérivent :

- Définissez une `ARTIFACT_PUBLIC_URL` joignable et configurez un reverse proxy, ou définissez `ARTIFACT_WITH_CADDY=on` avec `ARTIFACT_DOMAIN` pour activer Caddy et les certificats automatiques.
- Choisissez une politique de publication. `login` exige OIDC ; `token` sert les scripts ou agents munis d'un jeton Bearer ; `open` laisse publier quiconque peut atteindre le service et convient aux réseaux internes de confiance. La publication anonyme accepte des quotas et une expiration distincts.
- Connectez Google ou un fournisseur OIDC tel que Keycloak, Logto, Authentik, Okta ou Auth0. Les comptes possèdent les sites et les dossiers ; les agents peuvent recevoir des jetons de longue durée via la connexion d'appareil. La valeur par défaut `ARTIFACT_ENFORCE_OWNERSHIP=on` active le contrôle d'accès par compte dès qu'OIDC est configuré. Ajoutez les adresses e-mail de connexion vérifiées des administrateurs à `ARTIFACT_ADMIN_EMAILS` pour activer la console d'administration.
- Activez l'aperçu Office avec `ARTIFACT_WITH_GOTENBERG=on`. La console d'administration gère les retraits, les quotas, l'expiration des sites anonymes et les commutateurs de politique. Choisissez la visibilité par défaut et planifiez les sauvegardes.

L'application est livrée sous forme d'une seule image Docker, avec Postgres intégré dans la configuration mono-hôte. Pour utiliser une image préconstruite disponible, définissez `ARTIFACT_IMAGE` et exécutez `make pull`. `make doctor` vérifie la configuration ; `make backup` et `make restore` gèrent les sauvegardes et la restauration. Pour plusieurs réplicas, un Postgres externe et un stockage compatible S3, voir [DEPLOY.md](../DEPLOY.md).

## Fonctionnement

- **Application et stockage.** Next.js sert l'interface et l'API, Postgres stocke les métadonnées, et les fichiers résident sur le disque local ou dans un stockage compatible S3. Une base de données et un stockage objet externes permettent plusieurs réplicas de l'application.
- **Versions immuables.** Chaque téléversement ou modification écrit une nouvelle version du fichier et préserve le contenu antérieur. Le verrouillage optimiste (`expected_version`) détecte les conflits de mises à jour simultanées.
- **Isolation du contenu.** Les aperçus utilisent des iframes en bac à sable sans `allow-same-origin` et une CSP restrictive pour isoler le contenu téléversé de la plateforme. Les vérifications de chemin et les limites de décompression protègent contre la traversée de répertoires et les bombes ZIP.

Voir [ARCHITECTURE.md](../ARCHITECTURE.md) pour l'architecture, le modèle de données et les flux de requêtes.

## Documentation

| Document | Contenu |
| --- | --- |
| [SELFHOST.md](../SELFHOST.md) | Déploiement sur une seule machine avec `make up`, sauvegardes, mises à niveau, FAQ |
| [DEPLOY.md](../DEPLOY.md) | Déploiement multi-réplicas : Postgres externe, stockage objet, OIDC |
| [.env.example](../.env.example) | Chaque réglage, regroupé et expliqué |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Forme du système, modèle de données, chemins des requêtes, le bac à sable |
| [SECURITY.md](../SECURITY.md) | Modèle de menace et comment signaler une vulnérabilité |
| [cli/README.md](../cli/README.md) | La CLI |
| [src/content/publish-skill.md](../src/content/publish-skill.md) | Le contrat d'API et les limites d'hébergement, tels que servis aux agents |
| [ROADMAP.md](../ROADMAP.md) | La suite : recherche sémantique, commentaires sur les sites, et plus |
| [CHANGELOG.md](../CHANGELOG.md) | Ce qui a changé, version par version |

## Contribuer

Le développement local requiert Node 24+ et Docker :

```bash
npm install
make dev          # démarrer un Postgres jetable et le serveur de développement
npm test          # tests unitaires, sans service externe
```

Voir [CONTRIBUTING.md](../CONTRIBUTING.md) pour le processus de contribution, la signature DCO et les exigences de la CI. Signalez bugs et idées dans les [issues](https://github.com/lexmount/artifact-site/issues) ; posez vos questions dans les [discussions](https://github.com/lexmount/artifact-site/discussions).

## Licence

Sous licence, au choix,

- Apache License, version 2.0 ([LICENSE-APACHE](../LICENSE-APACHE))
- Licence MIT ([LICENSE-MIT](../LICENSE-MIT))

Sauf déclaration explicite de votre part, toute contribution que vous soumettez intentionnellement pour inclusion dans ce projet est placée sous cette double licence, sans conditions supplémentaires.

© 2025–2026 LexMount. Les composants tiers sont listés dans [NOTICE](../NOTICE).
