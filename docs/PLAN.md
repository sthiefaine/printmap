# PrintMap — plan de refonte

## Objectif et critères

Transformer une **portion d'un lieu réel** en une maquette géographique lisible, solide et prête à ouvrir dans un slicer. L'acquisition doit être riche ; la géométrie finale doit retenir uniquement les informations qui restent lisibles à la taille de la pièce. Montpellier est le cas de référence, sans limiter l'application à cette ville.

Une livraison réussie doit permettre de sélectionner une zone, de choisir la taille en millimètres et le niveau de détail, de consulter les données et leur provenance, de visualiser le modèle réellement exporté et de télécharger un STL ou un 3MF. La présence d'une information dans OSM ne suffit pas à justifier sa présence dans le modèle.

## 1. Choix de la zone et dimensionnement

- Recherche de ville, carte et sélection rectangulaire explicite : la forme affichée doit correspondre à la forme du socle.
- Raccourcis pour démarrer à Montpellier ; la zone demeure ajustable.
- Long côté cible en mm et échelle calculée depuis les dimensions géographiques, ratio conservé.
- Paramètres disponibles avant l'acquisition. Taille de plateau et découpage en tuiles associés à des dimensions réelles.
- Validation commune des coordonnées : valeurs finies, latitude/longitude, ordre des limites, aire raisonnable. Les très grandes zones se traitent par portions pour conserver la lisibilité et maîtriser le coût des services publics.

## 2. Collecte des données utiles

- Une route serveur coordonne la collecte. OSM apporte bâtiments, parties de bâtiment, routes, voies ferrées, cours d'eau, plans d'eau, parcs, jardins, forêts, plages et pontons.
- En France, la BD TOPO de l'IGN peut enrichir les hauteurs et compléter les empreintes manquantes. L'appariement doit rester conservateur afin de ne pas doubler les bâtiments.
- À Montpellier, acquérir les panneaux de toiture mesurés dans le CityGML LoD2.2 municipal de 2020. Lire les lots en flux avec cache borné et annulation, conserver leurs altitudes et cours ; afficher le millésime et la couverture réelle. Ailleurs, conserver le repli OSM/IGN sans inventer de façade ou de toit.
- Relief indépendant des bâtiments : source IGN lorsque disponible puis DEM global. Une réponse manquante ou incohérente ne doit pas se transformer silencieusement en altitude zéro.
- Petits sites : échantillonnage ciblant 5 m, limité à 4 900 points ; afficher la résolution réellement obtenue. Relief actif par défaut, récupération indépendante après une collecte plate, sans perte de géométrie ni de dates d'origine.
- Monuments : conserver les coques CityGML complètes, leurs faces sous les voûtes et leurs appuis. Supprimer l'enveloppe 2D ancienne qui remplirait le passage. Distinguer coque mesurée et reconstruction paramétrique documentée.
- Inventaire ouvrages : exploiter les dimensions publiées sur une vraie emprise OSM ; ne jamais extruder les cercles de localisation. Pour Vialleton, portée 14,5 m, passage 5 m, tablier IGN 51,2 m avec incertitude 1,5 m ; profil approché et couronne imprimable signalés. Reconstituer la voie inférieure et ses deux sorties dans une bande bornée, à partir des altitudes du terrain hors pont ; conserver le sol indépendamment du profil d'impression et les deux chaussées au niveau de leur support.
- Aqueduc Saint-Clément : profil documentaire identifié par son axe OSM et des sources patrimoniales propres à cet ouvrage. Distinguer doubles arcades Pitot et trois arches terminales Giral ; enregistrer les références, compter les arches reconstituées et annoncer les cotes et placements estimés.
- Vérifier les limites des services : taille des requêtes, résultats tronqués, pagination, durée totale, délais, cache borné et annulation.
- Enregistrer les sources réellement utilisées, l'heure de collecte et les avertissements. Les données partielles doivent être identifiées.
- Une ligne de côte ouverte n'est pas une surface de mer. Utiliser une source de surfaces vérifiée ou annoncer une couverture manquante ; ne pas inventer un remplissage arbitraire.

