# Motorola MTP6550 — protocole de trace (rétro-ingénierie SCOUT 19.12.1)

Reconstitué le 21/10/2026 à partir d'une capture USBPcap pendant une mesure SCOUT
(parking souterrain, 2 étages), puis **validé en direct** avec `tools/mtp_live.py`
sur Windows 11 (MTP6550 350-470, logiciel R33.020.9335, codeplug 9.30).

## Accès physique

- USB VID `0x0CAD` / PID `0x9012`, classe propriétaire, 2 interfaces bulk.
- Sous Windows, le pilote Motorola expose deux ports COM :
  - **« Portable Tetra Radio Port 1 » (ex. COM5)** : interface utilisée par SCOUT → c'est celle-ci.
  - « Port 2 » (ex. COM6) : non utilisé par SCOUT. C'est l'**interface AT (PEI)** de la radio :
    elle répond `\r\n+CME ERROR: 35\r\n` à chaque trame binaire de ce protocole (vérifié le 21/10/2026).
- Le débit en bauds est sans effet (USB) ; 115200 fonctionne.
- Un seul programme peut ouvrir le port à la fois (fermer SCOUT).

## Trames

| Sens | Format |
|---|---|
| PC → radio | `1B 'P'` corps `1B 'S'` |
| radio → PC | `1B 'S'` corps `1B 'P'` |

Échappement : un octet `0x1B` dans le corps est transmis `1B E4` (`0xE4 = ~0x1B`).
Les commandes PC n'ont pas de checksum.

## Commandes PC (corps)

| Corps | Rôle |
|---|---|
| `a 03` / `a 04` | ouvrir / fermer la session |
| `g 03` | **démarrer le flux de trace** |
| `g 04` | arrêter le flux |
| `i 01 08` | configuration (envoyée juste après `g 03`) |
| `e q <id>` | lire une info → réponse `G q 00 00 00 00 <id> <données>` |

