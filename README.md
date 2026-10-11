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

1. Rechercher un lieu, utiliser Montpellier/Palavas ou dessiner un **rectangle**. Les sélections rapides proposent 1 km² ou un **quartier de 300 m de côté**. La limite est de 25 km² et 12 km de côté ; une petite zone permet de conserver davantage de détails sur une pièce de 200 mm. L'interface indique combien de millimètres imprimés représentent un mètre réel.
2. Choisir le long côté de la maquette en **millimètres**. Les proportions géographiques restent constantes et l'échelle est calculée automatiquement.
3. Choisir un profil : **Épuré**, **Équilibré** ou **Détaillé**. Le profil équilibré retient un détail minimum de 0,8 mm, une surface de bâtiment d'au moins 1,2 mm² et une hauteur imprimée minimum de 0,6 mm. Les seuils sont ajustables dans « Résolution et nettoyage ».
4. Régler les couches, couleurs, hauteurs et le socle. Les routes, jardins, plages et plans d'eau sont **au niveau exact du terrain par défaut**, sans plaques superposées. Une gravure retire réellement de la matière pour les distinguer sur une impression monochrome ; un décalage positif reste disponible. Le relief est activé par défaut. L'activer après une collecte plate récupère seulement les altitudes et conserve les autres données. Les petits chemins sont exclus du profil équilibré et inclus dans le profil détaillé ; les rues piétonnes et escaliers utiles restent accessibles.
5. Lancer la collecte. La construction peut être annulée ; changer les réglages reconstruit le modèle à partir des données acquises. Le rapport indique les sources, les hauteurs estimées et les éléments écartés.
6. Exporter une pièce, ou choisir une grille jusqu'à 5 × 5 pour obtenir des tuiles fermées dans un ZIP. Vérifier la taille de chaque tuile selon le plateau de l'imprimante.

La démo sans réseau utilise un **quartier inventé**, clairement identifié. Elle sert à essayer les réglages et les exports. Les raccourcis Montpellier et Palavas récupèrent les données réelles.

## Données et précision

- **OpenStreetMap / Overpass** : bâtiments et parties, routes/voies ferrées, eau, parcs/jardins, bois, plages et quais. Les relations fragmentées sont assemblées et les cours/îles conservées.
- **IGN BD TOPO en France métropolitaine** : hauteurs à la gouttière et empreintes complémentaires, avec appariement spatial conservateur pour éviter les doubles bâtiments. Les hauteurs OSM explicitement renseignées restent prioritaires. L'enrichissement est plafonné à 10 000 bâtiments et signale les résultats partiels.
- **Montpellier Méditerranée Métropole, CityGML LoD2.2 de 2020** : dans la zone couverte, empreintes et véritables panneaux de toiture avec leurs altitudes, pentes, pans multiples et trous. Pour les structures élevées décrites complètement, les murs, faces sous les voûtes et appuis sont conservés en coque 3D, notamment l'Arc de Triomphe et le château d'eau du Peyrou. La collecte remplace les anciennes enveloppes qui boucheraient leurs ouvertures. Le rapport distingue les coques, les toitures mesurées et les formes reconstruites depuis les tags. Cette source peut différer de bâtiments modifiés depuis 2020.
- **Inventaire municipal des ouvrages d'art (2025)** : identification et dimensions documentées des ponts. Les cercles de localisation du catalogue ne deviennent jamais des empreintes physiques. Le pont Vialleton utilise sa vraie emprise OSM, la portée de 14,5 m et le passage de 5 m publiés, avec une cote de tablier IGN de 51,2 m (précision annoncée 1,5 m, relevé 2017). Le boulevard inférieur et ses deux sorties sont rétablis suivant leurs vrais axes OSM ; leur sol est estimé depuis le terrain hors pont, indépendamment du profil d'impression. Rue Foch reste au niveau du tablier. Sa courbure elliptique, l'épaisseur minimale de la couronne et les raccords au sol restent des approximations signalées, pas une coque mesurée.
- **Aqueduc des Arceaux, profil documentaire** : la reconstitution suit l'axe et l'emprise OSM et s'appuie sur le [plan et la coupe cotés conservés par Montpellier 3M, EstL0112-03](https://memonum-mediatheques.montpellier3m.fr/ark:/12148/btv1b106601010). Les doubles arcades de Pitot et les trois arches terminales de Giral sont distinguées. Les dimensions du dessin ancien, le positionnement des travées et la cote estimée du canal restent un profil approché ; le rapport compte séparément cet aqueduc et ses arches.
- **IGN RGE ALTI**, lorsque disponible : grille adaptée à la zone, visant 5 m pour les petites sélections françaises dans un budget de 4 900 points. Le rapport donne l'espacement effectivement obtenu. Les données manquantes ou aberrantes sont contrôlées ; le rapport indique le recours éventuel au DEM mondial **Copernicus GLO-90 via Open-Meteo**. Une résolution d'échantillonnage fine ne crée pas une précision supérieure à celle de la source. Un modèle de terrain ne restitue pas les murs verticaux, voûtes et chaque marche d'un escalier.
- **OpenFreeMap / OpenMapTiles**, données OSM : polygones marins prétraités avec trous, et complément de couverture des plans d'eau. Une ligne de côte seule ne sert jamais à inventer une surface de mer. La géométrie vectorielle de ces tuiles est généralisée pour la cartographie.
- **Photo aérienne IGN BD ORTHO**, en France : fond de carte optionnel pour choisir la zone et comparer allées, jardins et emprises. Cette image de référence ne fournit pas les hauteurs ni la géométrie 3D exportée. [Catalogue et millésimes](https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_BD-ORTHO), Licence Ouverte Etalab 2.0.

