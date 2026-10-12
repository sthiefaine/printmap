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
- **Fontaines, sculptures et monuments OSM** : leurs positions sont conservées, notamment les Trois Grâces de Montpellier. Lorsqu’une source ne fournit qu’un point, le rapport nomme l’objet sans fabriquer un volume 3D. Une position ou une photo ne constitue pas un maillage de sculpture.
- **IGN BD TOPO en France métropolitaine** : hauteurs à la gouttière et empreintes complémentaires, avec appariement spatial conservateur pour éviter les doubles bâtiments. Les hauteurs OSM explicitement renseignées restent prioritaires. L'enrichissement parcourt jusqu’à huit pages, soit 20 000 bâtiments, dans un délai global de 22 secondes et signale les résultats partiels.
- **Terrain IGN LiDAR HD en priorité** : le MNT décrit le sol, avec une source native à 0,5 m. La maquette utilise une grille bornée à 4 900 points et annonce son espacement réel, qui peut être plus large. Une couverture LiDAR incomplète déclenche un repli annoncé vers RGE ALTI, puis vers Copernicus si nécessaire. Le MNT ne contient pas les sculptures ni les dessous des ponts ; le tablier garde sa cote distincte.
- **Montpellier Méditerranée Métropole, CityGML LoD2.2 de 2020** : dans la zone couverte, empreintes et véritables panneaux de toiture avec leurs altitudes, pentes, pans multiples et trous. Pour les structures élevées décrites complètement, les murs, faces sous les voûtes et appuis sont conservés en coque 3D, notamment l'Arc de Triomphe et le château d'eau du Peyrou. La collecte remplace les anciennes enveloppes qui boucheraient leurs ouvertures. Le rapport distingue les coques, les toitures mesurées et les formes reconstruites depuis les tags. Cette source peut différer de bâtiments modifiés depuis 2020.
- **Saint-Étienne, [Bâti3D CRAIG 2021](https://www.data.gouv.fr/datasets/maquette-3d-batiments-auvergne-rhone-alpes-2021)** : acquisition automatique des surfaces CityJSON LoD2.2 sur Badouillière–Chavanelle, notamment le Musée d'Art et d'Industrie et l'église Saint-Louis. Les altitudes Lambert-93 / IGN69, pentes, pans multiples et cours sont conservés. Le relevé fournit 1 141 objets exploitables ; 57 objets incomplets conservent leurs données OSM/IGN. Les bâtiments trop petits ou incompatibles avec la construction solide sont écartés ou utilisent un repli annoncé. Cette source ne couvre pas le Parc Expo ni toute la ville et peut différer de constructions modifiées depuis 2021. Licence Ouverte 2.0 ; attribution : **CRAIG - FEDER Auvergne-Rhône-Alpes - 2021**.
- **Toitures IGN LiDAR HD en France métropolitaine** : la surface des toits est acquise depuis les rasters MNS et MNT au pas natif de 0,5 m. La grille utilisée reste bornée à quatre millions de cellules et annonce son espacement réel ; elle peut être plus grossière sur une grande sélection. Les plans et volumes sont reconstruits dans les seules empreintes OSM/IGN, avec leurs cours. Les géométries 3D CRAIG et Montpellier existantes restent prioritaires. Le rapport distingue ces reconstructions de toitures des géométries LoD2 mesurées ; les façades, sous-faces, fenêtres et sculptures ne sont pas déduites du raster. Une couverture manquante, une surface trop irrégulière ou une géométrie incompatible avec le solide conserve un repli annoncé. [Produit IGN et licence ouverte](https://www.data.gouv.fr/datasets/mnh-lidar-hd).
- **Inventaire municipal des ouvrages d'art (2025)** : identification et dimensions documentées des ponts. Les cercles de localisation du catalogue ne deviennent jamais des empreintes physiques. Le pont Vialleton utilise sa vraie emprise OSM, la portée de 14,5 m et le passage de 5 m publiés, avec une cote de tablier IGN de 51,2 m (précision annoncée 1,5 m, relevé 2017). Le boulevard inférieur et ses deux sorties sont rétablis suivant leurs vrais axes OSM ; leur sol est estimé depuis le terrain hors pont, indépendamment du profil d'impression. Rue Foch reste au niveau du tablier. Sa courbure elliptique, l'épaisseur minimale de la couronne et les raccords au sol restent des approximations signalées, pas une coque mesurée.
- **Aqueduc des Arceaux, profil documentaire** : la reconstitution suit l'axe et l'emprise OSM et s'appuie sur le [plan et la coupe cotés conservés par Montpellier 3M, EstL0112-03](https://memonum-mediatheques.montpellier3m.fr/ark:/12148/btv1b106601010). Les doubles arcades de Pitot et les trois arches terminales de Giral sont distinguées. Les dimensions du dessin ancien, le positionnement des travées et la cote estimée du canal restent un profil approché ; le rapport compte séparément cet aqueduc et ses arches.
- **IGN RGE ALTI**, lorsque disponible : grille adaptée à la zone, visant 5 m pour les petites sélections françaises dans un budget de 4 900 points. Le rapport donne l'espacement effectivement obtenu. Les données manquantes ou aberrantes sont contrôlées ; le rapport indique le recours éventuel au DEM mondial **Copernicus GLO-90 via Open-Meteo**. Une résolution d'échantillonnage fine ne crée pas une précision supérieure à celle de la source. Un modèle de terrain ne restitue pas les murs verticaux, voûtes et chaque marche d'un escalier.
- **OpenFreeMap / OpenMapTiles**, données OSM : polygones marins prétraités avec trous, et complément de couverture des plans d'eau. Une ligne de côte seule ne sert jamais à inventer une surface de mer. La géométrie vectorielle de ces tuiles est généralisée pour la cartographie.
- **Photo aérienne IGN BD ORTHO**, en France : fond de carte optionnel pour choisir la zone et comparer allées, jardins et emprises. Cette image de référence ne fournit pas les hauteurs ni la géométrie 3D exportée. [Catalogue et millésimes](https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_BD-ORTHO), Licence Ouverte Etalab 2.0.

Les services publics peuvent être indisponibles. Une absence de relief ou d'enrichissement est annoncée, et le modèle peut utiliser les autres sources. OSM reste nécessaire à la collecte réelle. Pour les zones denses, réduire la sélection améliore le temps de calcul et la lisibilité.

Les contours des bâtiments mesurés restent exacts après découpe, y compris dans une grande sélection. Les simplifier indépendamment de leurs toitures pouvait remplir les retraits de Sainte-Anne, faire rejeter ses pans pourtant complets et étendre la hauteur du clocher à toute la nef. Le nettoyage du profil reste appliqué aux formes génériques.

Les ensembles de terrasses horizontales, dont les 69 pans de l’Arbre Blanc, sont fusionnés par petits groupes pour conserver leurs niveaux mesurés lors de la conversion en buffers d’impression. Si une coque architecturale est invalide mais que ses toitures et ses appuis au sol restent exploitables, le repli utilise leurs projections réelles, avec leurs trous, plutôt que l’enveloppe convexe de sélection. Les contrôles de couverture restent identiques. Le rapport annonce les sous-faces et ouvertures perdues dans ce repli ; il ne compte pas ce résultat comme une coque complète. Les données municipales 2020 de l’Arbre Blanc ne décrivent pas les 193 balcons actuels comme des solides distincts.

Les toits utilisent en priorité les panneaux 3D mesurés disponibles. En leur absence, les formes, directions, orientations et angles OSM renseignés produisent des enveloppes fermées, conservant les cours et contours concaves. Les dimensions ou positions des pentes manquantes restent approximatives et les données invalides peuvent utiliser un repli à plat : le rapport le signale. Une simple empreinte et une hauteur ne permettent pas de retrouver les fenêtres ou façades. À l'échelle d'une ville entière, ces détails deviennent aussi plus petits que la résolution d'impression. Les arbres individuels, fenêtres et mobilier ne sont pas ajoutés automatiquement.

Le raccourci **Peyrou · Arc et aqueduc** sélectionne le parc, l'Arc, le pont Vialleton et le début de l'aqueduc, avec relief et allées. Les places pavées suivent leurs polygones réels. Un contour de parc n'est pas assimilé à une pelouse lorsque des surfaces végétalisées sont cartographiées à l'intérieur : seules ces surfaces deviennent vertes, le sol non renseigné restant neutre. Sans détail végétal, la coloration indicative du parc est signalée. Les escaliers utilisent le nombre de marches OSM et leurs dimensions verticales lorsqu'elles existent, sinon les altitudes des deux paliers du terrain. Plusieurs marches peuvent être regroupées pour respecter la profondeur imprimable et une montée de 0,12 mm, sans augmenter leur hauteur totale. Une montée inconnue, trop petite ou incompatible avec le terrain reste un chemin au sol avec avertissement, plutôt qu'un bloc d'escalier sur un parc plat.

Au Peyrou, le terrain raster peut lisser les ruptures entre les niveaux de promenade. Trois zones cartographiées — parterre central, promenade haute et terrasse des eaux — peuvent recevoir un plan ajusté aux points intérieurs du terrain IGN. Cette contrainte reste **une estimation depuis le DEM**, avec niveau, pente et écart aux points annoncés ; les [archives du Peyrou](https://archives.montpellier.fr/peyrou) documentent l'organisation du site, pas ces altitudes actuelles. Les jardins inférieurs, l'emprise du château et les couloirs d'escaliers ne sont pas aplatis globalement. Sans couverture IGN suffisamment fine et cohérente, le relief d'origine est conservé. Les paliers couverts par une vraie surface de circulation CityGML utilisent sa cote mesurée.

Lorsque terrain IGN et géométrie municipale partagent le datum IGN69, les panneaux de toiture et coques gardent leur altitude absolue : la cote de fermeture d'une coque n'est pas assimilée à la terrasse voisine. Une réparation locale de contact de 0,005 mm peut stabiliser les buffers d'impression ; elle est déclarée, limitée à trois passages avec un retrait cumulé de 0,01 % du volume du bâtiment, du modèle ou de la tuile, et ne bouche pas les cavités. La gravure sur une terrasse retire uniquement de la matière au terrain existant, en conservant les bassins déjà creusés.

Les **bordures des bassins** utilisent leurs contours d'eau cartographiés, sans remplir l'intérieur ni ajouter de bord sur une coupe de la sélection. Une hauteur OSM explicite est prioritaire ; la largeur ou la hauteur absente est estimée. Les dimensions trop fines sont renforcées pour l'impression et signalées. Au Peyrou, les deux bassins latéraux portent une hauteur OSM de 10 cm, qui ne représente qu'environ 0,055 mm sur une maquette de 300 mm du site : un relief lisible exige une adaptation assumée.

**L'aqueduc reconstitué n'est pas un relevé 3D actuel.** Les altitudes linéaires BD TOPO vérifiées sont explicitement manquantes. La terrasse du château d'eau, mesurée à 57,774 m IGN69 dans le modèle municipal 2020, fournit un repère de raccord, pas une mesure du tablier. La limite et les portées précises des trois arches finales restent estimées ; les piles rejoignent le terrain et le canal conserve un profil presque horizontal. Le [plan municipal II 768, fin XVIIIe siècle](https://archives.montpellier.fr/peyrou), et la [notice patrimoniale officielle](https://pop.culture.gouv.fr/notice/merimee/PA00103609) documentent la différence entre les deux ouvrages. Les ouvertures mesurées ou reconstituées peuvent nécessiter des supports selon la taille et le procédé d'impression ; vérifier leur orientation dans le slicer.

La grande archive municipale est lue par plages HTTP et décompressée en flux, sans charger un lot entier en mémoire. Les bâtiments normalisés sont stockés dans `.cache/printmap/`, avec expiration de sept jours, au plus trois lots et un budget de 128 Mio. Ce cache est local au serveur et peut être supprimé. La première collecte dans une zone peut prendre plus de temps ; une source indisponible est signalée dans le rapport.

Le document CityJSON CRAIG de Saint-Étienne utilise également un cache local de sept jours, avec une limite de 16 Mio au téléchargement et à la décompression. Les coordonnées, la projection et les surfaces sémantiques sont validées à chaque lecture. Un échec de cette source conserve les bâtiments OSM/IGN et permet de réessayer la collecte.

Les rasters de toiture IGN utilisent deux grilles Lambert-93 alignées, au plus 32 Mo de valeurs et quatre requêtes simultanées, avec un délai réseau de 25 secondes. La collecte démarre leur acquisition en parallèle des autres sources. La reconstruction examine au plus 2 000 grandes empreintes, dans un budget de 12 secondes et 60 000 triangles de toiture ; les autres bâtiments conservent leurs données antérieures. Le cache raster garde une seule grille pendant 30 minutes. La résolution et les seuils de reconstruction ne constituent pas une garantie de précision de mesure.

Les toitures reconstruites depuis le raster deviennent une seule enveloppe fermée, avec fondation, murs extérieurs et parois entre les niveaux de toiture. Les jonctions des plans voisins sont raccordées dans leur tolérance de reconstruction ; les grandes différences de niveau restent des parois verticales. Cette opération est réservée aux reconstructions LiDAR et ne déplace aucun sommet des relevés CRAIG ou Montpellier. Les contrôles de fermeture et les budgets des réparations numériques restent identiques.

## Solides et formats

Le moteur **Manifold / WebAssembly** s'exécute dans un worker annulable. Il coupe les empreintes à la sélection, construit un socle fermé, adapte l'assise des bâtiments au terrain et fusionne les détails en un solide connexe. Le dessous est à **Z = 0**, l'axe vertical est **Z**, toutes les unités sont des **mm**. L'aperçu et l'export utilisent les mêmes buffers.

- **STL binaire** : un solide fusionné pour une matière.
- **3MF** : le même solide fermé, avec les couleurs par surface et la provenance. L'affectation des filaments et la prise en charge des couleurs dépendent du slicer ; l'export ne configure pas automatiquement un système multi-filaments.
- **Tuiles** : intersections volumiques réelles, coupes fermées, chaque pièce repositionnée sur le plateau. Les lignes vont du sud au nord, les colonnes de l'ouest à l'est. L'assemblage utilise les arêtes droites, sans connecteurs ajoutés.

Pour quatre plateaux de 150 × 150 mm, régler le **long côté de la pièce à 290 mm**, puis **2 colonnes et 2 lignes**. Chaque tuile mesure au plus 145 × 145 mm, avec une marge pour l’adhérence. Une pièce de 300 mm utilise toute la dimension de 150 mm ; la taille annoncée concerne la maquette entière, avant découpe. Réduire l’emprise géographique conserve davantage de détails à cette taille physique.

Dans **Réglages → Choisir un morceau de ville**, le raccourci **Saint-Étienne · centre et Parc Expo**, sous la recherche, applique directement ces dimensions et le relief. Il sélectionne environ 2,8 × 2,8 km, incluant les deux halls du Parc Expo, Couriot, la Manufacture/Cité du design, Châteaucreux et le centre. Cliquer ensuite sur **Récupérer et construire**. Les hauteurs IGN sont des mesures à la gouttière ; sans géométrie de toiture, elles ne restituent pas les charpentes ou façades des halls.

La recette CRAIG de cette sélection, avant reconstruction LiDAR, à 290 mm conserve 4 658 bâtiments, dont 414 avec des toitures CRAIG mesurées, dans un volume connecté. Le modèle de 289,06 × 290 × 22,31 mm et ses quatre tuiles de 144,53 × 145 mm sont fermés, orientés et conservent leur volume. Les parties explicitement souterraines ne sont plus extrudées en surface : une partie OSM du musée masquait ainsi deux de ses toits bas. Un `layer` négatif isolé ne suffit pas à supprimer un bâtiment. Pour obtenir les nouvelles données dans un projet Saint-Étienne existant, cliquer sur **Actualiser les données** en gardant **Toitures 3D disponibles** activé.

Lorsque le terrain grossier menace une toiture mesurée basse, son altitude est remplacée au-dessus du sol relevé sous la seule fondation du bâtiment, avec un raccord de précision de 0,005 mm. Les altitudes des toits, les cours et le terrain extérieur sont conservés. Les 21 pans du Musée d'Art et d'Industrie et les 127 pans de Saint-Louis sont vérifiés dans les exports.

Le raccourci **Saint-Étienne · toitures détaillées** sélectionne les 0,80 km² de Badouillière–Chavanelle couverts par CRAIG, avec le profil Détaillé et quatre plaques. À 290 mm, la pièce mesure 290 × 223,26 × 30,73 mm, soit des tuiles de 145 × 111,63 mm ; elle conserve 1 819 bâtiments, dont 925 avec leurs véritables pans de toiture. Les bâtiments sont environ 3,7 fois plus grands que sur la sélection centre–Expo–stade. Les façades absentes de la source restent simplifiées.

Le raccourci **Saint-Étienne · centre, Expo et stade** étend la zone au nord pour inclure **Geoffroy-Guichard**, avec la même pièce de 290 mm et quatre plaques de **107,12 × 145 mm**. La carte cadre toute la sélection. Cette zone de 2,79 × 3,78 km, soit 10,56 km², passe de 1:9662 à 1:13037 : les détails sont environ 26 % plus petits. La première recette LiDAR du 12 octobre 2026 conserve 2 644 bâtiments, dont 187 avec des toitures CRAIG et 500 avec des toits reconstruits depuis le MNS/MNT à 2 m. Les deux halls du Parc Expo gardent leurs pentes et leurs volumes bas ; la tribune Charles-Paret retrouve une hauteur issue du LiDAR de 34 m, au lieu de 9 m estimés. Les quatre tribunes et la pelouse ouverte sont présentes sur la plaque nord-est. Les gradins et les charpentes masquées restent absents des sources utilisées. Les dix STL/3MF du modèle et des quatre plaques passent les contrôles indépendants. Six plaques avec une pièce d'environ 391 mm permettraient de garder l'échelle de la sélection centre–Expo.

Dans cette sélection, **Réglages → Préparer une belle impression → 2 plaques / 4 plaques** change la taille physique et le découpage sans changer la zone ni récupérer les données à nouveau. Deux plaques donnent une maquette assemblée de **145 × 196,28 mm**, sur deux pièces de **145 × 98,14 mm** (1:19261). Quatre plaques donnent **214,23 × 290 mm**, sur quatre pièces de **107,12 × 145 mm** (1:13037). Les plateaux de 150 mm gardent ainsi 5 mm de marge totale. Quatre plaques agrandissent les détails de 47,7 % ; relief et bâtiments gardent la même échelle verticale et horizontale. Les boutons 6 et 9 plaques restent disponibles sous les formats avancés.

La collecte affine désormais **Saint-Charles et Sainte-Marie** depuis deux acquisitions locales MNS/MNT IGN au pas natif de 0,5 m. Les échantillons originaux sont conservés à 1 m sans lissage, avec des hauteurs maximales de **42,41 m et 28,74 m** au-dessus de leur sol relevé. Ces deux reconstructions utilisent 5 194 triangles, réservés dans le budget total inchangé de 60 000 triangles LiDAR. Les volumes 3D CRAIG/Montpellier restent prioritaires. Une partie de toiture OSM sans hauteur ne peut plus effacer une enveloppe source plus détaillée : le Zénith garde ainsi ses cinq pans et leurs pentes. Le menu **Repères de Saint-Étienne** cadre uniquement les monuments effectivement conservés et indique leur représentation : volume mesuré, toiture reconstruite ou simple empreinte et hauteur.

Les détails de façades, sculptures et ossatures ajourées restent tributaires des sources disponibles. La Tour Observatoire est trop fine au seuil de 0,8 mm dans les formats 2 et 4 plaques et son omission est annoncée ; les formats 6 et 9 conservent son empreinte et sa hauteur OSM de 31 m, sans inventer son ossature. Couriot reste un volume simplifié, et certaines géométries CRAIG incomplètes utilisent leur repli déclaré. Aucune texture satellite n’est présentée comme une géométrie architecturale.

La recette finale à 2 plaques conserve 821 bâtiments, dont 44 toitures CRAIG et 260 toitures LiDAR ; celle à 4 plaques conserve 2 649 bâtiments, dont 187 toitures CRAIG et 350 toitures LiDAR. Les modèles et leurs fichiers STL/3MF ont été relus indépendamment, ainsi que les six tuiles 3MF téléchargées dans l'atelier. Le raccord des routes à décalage nul utilise directement le sol existant : sa coloration ne recrée plus une peau de relief superposée susceptible de dépasser le budget de correction. Les contrôles de fermeture et ce budget restent actifs.

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
- [vue-3d-ign](https://github.com/ysimonx/vue-3d-ign), **MIT** : référence pour l’acquisition des rasters IGN MNS/MNT et la reconstruction de toitures depuis des données ouvertes. Notre construction et sa validation restent propres à la production de solides imprimables.

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