Séquence SCOUT pour une mesure : `a03` → `g03` → `i0108` … (rien d'autre) … `g04` → `a04`.
Au repos, SCOUT vérifie la présence de la radio toutes les ~7 s : `a03, g04, i0108, eq03, a04`.

IDs `e q` connus (dans la requête, les ids 0x08 et 0x12 sont suivis d'un octet `00` ;
la réponse, elle, ne le répète pas) :

| id | Contenu | Exemple (valeurs fictives sauf modèle et versions) |
|---|---|---|
| 00 | ISSI (4 octets big-endian, 1er = `00`) | `00 12 d6 87` = 1234567 |
| 01 | N° de série (10 caractères ASCII) | 000TSV0000 |
| 02 | Model number | H65PCN6TZ6AN |
| 03 | TEI (8 octets, affiché en hexa sur 15 chiffres) | `00 01 23 45 67 89 ab 00` → 000123456789AB0 |
| 08 00 | version (?) | R34.000.9335 |
| 12 00 | version logicielle | R33.020.9335 |
| 0d | date de build, suivie d'un identifiant de build | Thu Feb 28 06:23:54 UTC 2019… |
| 0f | codeplug : 2 × 16 bits, le 2e affiché en hexa | `00 09 00 30` (9.30) |
| 4c, b3 09 | inconnus | |

Vérifié en direct le 21/10/2026 (pyserial, COM5) :
- les textes (série, modèle, versions) sont complétés par des `00` ;
- `a 03` n'appelle aucune réponse ;
- après `g 03`, une trame de type **`C`** (non décodée) précède les blocs `B` ;
- environ 25 trames `B` par seconde, dont ~1 bloc cellule serveuse.

## Flux de trace (radio → PC)

Corps : `'B' <seq:1> <len:1> <payload:len>` (seq incrémente modulo 256).

- `len = 0x32` : burst / PDU MAC brut (horodatage TDMA en tête) — non décodé, ignoré.
- payload qui commence par `6F 00 00` : **bloc de mesure**, suivi d'enregistrements de 8 octets,
  puis 1 octet de checksum (algorithme non identifié, inutile en lecture) :

```
<id:1> <type:1> <2 octets> <valeur: int32 big-endian signé>
```

Environ un bloc « cellule serveuse » par seconde.

### IDs de mesure

| Groupe | IDs |
|---|---|
| Serveuse | `08` LA · `07` canal (`valeur & 0xFFF`) · `09` RSSI dBm · `10` C1 · `53` canal courant · `0b` classe abonné (4080) · `02`, `06`, `0a` ? |
| Voisine 1 | `18` LA · `17` canal · `19` RSSI · `20` Cx · `1b` classe · `1a`, `9b` ? |
| Voisine 2 | `28` LA · `27` canal · `29` RSSI · `30` Cx · `2b` · `2a`, `9c` |
| Voisine 3 | `38` LA · `37` canal · `39` RSSI · `40` Cx · `3b` · `3a`, `9d` |
| Voisine 4 | `a8` LA · `a7` canal · `a9` RSSI · `a0` Cx · `ab` · `aa`, `9e` |
| Statut | `01`, `02`, `03`, `05` (timeslot / canal logique MCCH-CSCCH probablement — à confirmer) |
| `93`–`97`, `9a`, `0c`, `ae` | bloc inconnu (MER ?) |
| Resélection | `50`/`51`/`52` (+ copie de la voisine choisie), `41`–`47`, `56`, `57` |

- LA voisine = `65535` → emplacement vide.
- Canal : les bits hauts (`0x33…`) ne sont pas le n° de canal ; seul `& 0xFFF` compte.
- **La radio reclasse ses voisines en permanence** : identifier une voisine par son LA,
  jamais par sa position 1-4.

## Fichier SCOUT `.atp` (texte)

- Lignes `#Clé : valeur` : en-tête (date, heure, radio, ISSI, TEI, SW, CP…).
- `#UM,<n>,<B|I|E>,<x>,<y>` : position du point suivant, en **pixels du PNG exporté,
  origine au centre de l'image, y vers le bas**. B/I/E = début / intermédiaire / fin de segment.
- `hh:mm:ss.mmm <hex>` : corps de trame radio déséchappé (même format que ci-dessus).
- Vérifié : la trace reconstruite se superpose exactement à l'export PNG de SCOUT.
- Étage -1 : 430 lignes `#UM`, 2 818 blocs de mesure dont 344 avec la serveuse (`08` + `09`),
  mais **401 lignes** dans l'`Export.csv` de SCOUT. SCOUT ne crée donc pas un point par bloc
  serveuse ; règle exacte à établir avant l'import `.atp` (un point par `#UM` alimenté ?).
- L'`Export.csv` SCOUT contient les colonnes `MER`, `Timeslot` (1–4) et `LogChannel`
  (`MCCH` / `CSCCH`) : indice pour les IDs de statut et le bloc 93–ae.

## Incident observé : Port 1 muet après un câble arraché

Le 21/10/2026, après un câble USB arraché pendant le flux (`g 03` actif) puis rebranché :
Windows voit les deux ports (COM5 / COM6, état OK), COM5 s'ouvre, mais la radio ne renvoie
**aucun octet** sur COM5, même à `a 03` / `e q`. COM6 (AT) répond toujours. Le service de trace
de la radio reste bloqué : **éteindre puis rallumer la radio (câble branché) le débloque** (vérifié).
**Reproduit** le même jour dans l'appli : câble arraché en plein flux → 20 essais de reconnexion
sans réponse → redémarrage de la radio → connexion OK. Rebrancher le câble ne suffit donc pas.
L'appli le détecte (port ouvert mais muet) et demande aussitôt de redémarrer la radio.
Comportement connu : avec SCOUT aussi, il fallait redémarrer la radio **et** le programme.
Ici, vérifié avec la vraie radio : une fois la radio redémarrée, l'appli se reconnecte seule
et la mesure reprend (« Reprendre ») sans relancer quoi que ce soit.

Juste après le redémarrage, la radio a envoyé sur COM5, avant les réponses `G q`, des trames
**`G r`** non sollicitées (sens inconnu, ignorées par l'appli) :
`47 72 00 00 00 00 d0 00 08 1b 09 00`, `47 72 00 00 00 00 19 00 08`, `47 72 00 00 00 00 19 00 0d`,
`47 72 00 00 00 00 d0 00 08 1b 09 01`.

## Points ouverts

- Sens exact de `i 01 08`, des IDs de statut, du bloc 93–ae (MER ?).
- Checksum des blocs `B`.
- Contenu des bursts MAC `len=0x32` (pas nécessaire pour la couverture).
