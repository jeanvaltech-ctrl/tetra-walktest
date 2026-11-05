# Contrat du CSV exporté

Ce que TETRA Walk-Test écrit et que CRG (Connext Reports Generator) lit. Toute évolution de l'export
doit respecter ce document. Code : `js/export.js` (colonnes, fichiers), `js/criterion.js` (verdict, %).

## Fichiers

| Fichier | Contenu |
|---|---|
| `<projet> - <étage>.csv` | les mesures d'un étage, triées par heure |
| `<projet> - all floors.csv` | toutes les mesures du projet, triées par heure (« Exporter tous les étages… ») |

Les noms de fichiers ne dépendent d'aucune langue : le fichier commun s'appelle toujours
`<projet> - all floors.csv`, quelles que soient la langue de l'interface et celle des exports (celle-ci
ne change que le contenu du PNG : légende, bandeau, échelle).

Des exports plus anciens peuvent s'appeler `<projet> - tous les étages.csv` ou
`<projet> - alle verdiepingen.csv`. Le lecteur doit reconnaître ces **trois** suffixes et **ne pas
prendre le fichier commun pour un étage** : ses lignes sont déjà dans les fichiers par étage, le compter
en plus doublerait les mesures. CRG reconnaît les trois. L'étage d'une ligne se lit dans la colonne
`floor`, pas dans le nom du fichier.

Walk-Test ne supprime jamais de fichier. Après un export de tous les étages dans le dossier `exports/`
du projet, un autre fichier commun présent dans ce dossier (ancien nom, autre projet) est signalé par
un avertissement, pour ne pas l'envoyer avec le rapport.

Les caractères interdits sous Windows (`\ / : * ? " < > |`) sont remplacés par `_` dans les noms.

**Le contenu d'un CSV (en-têtes, valeurs) ne change jamais**, quelles que soient la langue de
l'interface et celle des exports.

## Format

- Encodage UTF-8 **avec BOM**.
- Séparateur `;`, fins de ligne CRLF, une ligne d'en-têtes.
- **Point décimal** (`15.00`), jamais de virgule ni de séparateur de milliers.
- Une cellule contenant `;`, `"` ou un saut de ligne est entre guillemets, `"` y est doublé
  (ex. un nom d'étage `"Étage; -1"`).
- Date et heure locales du poste de mesure.

## Colonnes, dans l'ordre

**On ajoute à la fin. On ne renomme ni ne réordonne jamais une colonne.**

| # | Colonne | Sens |
|---|---|---|
| 1 | `date` | `AAAA-MM-JJ` |
| 2 | `time` | `HH:MM:SS.mmm` |
| 3 | `floor` | nom de l'étage |
| 4 | `segment` | n° de segment dans l'étage, à partir de 1 |
| 5, 6 | `x`, `y` | position en pixels du plan importé, origine en haut à gauche, 1 décimale |
| 7, 8 | `x_m`, `y_m` | position en mètres, 2 décimales ; vides si l'étage n'est pas calibré |
| 9 | `la` | LA de la cellule serveuse |
| 10 | `channel` | canal de la cellule serveuse |
| 11 | `rssi` | RSSI de la cellule serveuse (dBm) |
| 12 | `c1` | C1 de la cellule serveuse |
| 13–16 | `n1_la`, `n1_channel`, `n1_rssi`, `n1_cx` | voisine 1 ; vides si absente |
| 17–20 | `n2_la`, `n2_channel`, `n2_rssi`, `n2_cx` | voisine 2 |
| 21–24 | `n3_la`, `n3_channel`, `n3_rssi`, `n3_cx` | voisine 3 |
| 25–28 | `n4_la`, `n4_channel`, `n4_rssi`, `n4_cx` | voisine 4 |
| 29 | `astrid_ok` | `1` si le RSSI respecte le critère ASTRID du projet (≥ -88 dBm par défaut), sinon `0` |
| 30 | `no_service` | `1` sur un point « pas de service », sinon `0` |

## RSSI vide et `no_service`

Un point « pas de service » (`no_service` = 1) n'a pas de mesure : `rssi` et les autres cellules de
mesure sont **vides**, et `astrid_ok` vaut `0`. Il compte comme point mesuré et **non conforme**, comme
un niveau trop faible. Un RSSI vide n'est pas une valeur nulle : ne jamais le lire comme 0 dBm.

`astrid_ok` applique le critère enregistré dans le projet ; le seuil peut donc différer de -88 dBm
si l'utilisateur l'a modifié.

## Pourcentages et verdict

Règle validée par Jean le 04/11/2026.

Base : les **points** du CSV (`total` = nombre de lignes, `ok` = lignes avec `astrid_ok` = 1).

1. **Verdict** sur les comptes exacts, jamais sur un pourcentage arrondi : conforme si
   `ok * 100 >= 95 * total`.
2. **Part conforme** : `ok / total`, **tronquée** à 1 décimale.
3. **Part non conforme** : `100 - part conforme affichée`, pour que les deux parts affichées fassent
   toujours 100,0 %.
4. **Autres parts** (pas de service, sous le dernier seuil) : tronquées à 1 décimale.

| `ok` / `total` | Part exacte | Conforme | Non conforme | Verdict |
|---|---|---|---|---|
| 59 / 297 | 19,865… % | 19,8 % | 80,2 % | NON conforme |
| 9496 / 10000 | 94,96 % | 94,9 % | 5,1 % | NON conforme (arrondi, il s'afficherait à tort 95,0 %) |
| 19 / 20 | 95 % | 95,0 % | 5,0 % | conforme |

Même règle dans Walk-Test (panneaux, bandeau du PNG) et dans CRG 2.6.3.
