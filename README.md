# PrintMap

Un atelier pour transformer une portion de ville ou de paysage en maquette imprimable : bâtiments, routes, jardins, plans d'eau, rivières, mer et relief. La collecte conserve beaucoup de données ; la préparation sélectionne ce qui reste lisible à la taille de l'impression.

## Démarrer

Node.js **22 ou plus** est requis (`.nvmrc` fourni).

```bash
npm ci
npm run dev
```

Ouvrir [localhost:3000](http://localhost:3000). Le moteur WASM et les workers de carte sont copiés depuis les dépendances verrouillées à l'installation et avant chaque lancement/build. Aucune clé API n'est nécessaire pour les sources publiques par défaut.

```bash
npm run build
npm start
```

## Préparer une pièce

1. Rechercher un lieu, utiliser Montpellier/Palavas ou dessiner un **rectangle**. La sélection rapide propose un quartier d'environ 1 km². La limite est de 25 km² et 12 km de côté ; une petite zone permet de conserver davantage de détails sur une pièce de 200 mm.
2. Choisir le long côté de la maquette en **millimètres**. Les proportions géographiques restent constantes et l'échelle est calculée automatiquement.
3. Choisir un profil : **Épuré**, **Équilibré** ou **Détaillé**. Le profil équilibré retient un détail minimum de 0,8 mm, une surface de bâtiment d'au moins 1,2 mm² et une hauteur imprimée minimum de 0,6 mm. Les seuils sont ajustables dans « Résolution et nettoyage ».
4. Régler les couches, couleurs, hauteurs et le socle. Le relief est optionnel. Les petits chemins sont exclus du profil équilibré et inclus dans le profil détaillé.
5. Lancer la collecte. La construction peut être annulée ; changer les réglages reconstruit le modèle à partir des données acquises. Le rapport indique les sources, les hauteurs estimées et les éléments écartés.
6. Exporter une pièce, ou choisir une grille jusqu'à 5 × 5 pour obtenir des tuiles fermées dans un ZIP. Vérifier la taille de chaque tuile selon le plateau de l'imprimante.

La démo sans réseau utilise un **quartier inventé**, clairement identifié. Elle sert à essayer les réglages et les exports. Les raccourcis Montpellier et Palavas récupèrent les données réelles.

## Données et précision

- **OpenStreetMap / Overpass** : bâtiments et parties, routes/voies ferrées, eau, parcs/jardins, bois, plages et quais. Les relations fragmentées sont assemblées et les cours/îles conservées.
- **IGN BD TOPO en France métropolitaine** : hauteurs à la gouttière et empreintes complémentaires, avec appariement spatial conservateur pour éviter les doubles bâtiments. Les hauteurs OSM explicitement renseignées restent prioritaires. L'enrichissement est plafonné à 10 000 bâtiments et signale les résultats partiels.
- **IGN RGE ALTI**, lorsque disponible : grille adaptée à la zone. Les données manquantes ou aberrantes sont contrôlées ; le rapport indique le recours éventuel au DEM mondial **Copernicus GLO-90 via Open-Meteo**. Une résolution d'échantillonnage fine ne crée pas une précision supérieure à celle de la source.
- **OpenFreeMap / OpenMapTiles**, données OSM : polygones marins prétraités avec trous, et complément de couverture des plans d'eau. Une ligne de côte seule ne sert jamais à inventer une surface de mer. La géométrie vectorielle de ces tuiles est généralisée pour la cartographie.

Les services publics peuvent être indisponibles. Une absence de relief ou d'enrichissement est annoncée, et le modèle peut utiliser les autres sources. OSM reste nécessaire à la collecte réelle. Pour les zones denses, réduire la sélection améliore le temps de calcul et la lisibilité.

Les toits détaillés reposent sur les tags disponibles. Les formes complexes peuvent être aplaties et les dimensions manquantes estimées : le rapport le signale. Ponts et volumes élevés sont ramenés à une assise soutenue pour produire une maquette robuste ; cette version ne restitue pas leurs dessous suspendus. Les arbres individuels, fenêtres et mobilier ne sont pas ajoutés automatiquement.

## Solides et formats

Le moteur **Manifold / WebAssembly** s'exécute dans un worker annulable. Il coupe les empreintes à la sélection, construit un socle fermé, adapte l'assise des bâtiments au terrain et fusionne les détails en un solide connexe. Le dessous est à **Z = 0**, l'axe vertical est **Z**, toutes les unités sont des **mm**. L'aperçu et l'export utilisent les mêmes buffers.

- **STL binaire** : un solide fusionné pour une matière.
- **3MF** : le même solide fermé, avec les couleurs par surface et la provenance. L'affectation des filaments et la prise en charge des couleurs dépendent du slicer ; l'export ne configure pas automatiquement un système multi-filaments.
- **Tuiles** : intersections volumiques réelles, coupes fermées, chaque pièce repositionnée sur le plateau. Les lignes vont du sud au nord, les colonnes de l'ouest à l'est. L'assemblage utilise les arêtes droites, sans connecteurs ajoutés.

Avant d'autoriser l'export, le calcul vérifie le statut du moteur, un volume positif, une seule composante solide et la fermeture/orientation des arêtes des buffers effectivement exportés, y compris ceux des tuiles. Les tests contrôlent indépendamment les arêtes, leur orientation, les indices, les dimensions et la conservation des volumes des tuiles. Un passage dans le slicer reste nécessaire pour choisir le matériau, les supports éventuels et les réglages propres à l'imprimante. La recette logicielle ne constitue pas un essai physique d'impression.

## Projets

« Enregistrer » télécharge un fichier `.printmap.json` version 2 contenant la zone, les données brutes, le relief et les réglages. Il peut être rouvert hors ligne pour reconstruire la maquette. Les anciens fichiers version 1 restaurent leurs réglages, mais nécessitent une nouvelle sélection et collecte puisqu'ils ne contenaient pas les données géographiques.

## Vérifier

```bash
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Les tests navigateur couvrent la démo, les tailles/couleurs, l'export, les tuiles, la réouverture d'un projet, l'erreur suivie d'une relance, l'annulation et les petits écrans. Ils fonctionnent même avec le fond de carte externe indisponible.

La CI teste le build de production. Pour faire la même vérification localement, après `npm run build` :

```bash
PRINTMAP_TEST_PRODUCTION=1 PRINTMAP_TEST_PORT=3101 npm run test:e2e
```

Pour une recette avec les services réels, lancer l'application puis :

```bash
npm run smoke:live -- --api http://localhost:3000
npm run smoke:live -- --api http://localhost:3000 --coast
```

Cette vérification produit des exemples Montpellier/Palavas dans `artifacts/` (STL, 3MF, projet et rapport) et contrôle la fermeture du modèle et de quatre tuiles. Elle est volontairement séparée de la CI pour ne pas dépendre de la disponibilité des services publics. `OVERPASS_URL` permet d'utiliser une instance Overpass administrée par l'exploitant.

Le [plan de refonte](docs/PLAN.md) détaille les objectifs, la répartition entre agents et les critères de recette. La CI vérifie le code, le moteur, le build et le parcours navigateur.

## Sources et attribution

Conserver l'attribution avec les fichiers et les maquettes partagés, notamment **© OpenStreetMap contributors — https://www.openstreetmap.org/copyright**, et les sources IGN/OpenFreeMap indiquées dans le rapport. Les données OSM relèvent de l'ODbL ; BD TOPO et RGE ALTI sont diffusés par l'IGN sous Licence Ouverte Etalab 2.0. Le 3MF conserve la provenance ; pour un STL ou une pièce physique, joindre l'attribution dans la description ou sur une étiquette associée.

- [OpenStreetMap : données et licence](https://www.openstreetmap.org/copyright), [consignes d'attribution](https://osmfoundation.org/wiki/Attribution_Guidelines)
- [OpenFreeMap : service et attribution](https://openfreemap.org/)
- [IGN : données ouvertes](https://www.ign.fr/institut/des-donnees-et-logiciels-ouverts-au-service-de-la-nation), [services Géoplateforme](https://geoservices.ign.fr/documentation/services)
- [Open-Meteo : API d'altitude et conditions d'utilisation](https://open-meteo.com/en/docs/elevation-api)
- [Manifold : API WASM](https://manifoldcad.org/docs/jsapi/), [spécification 3MF](https://github.com/3MFConsortium/spec_core)
