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
- Relief indépendant des bâtiments : source IGN lorsque disponible puis DEM global. Une réponse manquante ou incohérente ne doit pas se transformer silencieusement en altitude zéro.
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
- Routes et rivières : largeur imprimable contrôlée, simplification des lignes, raccords propres aux intersections et exclusion des infrastructures souterraines.
- Parcs, jardins, plages et plans d'eau : surfaces lisibles et relief léger. Pas d'arbres, de fenêtres ou de mobilier ajoutés automatiquement.
- Toits détaillés lorsque l'information les justifie ; pas de toit inventé sur chaque bâtiment.
- Afficher le nombre d'objets conservés, écartés et de hauteurs estimées, ainsi que les compromis de simplification.

## 5. Géométrie solide

- Un moteur géométrique robuste (Manifold/WASM) pour les intersections, les extrusions et les unions.
- Toutes les coordonnées finales sont en **millimètres**, avec **Z vertical** et dessous du socle à **Z = 0**.
- Découpe des contours à la zone sélectionnée, avec conservation des trous. Aucun objet ne dépasse involontairement du modèle.
- Socle fermé, épaisseur réelle ; relief fermé dessous et sur tous les côtés.
- Bâtiments reliés au socle. Adapter leur assise au relief pour éviter les objets flottants ou enfouis ; conserver une silhouette architecturale cohérente.
- Routes et surfaces reliées au terrain, sans décalages destinés uniquement à éviter le z-fighting.
- Union réelle des solides pour le STL. Les évidements doivent retirer de la matière s'ils sont proposés ; ne pas simuler une gravure en plaçant un objet sous la surface.
- Contrôle du statut du moteur, du volume, du nombre de composantes et du nombre de triangles avant d'autoriser l'export.

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
- Agent principal : intégration, dépendances, tests navigateur et réels, documentation, vérifications finales et push.

## Références techniques

- [API Manifold/WASM](https://manifoldcad.org/docs/jsapi/)
- [Spécification 3MF](https://github.com/3MFConsortium/spec_core)
- [Services Géoplateforme IGN](https://geoservices.ign.fr/documentation/services)
- [Overpass API](https://dev.overpass-api.de/overpass-doc/en/)

Le README décrit le comportement effectivement livré et les limites restantes ; ce plan fixe les objectifs et les critères de recette.
