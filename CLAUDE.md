# TETRA Walk-Test — outil de mesure de couverture indoor (remplaçant open source de Motorola SCOUT)

## Contexte

Jean Pauwels (JEANVAL TECH SRL) fait des mesures de couverture indoor ASTRID (réseau TETRA
belge des services de secours) pour Connext NV, avec un terminal **Motorola MTP6550**.
SCOUT, le logiciel Motorola utilisé jusqu'ici, n'est plus maintenu. Ce projet le remplace.
Projet **open source**. Documentation en **français** ; interface en **français, néerlandais et
anglais** (tous les textes dans `js/strings.js`, jamais en dur dans le code).

## Ce qui est déjà acquis

- Le protocole radio est décodé et **validé en direct** : voir `docs/PROTOCOL.md` (référence).
- `tools/mtp_live.py` : lecture en direct du MTP6550 sur COM5 (Windows, pyserial). Fonctionne.
- `tools/mtp_trace.py` : conversion d'un fichier SCOUT `.atp` en CSV (positions + mesures). Fonctionne.

## Environnement cible

- **Laptops Windows uniquement** (pas de Linux). Radio sur « Motorola Solutions Portable Tetra
  Radio Port 1 » (COM5 en général).
- Appli web dans **Edge/Chrome**, accès radio via l'**API Web Serial** : rien à installer.
- Doit marcher **hors ligne sur site** (sous-sols, parkings) : pas de dépendance réseau au
  runtime, librairies embarquées localement.

## Version 1 (objectif)

1. Créer un projet / bâtiment ; importer le plan d'un étage (PNG, JPG ; PDF ensuite).
2. Calibration d'échelle optionnelle (2 points + distance connue).
3. Connexion à la radio (Web Serial) : identité affichée, `a03` → `g03` → `i0108`.
   À la déconnexion / fermeture : `g04` → `a04`.
4. Mesure par **waypoints** : clic = position actuelle ; les échantillons reçus entre deux clics
   sont répartis linéairement le long du segment (comme SCOUT). Démarrer / pause / fin de segment.
5. Trace colorée en direct selon des seuils RSSI configurables (défaut = légende SCOUT :
   ≥-65 rouge, ≥-72 orange, ≥-85 jaune, ≥-87 vert, ≥-98 bleu, sinon noir/« No »).
6. Panneau live : LA, canal, RSSI, C1 + voisines (identifiées par LA).
7. Export par étage : CSV (temps, étage, x, y, LA, canal, RSSI, C1, voisines) + PNG du plan avec trace.
8. Sauvegarde du projet (fichier local) pour pouvoir reprendre.

## Ensuite

- Gestion multi-étages dans un même projet.
- Import des anciens `.atp` SCOUT (logique de `tools/mtp_trace.py`).
- Intégration avec CRG (Connext Reports Generator, appli Flask de Jean) : format d'export à
  aligner avec ce que CRG consomme.

## Conventions

- Garder `docs/PROTOCOL.md` à jour à chaque nouvelle découverte.
- Ne jamais toucher aux fonctions de sécurité du réseau (authentification, chiffrement) :
  le projet se limite à la lecture des mesures radio.
- Tester avec la vraie radio branchée dès qu'une fonction touche au port série.
