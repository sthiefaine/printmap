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
