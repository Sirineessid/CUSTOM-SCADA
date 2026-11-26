# Images superposées et couleur pilotée par un tag (custom-SCADA)

Deux scripts réutilisables, paramétrés par le **nom du site** (les sites sont créés par l'utilisateur dans l'éditeur, ils ne sont pas codés en dur).

## 1. Appliquer la configuration à un site

```bash
node tools/apply-site-color-visibility.js --site <nom-du-site> --host http://127.0.0.1:1884
```

Options :
- `--view Accueil` (défaut) : vue à modifier.
- `--state-tag pompe1_etat_num` (défaut) : tag numérique créé s'il n'existe pas ; `0 = arrêt`, `1 = marche`, `2 = défaut`.
- `--pump-item <id>` : identifiant de la forme « pompe » à recolorer aussi (défaut : la pompe 1 du modèle site-pilote).
- `--no-pump` : ne pas modifier la forme existante (uniquement les 3 images).

Le script :
1. ajoute le tag numérique au périphérique `FUXA Server` du site ;
2. téléverse 3 images SVG (verte / bleue / rouge) dans `resources/` ;
3. ajoute 3 objets **`Image (lien)`** strictement superposés sur la vue, each with an onglet **Visibilité** rule on the tag (`égale à 1`, `égale à 0`, `égale à 2`) and **Contrôle traversant** on the two upper images;
4. remplace les plages de couleur de la pompe existante par `0 → bleu`, `1 → vert`, `2 → rouge`;
5. enregistre la vue via `POST /api/projectData` (`cmd: set-view`) — le fichier `fichiers/accueil.html` est régénéré automatiquement.

Le script est **idempotent** : vous pouvez le relancer, il remplace ses propres objets.

## 2. Tester

Ouvrez la supervision : `http://127.0.0.1:1884/site/<nom-du-site>/home/<vue>`.

Puis poussez une valeur de tag :

```bash
node tools/test-site-color-visibility.js --site <nom-du-site> --value 0   # arrêt  -> image bleue, pompe bleue
node tools/test-site-color-visibility.js --site <nom-du-site> --value 1   # marche -> image verte, pompe verte
node tools/test-site-color-visibility.js --site <nom-du-site> --value 2   # défaut -> image rouge, pompe rouge
```

Le script utilise un WebSocket Socket.IO brut (aucun npm supplémentaire) et vérifie la valeur lue via `/api/v1/sites/<site>/values`.

## 3. Brancher une source réelle (PostgreSQL, OPC UA, automate…)

Le mécanisme ne dépend pas de la source : il suffit que le tag pilotant la visibilité/couleur soit numérique `0/1/2`.

- **OPC UA / automate** : créer dans le site un périphérique OPC UA/S7/Modbus, ajouter le tag d'état, puis passer `--state-tag <nom>` au script (ou réutiliser le tag existant)
- **PostgreSQL** : créer un périphérique PostgreSQL avec une requête qui renvoie l'état (0/1/2), puis binder ce tag
- **Autre** : tout tag FUXA numérique fait l'affaire

Si l'état est déjà réparti sur deux booléens (`marche`, `défaut`), utilisez directement l'onglet **Visibilité** dans l'éditeur :
- image verte : `Contrôlé par un bit` = marche ON **et** `Contrôlé par un mot` = défaut `égale à 0`
- image bleue : marche OFF **et** défaut `égale à 0`
- image rouge : défaut ON

Les deux conditions d'une même image sont combinées avec **ET** (`shape-style.helper.js` → `processVisibility`).

## 4. Visibilité booléenne (False = masqué / True = visible) sur un objet ou une image importée

```bash
# créer le tag booléen et l'appliquer à un objet existant
node tools/apply-tag-visibility.js --site <nom> --tag t_visibility_test --create-tag \
     --item <id-de-l-objet>

# importer une image et lui ajouter la même propriété
node tools/apply-tag-visibility.js --site <nom> --tag t_visibility_test \
     --image C:\images\mon_image.png --name mon_image --x 100 --y 100 --w 120 --h 120
```

Options utiles :
- `--show-when off` : inverser la règle (visible quand le tag est False).
- `--penetration` : laisse passer les clics à travers l'objet (utile si plusieurs images sont superposées).

La propriété écrite est `property.style.visibility` avec `byBit: true`, `bitVariableId: <tag>`, `bitShowWhen: on|off`. Elle est relue à chaque changement du tag : `False` masque l'objet (`visibility: hidden`), `True` l'affiche.

Tester :

```bash
node tools/test-site-color-visibility.js --site <nom> --tag t_visibility_test --value false
node tools/test-site-color-visibility.js --site <nom> --tag t_visibility_test --value true
```

Le tag peut bien sûr provenir d'un périphérique PostgreSQL, OPC UA, S7, Modbus, MQTT… : il suffit qu'il soit booléen et lié à l'objet.

## 5. Déploiement : donner le travail, pas le code source

Le bouton **Déployer** d'un site envoie déjà uniquement le **paquet du site** (`packageSite()` → `buildZip()` dans `server/runtime/sites/index.js`) : projet, pages HTML générées, historique, images — jamais `client/src`, `tools/` ni l'historique Git. Mais le poste cible doit recevoir une installation **runtime-only** :

```bash
node tools/build-runtime-package.js
# -> dist-release/fuxa-runtime-only.zip  (~16 Mo, 754 fichiers)
```

Le zip contient uniquement `client/dist/` (UI compilée) et le nécessaire à `server/` (dont `deployment-agent/`). Il exclut : `client/src`, `client/e2e`, `client/test`, `tools/`, `snapshots/`, `.git/`, `node_modules/`, `_appdata/`, `server/sites/`, logs et bases locales.

Sur le poste client :
1. dészipper, puis `cd fuxa-runtime/server && npm ci --omit=dev` ;
2. configurer l'agent (`FUXA_DEPLOYMENT_TOKEN` ≥ 32 caractères, `FUXA_RUNTIME_HOME`, TLS) comme décrit dans `server/deployment-agent/README.md` ;
3. recevoir les releases via **Déployer → Publier** : seul le projet du site est transféré et redémarré.

Pour limiter l'accès dans l'UI du site déployé, dans `_appdata/mysettings.json` du site cible :
- `secureEnabled: true` et un `secretCode` persisté ;
- `secureOnlyEditor: false` (les écritures/commandes demandent aussi une session authentifiée) ;
- `swaggerEnabled: false`, `nodeRedEnabled: false`.

Dans le projet du site (`layout`) : `hidenavigation: true`, `loginonstart: true`, et des `permissionRoles` sur les pages/boutons sensibles. En mode IIS, le runtime reste lié à `127.0.0.1` (`FUXA_SITE_BIND_HOST`) et n'est exposé que via le reverse-proxy IIS en HTTPS.

⚠️ Le dépôt GitHub est public : le code source y est visible par tous. Ne donnez pas l'accès au dépôt au client ; le paquet runtime, lui, ne contient pas le code source.
