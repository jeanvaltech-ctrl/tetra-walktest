# TETRA Walk-Test

> **EN** — Open-source indoor TETRA coverage survey tool for the **Motorola MTP6550**, replacing
> Motorola SCOUT. Web app for Edge / Chrome (Web Serial, works offline once loaded), interface in
> **French, Dutch and English**: floor plans, live serving/neighbour cells, waypoint walk-test with
> RSSI-coloured trace, real-time ASTRID compliance (at least 95 % of measured points at -88 dBm or better), CSV / PNG
> export. Live app: https://jeanvaltech-ctrl.github.io/tetra-walktest/ — documentation below is in French.

Outil open source de mesure de couverture TETRA indoor avec un terminal **Motorola MTP6550**,
en remplacement de Motorola SCOUT (plus maintenu). Appli web pour **Edge / Chrome** sous Windows,
qui lit la radio via l'API Web Serial : rien à installer, et elle fonctionne **hors ligne** sur
site (sous-sols, parkings) une fois chargée.

Fonctions : projet multi-étages avec plans (PNG, JPG), calibration d'échelle, connexion à la radio
avec identité et panneau en direct, mesure par waypoints avec trace colorée selon des seuils RSSI
configurables, export CSV / PNG, sauvegarde du projet, copie de secours automatique et reprise
après incident.

Le projet se limite à la **lecture des mesures** radio : il ne touche à aucune fonction de
sécurité du réseau (authentification, chiffrement).

## Utiliser l'appli

**Appli en ligne : https://jeanvaltech-ctrl.github.io/tetra-walktest/** (Edge ou Chrome).
Au premier chargement, elle est mise en cache pour fonctionner ensuite sans réseau : l'ouvrir une
fois avec une connexion avant d'aller sur site. Edge propose aussi de l'installer comme une
application (icône dans la barre d'adresse).

**Connexion** : fermer SCOUT (un seul programme à la fois sur le port), cliquer « Connecter la
radio… » et choisir **« Motorola Solutions Portable Tetra Radio Port 1 »** (COM5 en général).
Le « Port 2 » est l'interface AT de la radio et ne répond pas.

Mode démonstration sans radio : ajouter `?demo` à l'adresse (radio simulée). Pour montrer une zone
sans couverture (~10 s toutes les ~40 s) : `?demo=noservice` (trames sans cellule serveuse) ou
`?demo=silent` (plus aucune trame).

**Langue** : français, néerlandais ou anglais (boutons FR | NL | EN en haut à droite). Par défaut,
la langue du navigateur ; le choix est mémorisé. Les noms de colonnes du CSV ne changent pas.

### Mesurer

1. Créer un projet (nom, bâtiment, étage, plan), et calibrer l'échelle si besoin (2 points +
   distance connue).
2. Connecter la radio, puis « Démarrer » et cliquer sa position de départ sur le plan.
3. Marcher et cliquer sa position à chaque virage ou repère : les mesures reçues entre deux
   clics sont réparties sur le tronçon, au prorata du temps (pauses exclues).
