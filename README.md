# PrintMap

Choisir une zone sur la carte, obtenir une maquette de ville prête à imprimer en 3D : en une seule pièce, ou découpée en grille de plaques à assembler.

## Démarrer

Node.js 22 ou plus (`.nvmrc` fourni).

```bash
npm ci
npm run dev
```

Ouvrir [localhost:3000](http://localhost:3000). Aucune clé d’API n’est nécessaire.

## Utilisation

1. **Zone** — chercher une ville, puis dessiner un rectangle (deux clics) ou prendre un carré de 500 m, 1 km ou 2 km centré sur la carte.
2. **Imprimante et taille** — indiquer le plateau de l’imprimante (5 mm de marge sont gardés par bord), puis au choix :
   - *Remplir des plaques* : choisir colonnes × rangées, la maquette prend la plus grande taille possible ;
   - *Taille précise* : donner le grand côté en mm, la grille nécessaire est calculée.
   Les plaques sont toutes de la même taille ; le plan et l’échelle s’affichent avant de générer.
3. **Contenu** — bâtiments, routes, eau, espaces verts, relief, épaisseur du socle. Chaque surface peut être gravée, à niveau ou en relief. Tout changement reconstruit la maquette sans retélécharger les données.
4. **Générer**, vérifier dans l’aperçu 3D (perspective, dessus, dessous, plaques écartées), puis **exporter**.

## Fichiers produits

- **STL** : un solide fermé par plaque, une seule matière.
- **3MF** : une pièce par couleur (socle, routes, eau, espaces verts, bâtiments) pour l’impression multi-filament.
- Avec plusieurs plaques, un ZIP contient `plaque-colonne-rangée`, `plan-assemblage.svg`, `cles-assemblage.stl` et `LISEZMOI.txt`.

Tout est en millimètres, Z vers le haut, dessous à Z = 0 ; aucun support n’est nécessaire.

### Assemblage

- **Clés papillon** : des logements sont creusés sous les joints, à cheval sur deux plaques. Les clés s’impriment à part et verrouillent les plaques entre elles (socle d’au moins 2,4 mm).
- **Numéros** : `colonne-rangée` est gravé sous chaque plaque, rangée 1 au nord, lisible plaque retournée.

## Données

| Source | Rôle |
| --- | --- |
| OpenStreetMap via Overpass | bâtiments, routes, eau, espaces verts, au contour exact |
| OpenStreetMap via tuiles OpenFreeMap | mêmes données à ~0,5 m, utilisées quand Overpass met plus de 10 s à répondre ; mer et grands lacs |
| IGN BD TOPO (France) | hauteurs des bâtiments |
| IGN LiDAR HD / RGE ALTI (France), Mapzen Terrain Tiles (monde) | relief |

Seul OpenStreetMap est indispensable : une source secondaire lente ou absente est signalée, sans bloquer la maquette. Les sources réellement utilisées sont listées sous « Cette maquette ».

## Comment ça marche

```
src/lib/data/      collecte (Overpass, tuiles, IGN, relief)
src/lib/model/     features.ts  OSM → formes 2D en mm
                   build.ts     formes → solides (Manifold/WASM), découpe, clés
                   settings.ts  réglages et calcul de la grille
src/lib/export/    STL, 3MF, ZIP, plan d’assemblage
src/components/    carte, panneau de réglages, aperçu 3D
```

Chaque couche est construite en 2D (unions exactes, suppression de ce qui est plus fin que la buse), extrudée, puis fusionnée par le moteur [Manifold](https://github.com/elalish/manifold) : le résultat est fermé par construction, quelle que soit la ville. La découpe en plaques coupe ce solide par des plans.

## Vérifier

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Construire une maquette sans navigateur, avec contrôle de fermeture de chaque plaque :

```bash
npm run city -- 43.6065,3.8700,43.6155,3.8824 --cols 2 --rows 2 --out artifacts/essai
```

Options : `--bed 220`, `--size 300` (taille précise), `--relief`, `--verbose`.

## Limites connues

- Les toits sont plats : les bâtiments sont des volumes extrudés à leur hauteur.
- Hors de France, beaucoup de hauteurs sont estimées d’après le type de bâtiment.
- Les ponts et tunnels ne sont pas modélisés : les routes suivent le sol, les tronçons souterrains sont omis.
- L’ancienne version (toitures mesurées, monuments de Montpellier et Saint-Étienne) reste disponible sous l’étiquette git `ancienne-version`.

## Attribution

Données © les contributeurs d’[OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL). Fond de carte et tuiles [OpenFreeMap](https://openfreemap.org) / OpenMapTiles. En France : IGN, Licence Ouverte 2.0. Relief mondial : Mapzen Terrain Tiles.