Les services publics peuvent être indisponibles. Une absence de relief ou d'enrichissement est annoncée, et le modèle peut utiliser les autres sources. OSM reste nécessaire à la collecte réelle. Pour les zones denses, réduire la sélection améliore le temps de calcul et la lisibilité.

Les toits utilisent en priorité les panneaux 3D municipaux disponibles. En leur absence, les formes, directions, orientations et angles OSM renseignés produisent des enveloppes fermées, conservant les cours et contours concaves. Les dimensions ou positions des pentes manquantes restent approximatives et les données invalides peuvent utiliser un repli à plat : le rapport le signale. Une simple empreinte et une hauteur ne permettent pas de retrouver les fenêtres ou façades. À l'échelle d'une ville entière, ces détails deviennent aussi plus petits que la résolution d'impression. Les arbres individuels, fenêtres et mobilier ne sont pas ajoutés automatiquement.

Le raccourci **Peyrou · Arc et aqueduc** sélectionne le parc, l'Arc, le pont Vialleton et le début de l'aqueduc, avec relief et allées. Les places pavées suivent leurs polygones réels. Un contour de parc n'est pas assimilé à une pelouse lorsque des surfaces végétalisées sont cartographiées à l'intérieur : seules ces surfaces deviennent vertes, le sol non renseigné restant neutre. Sans détail végétal, la coloration indicative du parc est signalée. Les escaliers utilisent le nombre de marches OSM et leurs dimensions verticales lorsqu'elles existent, sinon les altitudes des deux paliers du terrain. Plusieurs marches peuvent être regroupées pour respecter la profondeur imprimable et une montée de 0,12 mm, sans augmenter leur hauteur totale. Une montée inconnue, trop petite ou incompatible avec le terrain reste un chemin au sol avec avertissement, plutôt qu'un bloc d'escalier sur un parc plat.

