# Dérivation des plateaux visibles de l’Arbre Blanc

Le script hors ligne `derive-arbre-blanc-lidar.py` utilise le nuage public IGN LiDAR HD de la dalle 0772-6279, vol du 28 mai 2021, en Lambert-93 / IGN69. Le NPZ original contient 134 478 points, dont 88 008 classés bâtiment. Le téléchargement sélectif reste borné à 32 Mio ; le nuage complet n’est pas requis. NumPy, Shapely et Matplotlib servent uniquement à cette préparation, sans dépendance Python de l’application.

Reproduction avec les dépendances Python indiquées dans le script :

```sh
python3 scripts/derive-arbre-blanc-lidar.py --download
python3 tests/test_arbre_lidar_derivation.py
```

Avec le NPZ déjà présent, remplacer `--download` par `--points /chemin/nuage.npz`. `--output` et `--plot` permettent une comparaison temporaire sans écraser l’asset livré. `PRINTMAP_LIDAR_PYTHON_LIBS` permet d’indiquer un répertoire de bibliothèques du même environnement Python. `--no-facade-mask` conserve le seul masque OSM pour une comparaison indépendante des corrections documentaires.

## Observations historiques conservées

La première étape reste identique : 17 bandes d’altitude observées et figées, ±0,20 m ; points classe 6 hors noyau OSM et dans l’emprise municipale ; grille 0,5 m avec au moins deux retours par cellule ; ouverture de rayon 0,251 m, fermeture bornée, simplification de 0,25 m. Les 107 contours historiques et leurs 107 témoins issus du nuage sont recalculés à partir des sources, puis conservés dans l’union finale. Une nouvelle normale ambiguë ne peut donc pas supprimer une observation antérieure. Les témoins historiques conservent leur ordre ; les nouveaux sont ajoutés à la suite.

La limite de l’ancienne étape est quantifiée : l’ouverture supprime toutes les bandes d’une seule cellule, même lorsqu’elles appartiennent à un groupe horizontal. Le seuil de deux retours rejette aussi des cellules de plateaux peu visibles, surtout aux étages bas. Il ne suffit pas d’abaisser ces seuils, car une tranche verticale de façade contient également des points presque coplanaires dans une bande d’altitude étroite.

## Récupération additive de groupes horizontaux

Pour les ajouts, la normale est calculée par PCA dans une sphère 3D de rayon 1,25 m, avec **toutes les altitudes du voisinage**, et non seulement la bande ±0,20 m. Le voisinage doit avoir au moins huit retours, une normale avec `|nz| ≥ 0,9`, une variance résiduelle relative `λmin / Σλ ≤ 0,03`, une seconde variance supérieure à 0,01 m² et une distance du retour au plan ajusté inférieure à 0,12 m. Ces critères sont des paramètres de dérivation déclarés, pas une certification du rôle architectural de la surface.

Les points classe 1 ne sont admis que s’ils passent ces contrôles et partagent le plan avec au moins trois retours natifs classés bâtiment. Dans le crop réel, 20 points classe 1 satisfont cette sélection, aux deux niveaux les plus bas. Une surface entièrement non classée ou une façade verticale n’est pas automatiquement ajoutée.

Une cellule contenant un retour ainsi validé peut contribuer au contour supplémentaire. Son ouverture est ramenée à 0,125 m ; la fermeture maximale, la simplification et l’inférence de contour restent bornées comme auparavant. Les parties doivent garder une aire d’au moins 1 m², au moins huit retours horizontaux associés et au moins 80 % de recouvrement avec les pixels d’observation. Elles sont filtrées à 1,5 m du contour de sélection applicable. Les contours historiques restent conservés même lorsqu’un nouveau calcul de normale aurait été plus sévère.

## Masques et géométrie imprimée

Le noyau OSM brut de 818,08 m² reste publié sans changement. Pour sélectionner les points supplémentaires, le script utilise aussi le contour documentaire de `arbre-blanc-facade.json` : les deux seules bosses qui recouvraient des terrasses selon les plans publiés R+9/R+16 sont retirées du masque d’exclusion. Le contour corrigé est interprété et géoréférencé ; il n’est pas une façade mesurée fournie par les architectes. Sa provenance est conservée dans l’asset.

La sélection des points ne crée ni sous-face, ni épaisseur, ni poteau. Ces choix relèvent séparément du constructeur imprimable et sont déclarés comme estimés. Le filtre de proximité de 1,5 m ne constitue pas une garantie de longueur maximale de chaque raccord imprimé : dans les deux anciennes bosses OSM, le raccord à la façade documentaire peut être plus long et reste une interprétation locale. Aucune règle n’étend uniformément les raccords à 7,5 m, ni ne copie un plan d’étage sur les 17 niveaux.

## Contrôle sur le crop réel

Avec les mêmes 17 cotes, la dérivation produit 126 parties et 2 524 sommets, contre 107 parties et 1 540 sommets auparavant. L’aire cumulée des contours horizontaux dérivés passe de 1 069,59 à 1 358,14 m² (+27 %). Pour les six niveaux bas, elle passe de 74,32 à 128,31 m² (+73 %). Ces aires additionnent plusieurs niveaux ; elles ne constituent pas un décompte de balcons ni une aire architecturale certifiée.

Les témoins nouveaux incluent leur vraie altitude observée, leur classification et le diagnostic local de plan. Les tests hors ligne vérifient notamment qu’un mur vertical vu dans une bande étroite n’est pas transformé en dalle, qu’un point isolé décalé du plan est refusé, que la classe 1 exige un support bâtiment et que la récupération ne supprime aucune observation historique. La fermeture de la maquette et des exports reste contrôlée séparément par les tests CAD et les rayons indépendants.

Sources :

- [IGN LiDAR HD](https://www.data.gouv.fr/datasets/nuages-de-points-lidar-hd), Licence Ouverte 2.0 ; URL COPC, dates, crop et SHA-256 du NPZ dans l’asset.
- [OpenStreetMap way 441634682](https://www.openstreetmap.org/way/441634682), © contributeurs OpenStreetMap, ODbL.
- [Montpellier Méditerranée Métropole, bâtiments 3D 2020](https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier), ODbL.
- [Nicolas Laisné Architectes, plans publiés de l’Arbre Blanc](https://nicolaslaisne.com/portfolio_page/arbre-blanc/), référence documentaire du masque ; les plans originaux ne sont pas redistribués.

Les parties occultées, garde-corps, sous-faces et fonctions terrasse/pergola ne sont pas tous mesurés. Cette dérivation ne reconstitue pas les 193 balcons complets.