## 3. Normalisation géographique

- Identifiants typés `way/id`, `relation/id`, `node/id`, puis déduplication des membres déjà représentés par une relation.
- Assembler les fragments de multipolygones par leurs extrémités, avec inversion lorsque nécessaire. Ne jamais fermer individuellement un fragment ouvert.
- Associer chaque anneau intérieur au bon contour extérieur et préserver les cours, îles et trous.
- Refuser les surfaces ouvertes ou invalides ; nettoyer les sommets dupliqués sans inventer la géométrie manquante.
- Priorité aux dimensions explicites : `height`, `building:levels`, `roof:height`, `roof:shape`, largeur et nombre de voies. Les valeurs estimées doivent figurer dans le rapport.
- Conserver les données brutes séparément des données filtrées pour pouvoir modifier la préparation sans les télécharger à nouveau.

## 4. Préparation selon l'impression

- Profils épuré, équilibré et détaillé, avec réglage libre du détail minimum en mm.
- Seuil de surface des bâtiments en mm², hauteur minimum imprimée et tolérance de simplification en mm : ils doivent fonctionner quelle que soit l'échelle géographique.
- Conserver la silhouette urbaine ; écarter les petits abris et fragments qui deviennent du bruit. Désactiver les petits chemins et objets décoratifs par défaut.
- Routes et rivières : largeur imprimable contrôlée, simplification des lignes, raccords propres aux intersections et exclusion des infrastructures souterraines. Rétablir seulement les tronçons souterrains identifiés dans un passage de pont reconstitué et relié à ses sorties visibles.
- Routes, parcs, jardins, plages et plans d'eau : surfaces au niveau exact du terrain par défaut, avec couleurs conservées dans le 3MF. Gravure optionnelle pour une impression monochrome. Pas d'arbres, de fenêtres ou de mobilier ajoutés automatiquement.
- Toits détaillés lorsque l'information les justifie ; pas de toit inventé sur chaque bâtiment.
- Afficher le nombre d'objets conservés, écartés et de hauteurs estimées, ainsi que les compromis de simplification.

## 5. Géométrie solide

- Un moteur géométrique robuste (Manifold/WASM) pour les intersections, les extrusions et les unions.
- Toutes les coordonnées finales sont en **millimètres**, avec **Z vertical** et dessous du socle à **Z = 0**.
- Découpe des contours à la zone sélectionnée, avec conservation des trous. Aucun objet ne dépasse involontairement du modèle.
- Socle fermé, épaisseur réelle ; relief fermé dessous et sur tous les côtés.
- Bâtiments reliés au socle. Adapter leur assise au relief pour éviter les objets flottants ou enfouis ; conserver une silhouette architecturale cohérente.
- Géométries municipales et relief IGN : conserver le datum absolu IGN69 commun. Ne pas monter une coque entière au point DEM le plus haut de son emprise ; sa face de fermeture inférieure n'est pas le niveau de circulation.
- Routes et surfaces reliées au terrain, sans décalages destinés uniquement à éviter le z-fighting.
- Escaliers : relier les deux paliers DEM ou utiliser des dimensions verticales explicites. Regrouper les marches sous la résolution sans changer la montée totale. Refuser les montées inconnues, plates ou contradictoires ; conserver un tracé au sol et un avertissement.
- Peyrou : contraindre séparément les trois terrasses identifiées par leurs contours OSM lorsque le terrain IGN dense permet un ajustement robuste. Documenter le mode estimé depuis le DEM, les points retenus, la pente et l'écart ; préserver jardins inférieurs, exclusions bâties et corridors d'escaliers. Une surface de circulation CityGML mesurée reste prioritaire lorsqu'elle couvre un palier.
- Voûtes mesurées : prolonger uniquement les vrais appuis jusqu'au socle, préserver les ouvertures. Refuser une coque incomplète ; une réparation de joint est permise seulement dans un plan déjà couvert par une face source. Déclarer chaque repli.
- Aqueduc documentaire : tablier presque horizontal, piles de hauteur variable fondées sur le terrain, ouvertures réellement soustraites et assises reliées au socle. Phaser les travées depuis un repère géographique stable avant découpe pour qu'un changement de rectangle ne déplace pas les piles.
- Bassins : construire les bordures à l'extérieur du contour d'eau original, avant découpe à la sélection. Conserver l'intérieur ouvert et éviter un faux bord à travers un bassin coupé. Utiliser les dimensions renseignées puis un repli explicite, renforcer seulement les détails trop fins et compter les contours reconstitués.
- Vérifier que les surfaces à décalage zéro conservent le volume du terrain et suivent ses triangles sur une pente. Les panneaux de toiture mesurés deviennent des solides fondés, triangulés avec leurs trous et coupés à l'empreinte.
- Union réelle des solides pour le STL. Les évidements doivent retirer de la matière s'ils sont proposés ; ne pas simuler une gravure en plaçant un objet sous la surface.
- Contrôle du statut du moteur, du volume, du nombre de composantes et du nombre de triangles avant d'autoriser l'export.
- Réparer les contacts numériques localement, dans une tolérance bornée à 0,005 mm et annoncée. Ne pas remplacer une toiture source complexe par une extrusion de sa hauteur maximale sans avertissement ni remplir une cavité pour faire passer le contrôle.