Au Peyrou, le terrain raster peut lisser les ruptures entre les niveaux de promenade. Trois zones cartographiées — parterre central, promenade haute et terrasse des eaux — peuvent recevoir un plan ajusté aux points intérieurs du terrain IGN. Cette contrainte reste **une estimation depuis le DEM**, avec niveau, pente et écart aux points annoncés ; les [archives du Peyrou](https://archives.montpellier.fr/peyrou) documentent l'organisation du site, pas ces altitudes actuelles. Les jardins inférieurs, l'emprise du château et les couloirs d'escaliers ne sont pas aplatis globalement. Sans couverture IGN suffisamment fine et cohérente, le relief d'origine est conservé. Les paliers couverts par une vraie surface de circulation CityGML utilisent sa cote mesurée.

Lorsque terrain IGN et géométrie municipale partagent le datum IGN69, les panneaux de toiture et coques gardent leur altitude absolue : la cote de fermeture d'une coque n'est pas assimilée à la terrasse voisine. Une réparation locale de contact de 0,005 mm peut stabiliser les buffers d'impression ; elle est déclarée, limitée à trois passages avec un retrait cumulé de 0,01 % du volume du modèle ou de la tuile, et ne bouche pas les cavités. La gravure sur une terrasse retire uniquement de la matière au terrain existant, en conservant les bassins déjà creusés.

Les **bordures des bassins** utilisent leurs contours d'eau cartographiés, sans remplir l'intérieur ni ajouter de bord sur une coupe de la sélection. Une hauteur OSM explicite est prioritaire ; la largeur ou la hauteur absente est estimée. Les dimensions trop fines sont renforcées pour l'impression et signalées. Au Peyrou, les deux bassins latéraux portent une hauteur OSM de 10 cm, qui ne représente qu'environ 0,055 mm sur une maquette de 300 mm du site : un relief lisible exige une adaptation assumée.

**L'aqueduc reconstitué n'est pas un relevé 3D actuel.** Les altitudes linéaires BD TOPO vérifiées sont explicitement manquantes. La terrasse du château d'eau, mesurée à 57,774 m IGN69 dans le modèle municipal 2020, fournit un repère de raccord, pas une mesure du tablier. La limite et les portées précises des trois arches finales restent estimées ; les piles rejoignent le terrain et le canal conserve un profil presque horizontal. Le [plan municipal II 768, fin XVIIIe siècle](https://archives.montpellier.fr/peyrou), et la [notice patrimoniale officielle](https://pop.culture.gouv.fr/notice/merimee/PA00103609) documentent la différence entre les deux ouvrages. Les ouvertures mesurées ou reconstituées peuvent nécessiter des supports selon la taille et le procédé d'impression ; vérifier leur orientation dans le slicer.

La grande archive municipale est lue par plages HTTP et décompressée en flux, sans charger un lot entier en mémoire. Les bâtiments normalisés sont stockés dans `.cache/printmap/`, avec expiration de sept jours, au plus trois lots et un budget de 128 Mio. Ce cache est local au serveur et peut être supprimé. La première collecte dans une zone peut prendre plus de temps ; une source indisponible est signalée dans le rapport.

## Solides et formats

Le moteur **Manifold / WebAssembly** s'exécute dans un worker annulable. Il coupe les empreintes à la sélection, construit un socle fermé, adapte l'assise des bâtiments au terrain et fusionne les détails en un solide connexe. Le dessous est à **Z = 0**, l'axe vertical est **Z**, toutes les unités sont des **mm**. L'aperçu et l'export utilisent les mêmes buffers.

- **STL binaire** : un solide fusionné pour une matière.
- **3MF** : le même solide fermé, avec les couleurs par surface et la provenance. L'affectation des filaments et la prise en charge des couleurs dépendent du slicer ; l'export ne configure pas automatiquement un système multi-filaments.
- **Tuiles** : intersections volumiques réelles, coupes fermées, chaque pièce repositionnée sur le plateau. Les lignes vont du sud au nord, les colonnes de l'ouest à l'est. L'assemblage utilise les arêtes droites, sans connecteurs ajoutés.

Avant d'autoriser l'export, le calcul vérifie le statut du moteur, un volume positif, une seule composante solide et la fermeture/orientation des arêtes des buffers effectivement exportés, y compris ceux des tuiles. Un fragment détaché est omis et déclaré seulement s'il est plus fin que le détail minimum sur au moins un axe et de volume inférieur au cube de ce détail ; cette règle ne supprime jamais une coque négative délimitant une cavité. Les tests contrôlent indépendamment les arêtes, leur orientation, les indices, les dimensions et la conservation des volumes des tuiles. Un passage dans le slicer reste nécessaire pour choisir le matériau, les supports éventuels et les réglages propres à l'imprimante. La recette logicielle ne constitue pas un essai physique d'impression.

## Projets

« Enregistrer » télécharge un fichier `.printmap.json` version 2 contenant la zone, les données brutes, les panneaux et coques 3D acquis, le relief et les réglages. Il peut être rouvert hors ligne pour reconstruire la maquette. Les anciens fichiers version 1 restaurent leurs réglages, mais nécessitent une nouvelle sélection et collecte puisqu'ils ne contenaient pas les données géographiques. Les anciens projets conservent leurs décalages de surface ; « Au niveau du terrain » permet de les remettre à zéro.

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
npm run smoke:live -- --api http://localhost:3000 --bbox 43.6099,3.8677,43.6131,3.8745 --detail --size 300 --engrave --name peyrou-grave
```

Cette vérification produit des exemples Montpellier/Palavas dans `artifacts/` (STL, 3MF, projet et rapport) et contrôle la fermeture du modèle et de quatre tuiles. Elle est volontairement séparée de la CI pour ne pas dépendre de la disponibilité des services publics. `OVERPASS_URL` permet d'utiliser une instance Overpass administrée par l'exploitant.

Le [plan de refonte](docs/PLAN.md) détaille les objectifs, la répartition entre agents et les critères de recette. La CI vérifie le code, le moteur, le build et le parcours navigateur.

## Projets complémentaires

- [OSM2World](https://github.com/tordanik/OSM2World), **MIT** : catalogue de formes de toits et gestion des parties de bâtiment. Référence utile aux reconstructions depuis des tags explicites ; une scène OSM détaillée demande encore une préparation pour devenir un solide imprimable.
- [TouchTerrain](https://github.com/ChHarding/TouchTerrain_for_CAGEO), **GPLv3** : terrain DEM/GeoTIFF vers STL/OBJ, résolution liée à la taille imprimée et traitement des diagonales non manifold. Utile pour comparer les recettes de relief ; ne fournit pas l'architecture urbaine.
- [roofer](https://github.com/3DBAG/roofer), **GPLv3** : reconstruction de bâtiments LoD2 depuis un nuage de points et une empreinte. Piste pour une future collecte IGN LiDAR HD, avec données et validation propres ; aucun détail ne peut être récupéré sans cette acquisition.
- [cjio](https://github.com/cityjson/cjio), **MIT** : extraction, reprojection, triangulation et validation de CityJSON. Utile à une vérification indépendante des données municipales après conversion depuis CityGML ; ne réalise pas l'union solide avec le terrain.

Ces références ne sont pas des dépendances ajoutées à PrintMap. Aucun code GPL n'a été copié dans cette refonte ; une future intégration devra respecter la licence du code retenu et de ses dépendances.

## Sources et attribution

Conserver l'attribution avec les fichiers et les maquettes partagés, notamment **© OpenStreetMap contributors — https://www.openstreetmap.org/copyright**, et les sources IGN/OpenFreeMap/Montpellier indiquées dans le rapport. Les données OSM et les bâtiments 3D municipaux de Montpellier relèvent de l'ODbL ; BD TOPO et RGE ALTI sont diffusés par l'IGN sous Licence Ouverte Etalab 2.0. Le 3MF conserve la provenance ; pour un STL ou une pièce physique, joindre l'attribution dans la description ou sur une étiquette associée.

- [OpenStreetMap : données et licence](https://www.openstreetmap.org/copyright), [consignes d'attribution](https://osmfoundation.org/wiki/Attribution_Guidelines)
- [OpenFreeMap : service et attribution](https://openfreemap.org/)
- [IGN : données ouvertes](https://www.ign.fr/institut/des-donnees-et-logiciels-ouverts-au-service-de-la-nation), [services Géoplateforme](https://geoservices.ign.fr/documentation/services)
- [Montpellier : bâtiments 3D LoD2.2 de 2020, ODbL](https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier)
- [Montpellier 3M : plan coté de l'aqueduc, EstL0112-03, domaine public](https://memonum-mediatheques.montpellier3m.fr/ark:/12148/btv1b106601010), [Archives municipales : aqueduc et plans](https://archives.montpellier.fr/aqueduc)
- [Open-Meteo : API d'altitude et conditions d'utilisation](https://open-meteo.com/en/docs/elevation-api)
- [Manifold : API WASM](https://manifoldcad.org/docs/jsapi/), [spécification 3MF](https://github.com/3MFConsortium/spec_core)
