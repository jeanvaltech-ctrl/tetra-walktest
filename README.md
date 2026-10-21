# TETRA Walk-Test

> **EN** — Open-source indoor TETRA coverage survey tool for the **Motorola MTP6550**, replacing
> Motorola SCOUT. Web app for Edge / Chrome (Web Serial, works offline once loaded), interface in
> **French, Dutch and English**: floor plans, live serving/neighbour cells, waypoint walk-test with
> RSSI-coloured trace, real-time ASTRID compliance (> -88 dBm on 95 % of the floor area), CSV / PNG
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

Mode démonstration sans radio : ajouter `?demo` à l'adresse (radio simulée).

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

### Dossier projet (recommandé)

Préparer un dossier par bâtiment, avec un plan par étage dans un sous-dossier `plans` :

```
SSV_Site_21-10-2026/            nom du dossier = nom du projet
  plans/                        Floor -1.png, Floor 00.jpg, Floor 01.png…
  SSV_Site_21-10-2026.walktest.json   créé par l'appli à l'enregistrement
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

Recommandation ASTRID pour l'indoor : niveau **meilleur que -88 dBm sur 95 % de la surface**
(sinon, installation indoor ASTRID exigée par la commission de sécurité, IBZ). L'appli l'évalue
en direct :

- **panneau live** : « ✔ Conforme ASTRID » / « ✘ Insuffisant » pour la mesure en cours ;
- **par étage** (panneau Mesure, liste des étages ✔ / ✘) : pourcentage conforme, comparé à
  l'objectif. La surface est approchée par la **longueur parcourue** (chaque mesure compte pour
  le bout de trajet qu'elle couvre ; rester sur place ne fausse rien) ; le pourcentage par
  nombre de points est affiché à titre indicatif. Les pourcentages sont arrondis vers le bas ;
- **exports** : colonne `astrid_ok` (1 / 0) dans le CSV, verdict dans le bandeau du PNG.

« Meilleur que -88 dBm » = strictement supérieur, soit -87 dBm ou mieux (le vert de la légende
SCOUT). Seuil et pourcentage sont réglables dans « Seuils RSSI et critère ASTRID ».

### Enregistrer et exporter

- **Enregistrer** (Ctrl+S) : un fichier `<projet>.walktest.json` contient tout le projet (plans,
  calibration, seuils, mesures placées, identité radio et **trames radio brutes** horodatées,
  pour pouvoir tout recalculer plus tard). « Ouvrir… » reprend un projet.
- **Exporter CSV** (par étage) : séparateur `;`, UTF-8 avec BOM, point décimal. Colonnes :
  `date;time;floor;segment;x;y;x_m;y_m;la;channel;rssi;c1;n1_la;n1_channel;n1_rssi;n1_cx;…;n4_cx;astrid_ok`
  (`x`, `y` en pixels du plan, origine en haut à gauche ; `x_m`, `y_m` si l'étage est calibré).
- **Exporter PNG** : le plan à sa taille réelle avec la trace, la légende, l'échelle et un bandeau
  (projet, étage, horaire, nombre de mesures, ISSI de la radio).
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
  confirmation : un tronçon parcouru sans radio n'a aucune mesure.

## Développement

Aucune dépendance ni étape de build : HTML, CSS et JavaScript (modules ES) servis tels quels.

```bash
python -m http.server 8000
```

Puis ouvrir dans Edge ou Chrome :

- `http://localhost:8000/` : l'appli ;
- `http://localhost:8000/tests/` : les tests (décodeur, géométrie, radio sur faux port,
  session, exports, sauvegarde).

Web Serial et le service worker exigent `https://` ou `localhost` (pas `file://`).
Après une modification, incrémenter `VERSION` dans `sw.js` si la liste des fichiers change.

**Données de test** : `tests/fixtures/demo.atp` est une vraie mesure SCOUT anonymisée par
`tools/anonymize_atp.py` (identité radio, LA et canaux remplacés par des valeurs fictives,
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