4. « Pause » (ou barre d'espace) : les mesures ne sont plus enregistrées.
   « Annuler le point » (Ctrl+Z) : retire le dernier clic, ses mesures seront replacées au suivant.
5. « Fin de segment » / « Terminer » : cliquer d'abord le dernier point, sinon les mesures
   reçues depuis le dernier clic sont perdues (l'appli demande confirmation).

**Pas de service** : après 3 s de marche sans mesure valide de la cellule serveuse (pauses
exclues), l'appli ajoute un point « pas de service » par seconde manquante, depuis la dernière
mesure valide. Ils sont tracés en noir à tirets blancs et comptent **non conformes**, comme un
niveau sous -98 dBm. Si la radio n'envoie plus aucune trame, l'appli affiche aussi « Aucune trame
reçue : vérifier la radio ».

### Dossier projet (recommandé)

Préparer un dossier par bâtiment, avec un plan par étage dans un sous-dossier `plans` :

```
SSV_Site_01-01-2000/            nom du dossier = nom du projet
  plans/                        Floor -1.png, Floor 00.jpg, Floor 01.png…
  SSV_Site_01-01-2000.walktest.json   créé par l'appli à l'enregistrement
  exports/                      créé par l'appli : PNG et CSV
```

« **Ouvrir un dossier projet…** » crée un étage par plan, triés du plus bas au plus haut d'après le
numéro dans le nom (`-1`, `00`, `01`…). Ensuite, sans aucune boîte de dialogue : Ctrl+S enregistre
le projet dans le dossier, et les exports vont dans `exports/`. En rouvrant le même dossier plus
tard, on reprend le projet là où on l'avait laissé ; les plans ajoutés entre-temps deviennent de
nouveaux étages. Les fichiers autres que PNG / JPG (PDF…) sont signalés et ignorés.

### Plusieurs étages

Chaque étage a son plan, son échelle et ses mesures (panneau **Étages**). « Ajouter un étage… »
(ou glisser un plan sur la zone centrale) ; choisir l'étage dans la liste déroulante, ou passer à
l'étage du dessous / du dessus avec ▼ / ▲ (touches Page↓ / Page↑).

- **Changer d'étage en pleine mesure** : cliquer d'abord son dernier point, puis l'étage suivant :
  la mesure se termine sur l'ancien étage et reprend aussitôt sur le nouveau, il n'y a plus qu'à
  cliquer sa position de départ.
- **Compléter un étage plus tard** (bâtiment qu'on ne peut pas faire d'une traite) : revenir sur
  l'étage et cliquer « **Continuer les mesures** » : les nouveaux passages s'ajoutent aux
  précédents, rien n'est effacé.

### Critère ASTRID

Règle appliquée : **au moins 95 % des points mesurés à -88 dBm ou mieux**, radio portée à la
ceinture (perte corporelle incluse) ; sinon, une installation indoor ASTRID est nécessaire. C'est la
règle du modèle de rapport Connext et de CRG. « -88 dBm ou mieux » suit les annexes techniques de la
convention ASTRID, qui parlent d'un niveau **minimum** de -88 dBm. Les points « pas de service »
comptent comme des points non conformes. L'appli l'évalue en direct :

- **panneau live** : « ✔ Conforme ASTRID » / « ✘ Insuffisant » pour la mesure en cours ;
- **par étage** (panneau Mesure, liste des étages ✔ / ✘) : **% des points** conformes, qui fait
  foi, comparé à l'objectif. Le % de la **distance parcourue** (chaque mesure compte pour le bout
  de trajet qu'elle couvre) est affiché à titre d'information. Les pourcentages sont arrondis vers
  le bas ;
- **exports** : colonnes `astrid_ok` et `no_service` (1 / 0) dans le CSV ; verdict en % des points,
  % de la distance en information, parts des points sans service et sous le dernier seuil dans le
  bandeau du PNG.

Seuil et pourcentage sont réglables dans « Seuils RSSI et critère ASTRID ». Question ouverte, non
tranchée : -88 dBm s'applique ici radio portée (perte corporelle incluse), alors que l'Annexe 6 de
la convention ASTRID donne -98 dBm pour une mesure radio portée.

### Enregistrer et exporter

- **Enregistrer** (Ctrl+S) : un fichier `<projet>.walktest.json` contient tout le projet (plans,
  calibration, seuils, mesures placées, identité radio et **trames radio brutes** horodatées,
  pour pouvoir tout recalculer plus tard). « Ouvrir… » reprend un projet.
- **Exporter CSV** (par étage) : séparateur `;`, UTF-8 avec BOM, point décimal. Colonnes :
  `date;time;floor;segment;x;y;x_m;y_m;la;channel;rssi;c1;n1_la;n1_channel;n1_rssi;n1_cx;…;n4_cx;astrid_ok;no_service`
  (`x`, `y` en pixels du plan, origine en haut à gauche ; `x_m`, `y_m` si l'étage est calibré ;
  `no_service` = 1 : point « pas de service », cellules de mesure vides et `astrid_ok` à 0).
- **Exporter PNG** : le plan à sa taille réelle avec la trace, la légende, l'échelle et un bandeau
  (projet, étage, horaire, nombre de points, verdict ASTRID en % des points avec la distance
  parcourue en information, « pas de service : x % », « < -98 dBm : y % » des points, ISSI de la radio).
- **Exporter tous les étages…** : dans un dossier choisi, le PNG et le CSV de chaque étage, plus
  un CSV commun « tous les étages » trié par heure.

### Incidents

- **Copie de secours** : le projet en cours est copié automatiquement dans le navigateur
  (IndexedDB) toutes les 3 s pendant la mesure. Après un crash, une fermeture d'onglet ou une
  coupure, l'écran d'accueil propose **« Reprendre ce projet »** : une mesure en cours revient
  **en pause au dernier point cliqué**, avec ses mesures en attente. Elle ne remplace pas
  « Enregistrer » : elle est liée à ce navigateur et à cette adresse, et ne garde qu'un projet.
- **Câble arraché** : la mesure passe en pause. Un câble arraché en plein flux **bloque la radio**
  (elle ne répond plus, même rebranchée ; c'était déjà le cas avec SCOUT) : rebrancher le câble,
  puis **éteindre et rallumer la radio**. L'appli le signale et se reconnecte toute seule une fois
  la radio rallumée. Attendre « Radio en mesure », puis « Reprendre » à sa position.
  Pour arrêter proprement, cliquer « Déconnecter » avant de débrancher.
- Sans radio connectée, « Démarrer », « Reprendre » et les clics sur le plan demandent
  confirmation : un tronçon parcouru sans radio n'a aucune mesure et compte comme « pas de service ».

## Développement

Aucune dépendance ni étape de build : HTML, CSS et JavaScript (modules ES) servis tels quels.

```bash
python -m http.server 8000
```

Puis ouvrir dans Edge ou Chrome :

- `http://localhost:8000/` : l'appli ;
- `http://localhost:8000/tests/` : les tests (décodeur, géométrie, radio sur faux port,
  session, exports, sauvegarde).

Tests des outils Python (bibliothèque standard seulement), depuis la racine du dépôt :
`python3 -m unittest discover -s tests -p 'test_*.py'`.

Web Serial et le service worker exigent `https://` ou `localhost` (pas `file://`).
Après une modification, incrémenter `VERSION` dans `sw.js` si la liste des fichiers change.

**Données de test** : `tests/fixtures/demo.atp` est une vraie mesure SCOUT anonymisée par
`tools/anonymize_atp.py` (identité radio, LA et canaux remplacés par des valeurs fictives,
date et heure de l'en-tête remplacées par 01.01.2000 00:00:00, chemins SCOUT supprimés,
trames non nécessaires supprimées). Ne jamais ajouter de vraie mesure au dépôt : le
`.gitignore` exclut les `.atp`, les exports et les projets `.walktest.json`.

| Chemin | Rôle |
|---|---|
| `js/protocol.js` | trames, commandes, décodage des blocs de mesure |
| `js/radio.js` | connexion Web Serial, identité, flux de mesure, arrêt propre |
| `js/session.js` | mesure par waypoints : segments, interpolation, pause, annulation |
| `js/app.js` | interface (panneaux, calibration, mesure, fichiers, reconnexion) |
| `js/planview.js` | affichage du plan : déplacement, zoom molette / pinch, clics |
| `js/render.js` | dessin de la trace, de la légende et de l'échelle (écran et export) |
| `js/export.js` | export CSV et PNG par étage |
| `js/project.js` | modèle de projet et fichier `.walktest.json` |
| `js/folder.js` | dossier projet : plans, tri des étages, projet enregistré |
| `js/criterion.js` | critère ASTRID : conformité par mesure et par étage |
| `js/strings.js` | **tous les textes de l'interface, FR / NL / EN côte à côte** (à relire / compléter ici) |
| `js/i18n.js` | choix de la langue, traduction (`t()`), formatage des nombres |
| `js/autosave.js` | copie de secours continue dans le navigateur (IndexedDB) |
| `js/thresholds.js` | seuils RSSI et couleurs (légende SCOUT) |
| `js/geometry.js` | transformation écran ↔ plan, calculs d'échelle |
| `js/atp.js` | lecture des fichiers SCOUT `.atp` |
| `js/simport.js` | radio simulée (`?demo`) |
| `sw.js` | cache hors ligne |
| `tests/` | tests navigateur et jeu de test anonymisé |
| `tools/` | outils Python : lecture en direct, `.atp` → CSV, anonymisation |
| `docs/PROTOCOL.md` | protocole du MTP6550 (rétro-ingénierie de SCOUT) |

## Licence

MIT — voir [LICENSE](LICENSE). © 2026 Jean Pauwels (JEANVAL TECH SRL).