## 6. Calcul et visualisation

- Calcul lourd dans un Web Worker ; les buffers du modèle final sont transférables.
- États distincts : collecte, construction, prêt et erreur ; « prêt » signifie qu'une géométrie valide existe.
- Annulation de la collecte et du worker, invalidation à chaque changement de zone, ignorance des réponses obsolètes.
- Changement de réglages : reconstruction des données déjà acquises. Une erreur conserve une action explicite pour corriger ou relancer.
- Aperçu du **même modèle** que l'export, matériaux par couche, cadrage adapté à sa taille et navigation simple.
- Panneau lisible en français, utilisable sur petit écran. Les contraintes de source et de fabrication sont placées près de l'action qu'elles concernent.

## 7. Export et projets

- STL binaire monochrome fusionné, indépendant de la scène de visualisation, sans lumières, helpers ou grille.
- 3MF en millimètres, modèle fermé et palette des couleurs choisies. L'affectation du filament dépend du slicer et ne doit pas être promise par une simple couleur de face.
- Tuiles obtenues par intersections volumiques avec fermeture des coupes, repositionnées pour l'impression. Vérifier que leurs volumes reconstituent le modèle et que chaque fichier possède des dimensions propres.
- Projet versionné : zone, lieu, réglages, données brutes et relief. Réouverture sans dépendre d'une nouvelle collecte ; validation des imports et migration contrôlée.
- Démonstration hors ligne identifiée comme synthétique, destinée à tester l'atelier, jamais présentée comme une reconstruction réelle de Montpellier.

## 8. Vérification et livraison

- Tests géographiques : relation fragmentée, plusieurs extérieurs, trous, doublons, ways ouvertes et hauteur/largeur explicite.
- Tests de fabrication : contours coupés, bâtiments traversant un bord, cour intérieure, relief, raccord routes/socle, filtre mm et composants connexes.
- Exports : dimensions/axes, triangle indices valides, arêtes fermées, volume positif, tuiles distinctes, somme des volumes et structure XML/ZIP du 3MF.
- Parcours navigateur : démo, changement de taille/profil/couleur, export STL/3MF, sauvegarde/réouverture, annulation et erreur suivie d'une relance.
- Essai réel de collecte sur Montpellier. Identifier séparément la validation automatique et l'absence éventuelle d'essai sur une imprimante physique.
- Lint, TypeScript et build production ; instructions de lancement, sources/licences et limites documentées.
- Commit sur `main` puis push sans réécrire l'historique distant. Vérifier le SHA distant après le push.

## Répartition

- Agent données : services, validation, normalisation OSM/IGN, relief et tests.
- Agent géométrie : moteur WASM, worker, qualité solide, exports et tuiles.
- Agent produit : atelier, carte, presets, orchestration, annulation, projets et démo.
- Agent toitures et topologie : pans mesurés, bâtiments coupés par la sélection, contacts numériques et conservation des cavités.
- Agent terrain : cohérence des terrasses, altitudes des paliers et distinction entre terrain estimé et architecture mesurée.
- Agent principal : intégration, dépendances, tests navigateur et réels, documentation, vérifications finales et push.

## Références techniques

- [API Manifold/WASM](https://manifoldcad.org/docs/jsapi/)
- [Spécification 3MF](https://github.com/3MFConsortium/spec_core)
- [Services Géoplateforme IGN](https://geoservices.ign.fr/documentation/services)
- [Overpass API](https://dev.overpass-api.de/overpass-doc/en/)

Le README décrit le comportement effectivement livré et les limites restantes ; ce plan fixe les objectifs et les critères de recette.

## Étude comparative et suite ciblée

[Map2Model](https://www.map2model.de/faq) combine OSM et le terrain Mapterhorn, avec un parcours d'export STL/3MF utile comme référence d'ergonomie. Une donnée architecturale absente d'OSM ne devient pas disponible par cette conversion. [CADmapper](https://cadmapper.com/help/) fournit une base CAD avec relief et bâtiments suivant la couverture, adaptée à une reprise manuelle des monuments. [TouchTerrain](https://github.com/ChHarding/TouchTerrain_for_CAGEO/blob/main/ReadMe.md) convient au terrain issu de DEM/GeoTIFF, mais ne reconstruit pas les façades ou voûtes.

[Lichtbild](https://www.lichtbild.com/unlimitedmodel) annonce une combinaison de sources commerciales, officielles, ouvertes et propriétaires, ainsi qu'une finition manuelle. Sa FAQ ne donne pas une méthode permettant de déduire tous les volumes depuis une image unique. Le fond [BD ORTHO IGN](https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_BD-ORTHO) ajouté à l'atelier sert à comparer les emprises et choisir la zone ; les couleurs des pixels n'ajoutent aucune hauteur au modèle imprimé.

Pour le Peyrou, la priorité exécutée est donc l'intégration des données locales mesurées, puis l'union imprimable du relief, des surfaces, escaliers et structures. Les toitures et coques proviennent du relevé municipal 2020 ; le terrain reste un champ d'altitudes, pas un scan architectural.

Le [plan municipal II 768 et les archives du Peyrou](https://archives.montpellier.fr/peyrou) permettent d'identifier l'organisation en terrasses ; ils ne constituent pas un levé altimétrique actuel. Les niveaux du parterre central, de la promenade haute et de la terrasse des eaux sont estimés séparément par ajustement aux points intérieurs du terrain IGN, dans les emprises OSM et hors exclusions connues. Le modèle conserve les pentes douces compatibles avec les points retenus, les jardins inférieurs et les paliers documentés. Une source trop grossière, insuffisante ou incohérente ne déclenche pas cette contrainte. Le rapport distingue ces terrasses estimées des surfaces de circulation mesurées présentes dans les coques 3D.

Les voûtes de l'aqueduc ne disposent pas d'un relevé 3D exploitable dans les sources acquises : le linéaire IGN vérifié possède des Z à −1000, explicitement « Pas de Z ». Une reconstitution paramétrique locale est cependant documentée par le [plan et la coupe Giral, Montpellier 3M EstL0112-03](https://memonum-mediatheques.montpellier3m.fr/ark:/12148/btv1b106601010), catalogués au XVIIIe siècle sans date précise et marqués domaine public. Le dessin cote notamment les piles inférieures à 3,75 m, le passage entre fûts à 8,40 m, les petites piles à 0,97 m et les petites ouvertures à 3,12 m. Ces valeurs diffèrent des ouvertures arrondies de 8 m et 2,78 m de la [notice officielle PA00103609](https://pop.culture.gouv.fr/notice/merimee/PA00103609) : ce sont des paramètres documentaires, pas des mesures actuelles certifiées.

La notice et le [plan municipal II 768, fin XVIIIe siècle](https://archives.montpellier.fr/peyrou), confirment trois grandes arches Giral au raccord au château, remplaçant les quatre arches finales de Pitot. Leur frontière estimée vers la longitude 3,86825 et leurs portées restent des hypothèses. Dans la sélection Peyrou [43,6099 ; 3,8677 ; 43,6131 ; 3,8745], l'axe OSM conserve environ 96 m jusqu'au château, dont environ 51 m attribués par hypothèse à ce pont terminal. La terrasse CityGML 2020 à 57,774 m IGN69 est un repère local, pas une cote mesurée du tablier. La pente historique de la conduite, environ 0,00029 selon le [devis Pitot transcrit par Yann L'Hôte en 2015](https://horizon.documentation.ird.fr/exl-doc/pleins_textes/divers16-07/010063868.pdf), correspond à moins de 3 cm sur ce tronçon ; elle ne justifie pas de faire suivre au tablier chaque variation du DEM. La reconstitution garde ces incertitudes dans son rapport et sa provenance.

Les bassins latéraux OSM 661168265 et 661168266 indiquent `barrier=wall`, `water=basin`, `height=0.1` ; le grand bassin 236815262 renseigne son contour mais pas les dimensions de la margelle. Une bordure estimée n'est donc pas une géométrie municipale mesurée. À l'échelle du site entier, ses dimensions minimales imprimables peuvent dépasser les dimensions réelles : le rapport doit déclarer ce renforcement.

Le [photomaillage municipal de Montpellier 2020](https://data.montpellier3m.fr/dataset/modele-photomesh-3d-de-la-ville-et-metropole-de-montpellier) est une piste concrète : dalles OBJ ODbL, plusieurs dizaines de Go disponibles sur demande. Une intégration future devra géoréférencer les dalles, distinguer sol/bâtiments/végétation, réparer les surfaces ouvertes et vérifier le résultat imprimable. Les points LiDAR classés ou une photogrammétrie multi-vues constituent d'autres voies de mesure ; un traitement automatique fiable du Peyrou reste à valider sur ces fichiers.

La recette du 11 octobre 2026 vérifie cinq modèles : Peyrou au niveau du terrain, Peyrou gravé, Montpellier, Comédie jusqu'à l'Arbre Blanc et Palavas. Le modèle entier et les quatre tuiles de chaque recette passent les contrôles de fermeture, d'orientation, de dimensions et de conservation du volume. Les cinquante fichiers STL et 3MF enregistrés sont ensuite relus et vérifiés indépendamment. Les 142 tests unitaires, neuf parcours navigateur sur le build de production, lint et TypeScript passent. Cette validation reste distincte d'une impression physique.

## Références GitHub exploitables

| Projet et licence actuelle                                                                                                                          | Usage utile à PrintMap                                                                                                      | Limite et priorité                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [OSM2World](https://github.com/tordanik/OSM2World), [MIT](https://github.com/tordanik/OSM2World/blob/master/LICENSE.txt)                            | `building:part`, formes et directions des toits ; catalogue pour des profils OSM renseignés.                                | Référence immédiate pour les replis paramétriques. Une scène détaillée n'est pas une garantie de solide fermé ni un relevé réel.  |
| [TouchTerrain](https://github.com/ChHarding/TouchTerrain_for_CAGEO), [GPLv3](https://github.com/ChHarding/TouchTerrain_for_CAGEO/blob/main/LICENSE) | Résolution physique du DEM, tuiles imprimables et prévention des cellules diagonales partageant quatre faces sur une arête. | Référence immédiate pour les tests de terrain ; ne reconstitue pas les bâtiments. Pas de copie GPL sans intégrer ses obligations. |
| [roofer](https://github.com/3DBAG/roofer), [GPLv3](https://github.com/3DBAG/roofer/blob/main/LICENSE)                                               | Nuage de points et empreinte vers LoD2.2/CityJSONSequence.                                                                  | Suite avec acquisition IGN LiDAR HD, traitement et validation propres. Ne recrée pas les voûtes ou façades absentes du nuage.     |
| [cjio](https://github.com/cityjson/cjio), [MIT](https://github.com/cityjson/cjio/blob/master/LICENSE)                                               | Extraction, reprojection, triangulation et validation indépendante de CityJSON.                                             | QA hors ligne après conversion du CityGML ; ne remplace pas le moteur d'union imprimable.                                         |

Ces projets ont été étudiés comme références, sans nouvelle dépendance ni copie de code GPL. La réutilisation future devra vérifier la licence du fichier, ses dépendances et la provenance des données, tout en conservant les contrôles de fermeture de PrintMap.

## Reprise de fidélité du 12 octobre 2026

Le cas Sainte-Anne a été reproduit avec une collecte réelle, ses voisins et une pièce de 200 mm. Les 268 pans municipaux étaient bien présents : une seule réparation locale ne suffisait pas à fermer le buffer Float32, et le repli extrudait la hauteur du clocher sur toute l’empreinte. Jusqu’à trois passages locaux, dans le budget existant, conservent maintenant la nef et le clocher à leurs cotes mesurées. La régression vérifie leur silhouette et leurs altitudes, en plus de la fermeture des quatre tuiles. Un fichier fermé ne suffit pas à prouver une architecture fidèle.

Un autre cas apparaît sur les grandes sélections : la simplification à 0,12 mm remplissait les retraits de l’emprise de l’église sans modifier ses 268 pans. À 1:6000, le contrôle constatait alors 2,76 % de toiture manquante sur cette empreinte déformée et rejetait le relevé. Les empreintes mesurées conservent désormais leur contour découpé exact ; la garde de couverture de 98 % et la simplification des formes génériques restent inchangées. Les régressions mesurent séparément la nef à 68,678 m IGN69 et la flèche à 111,971 m.

Un second défaut a été reproduit sur le Peyrou avec le profil Équilibré : après le retrait des fragments numériques, deux faces opposées presque confondues au débouché de Vialleton étaient interprétées comme un contact à découper. Leur annulation avant les coupes évite de déplacer cette singularité dans le terrain. La reconstruction n’a lieu que si des faces sont supprimées et sa variation de volume reste bornée à la tolérance numérique ; les coques négatives des cavités conservent leur orientation. Les trois passages et le budget des réparations physiques restent inchangés.

Les Trois Grâces sont identifiées par le [point OSM 4324886075](https://www.openstreetmap.org/node/4324886075), également présent dans le catalogue municipal des fontaines. La collecte demande désormais les fontaines, sculptures, monuments et mémoriaux pertinents, y compris les nodes. Le rapport distingue leur présence dans les données de l’absence de géométrie 3D : aucun point n’est transformé en sculpture générique.

Une nouvelle source de terrain est intégrée ; les autres sources ci-dessous ont été inspectées sans être ajoutées à la collecte :

- [MNT LiDAR HD IGN](https://www.data.gouv.fr/datasets/mnt-lidar-hd), Licence Ouverte 2.0 : il devient la source de relief prioritaire via la ressource REST officielle `ign_lidar_hd_mnt_mono_wld`. Sur le Peyrou, 4 816 points sont disponibles, avec un espacement réel de 6,47 m malgré la résolution native de 0,5 m. Au centre de Vialleton, le terrain interpolé passe de 44,919 m avec RGE ALTI à 44,337 m, cohérent avec le raster LiDAR à 44,340 m. Sur la terrasse ouest, un point passe de 50,546 m à 57,176 m. Toute grille LiDAR incomplète est remplacée entièrement par RGE ALTI avec avertissement ; aucune cellule manquante n’est discrètement mélangée au DEM mondial. L’annulation et les délais restent bornés. Les [nuages LiDAR locaux](https://www.data.gouv.fr/datasets/nuages-de-points-lidar-hd) ont été acquis le 28 mai 2021, avec une édition du 19 décembre 2024. Le MNS raster donne environ 51,41 m au centre du pont, mais ne remplace pas sa mesure distincte de tablier dans le moteur. Le sol caché peut être interpolé ; ces données ne fournissent pas ses corniches ou sa voûte.
- [Photomodèle municipal SKP 2016](https://data.montpellier3m.fr/dataset/photomodele-3d-urbain-de-la-ville-de-montpellier), ODbL : trois dalles ciblées ont été téléchargées et décodées. Sainte-Anne possède nef, flèche et pinnacles, mais ses fenêtres restent des textures. Le pont contient deux triangles de tablier, sans parapets ni voûte. Aux Trois Grâces, les faces décrivent le terrain à cet emplacement, sans objet 3D distinct de la fontaine ni sculpture. Ce format 3D ne garantit donc pas les détails recherchés.
- [Photomesh municipal OBJ 2017/2020](https://data.montpellier3m.fr/dataset/modele-photomesh-3d-de-la-ville-et-metropole-de-montpellier), ODbL : le catalogue et les ressources API renvoient à une demande de fichiers ; aucun téléchargement direct n’a été trouvé. Les dalles couvrant les monuments devront être inspectées avant de promettre leur fidélité.
- [Relevé géomètre 3D de Sainte-Anne pour la restauration](https://www.altemed.fr/wp-content/uploads/2025/10/V5_2025-05-27-DP-INAUG-STE-ANNE_compresse.pdf), documenté page 10 : un relevé complet a servi au diagnostic de 2021–2022. Aucun livrable réutilisable ni licence publique n’a été trouvé. Il ne fait pas partie des données intégrées.

La [couche building de Mapbox Streets](https://docs.mapbox.com/data/tilesets/reference/mapbox-streets-v8/#building) décrit les empreintes, parties et hauteurs pour l’extrusion. Elle peut fournir de bons contours ; son rendu ne constitue pas une source de sculpture ou de détails de façade. Pour Vialleton, notre profil reste une reconstruction approximative qui omet parapets, corniches et cartouche. Aucun maillage réutilisable authentifié des Trois Grâces de Montpellier n’a été trouvé dans cette recherche.

### Polygone et Arbre Blanc : données disponibles et limites

L’Arbre Blanc possède 69 pans municipaux horizontaux, à six niveaux de 33,433 à 68,571 m IGN69. Leur fusion par groupes de huit conserve leur enveloppe et leur volume sans modifier les coordonnées ; les levés inclinés gardent leur construction précédente. Cette source ne décrit aucune sous-face ou installation de balcon. Le bâtiment comporte pourtant [193 balcons et a été livré en juin 2019](https://dream.archi/fr/projects/34). Un extrait réel du nuage IGN, dans une emprise de 50 × 62 m, contient 134 478 points dont 88 008 classés bâtiments ; plusieurs niveaux extérieurs inférieurs apparaissent, mais les occultations empêchent de garantir leurs contours et dessous. L’extraction ciblée a nécessité 14 plages HTTP, soit 3,84 Mo, sans télécharger la dalle entière. Ce nuage est une piste de reconstruction ciblée, pas une coque intégrée à l’application.

Les deux coques municipales du Polygone, B106856 et B106853, comptent 1 011 et 313 faces. Le XML source présente lui-même des joints ouverts et une arête partagée par trois faces ; le moteur conserve donc son refus de coque invalide. Les 219 et 68 pans de toit restent disponibles. Le repli utilise leurs projections et celles des vrais appuis au sol, avec les trous, au lieu d’extruder une enveloppe convexe qui remplit les espaces entre les ailes. La couverture de 98 % reste exigée et la perte des ouvertures ou sous-faces est annoncée. La [rénovation du Polygone a été livrée en 2021](https://viguier.com/fr/projet/centre-commercial-polygone-montpellier/), après le millésime municipal 2020 ; celui-ci ne garantit pas son état actuel.

La fusion de la ville et la découpe des tuiles conservent désormais la tolérance native du maillage, après les contractions explicites et bornées. Élargir cette tolérance autorisait le noyau à recalculer un pan de toit du Polygone à partir d’un sommet de mur plus bas : une tuile fermée pouvait ainsi contenir une toiture déformée. La régression compare les hauteurs mesurées dans le modèle entier et dans chaque tuile repositionnée, ainsi que le volume et la fermeture. Les réparations locales des sources et leurs limites restent inchangées.

### Saint-Étienne : quatre plaques de 150 mm

Le raccourci **Saint-Étienne · centre et Parc Expo** sélectionne `[45.4288, 4.3702, 45.4540, 4.4060]`, soit environ 2,8 × 2,8 km. Il inclut le centre, le Musée d’Art et d’Industrie, Châteaucreux, Couriot, la Manufacture, la Cité du design et le Parc des expositions demandé. L’[accès officiel du Parc Expo](https://www.saint-etienne-parcexpo.com/les-acces-v2/) se situe à 45,449566 / 4,395390. Le bouton règle une pièce de 290 mm, le profil Équilibré, le relief et une grille de 2 × 2 : les tuiles mesurent environ 144,5 × 145 mm. La première proposition compacte `[45.4288, 4.3792, 45.4444, 4.4014]` excluait le Parc Expo. L’extension passe de 1:5982 à 1:9662 à taille identique : les bâtiments deviennent environ 38 % plus petits. Ce zonage ne couvre pas toute la commune.

Sur cette sélection, la décomposition native recopiait les métadonnées de milliers de bâtiments dans plus de 5 000 coques numériques de raccord au terrain. La mémoire WASM atteignait sa limite de 4 Go avant leur nettoyage. Au-delà de 1 024 détails tagués, les solides sont désormais fusionnés par couche puis reçoivent une seule identité de matériau par couche ; le terrain conserve sa palette mixte. Cette réduction de métadonnées reste native, sans arrondi préalable, et conserve les coordonnées, les hauteurs et les cavités. Les sélections plus petites conservent les mêmes objets et le même ordre booléen, notamment les 346 détails du Peyrou à 300 mm. Le contrôle de fermeture du modèle et des tuiles ainsi que le budget des corrections restent obligatoires.

La collecte réelle du centre et Parc Expo du 12 octobre 2026 contient 12 718 bâtiments bruts, dont 10 990 avec hauteur mesurée. Les 1 728 hauteurs restantes sont annoncées comme estimées. La pagination IGN continue désormais jusqu’à 20 000 objets et huit pages, sous le même délai global de 22 secondes : cette sélection nécessite cinq pages pour couvrir ses 12 055 objets IGN au lieu de s’arrêter aux 10 000 premiers. Les deux halls demandés récupèrent ainsi une hauteur à la gouttière de 15,8 m pour le Hall A et 9,3 m pour le Hall B. Le terrain LiDAR utilise une grille de 65 × 65 points, espacés d’environ 43,8 m. Aucune toiture municipale 3D mesurée n’est fournie par le collecteur actuel sur cette zone. La [maquette CRAIG 2021](https://www.data.gouv.fr/datasets/maquette-3d-batiments-auvergne-rhone-alpes-2021) propose du LoD2.2/3 sous Licence Ouverte 2.0, uniquement sur Badouillière–Chavanelle. Cette source est identifiée pour une future intégration ciblée ; elle n’est pas présente dans les exports livrés. Attribution demandée par la métadonnée CRAIG : « CRAIG - FEDER Auvergne-Rhône-Alpes - 2021 ».

La recette finale du 12 octobre 2026 valide sept modèles : Saint-Étienne centre et Parc Expo à 290 mm, Sainte-Anne à 200 mm, Peyrou équilibré à 200 mm, Peyrou détaillé et gravé à 300 mm, Comédie–Arbre Blanc à 200 mm et un grand quartier de Montpellier à 150 mm. Chaque modèle et ses quatre tuiles sont fermés et orientés, avec conservation du volume. Les 70 fichiers STL et 3MF enregistrés sont relus indépendamment ; leurs dimensions et leurs volumes sont contrôlés. Saint-Étienne contient 4 642 bâtiments imprimés dans un volume connecté, sur 289,06 × 290 × 22,31 mm ; ses quatre plaques mesurent 144,53 × 145 mm. Les 189 tests unitaires, dix parcours navigateur sur le build de production, lint, TypeScript et le build passent. Aucun essai physique d’impression n’est déclaré.
