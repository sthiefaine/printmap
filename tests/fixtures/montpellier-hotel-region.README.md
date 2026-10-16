# Hôtel de région, Montpellier

`montpellier-hotel-region-roofs.json` is the unmodified B102810 building collected in the user's Montpellier assembly cell on 16 October 2026. It includes the four municipal roof panels, their inner ring, the ground footprint and the original source identities (`MMM/B102810`, OpenStreetMap `way/283339491`). Absolute altitudes are IGN69: ground 9.33 m and horizontal roofs 55.568, 58.900, 59.223 and 59.276 m.

The municipal geometry contains 4 RoofSurfaces, 28 WallSurfaces and 1 GroundSurface; its wall polygons have no opening or glass-recess boundary. The 2016 municipal SketchUp geometry likewise has no recess geometry. Those sources therefore do not justify a through-tunnel.

Sources:

- Montpellier Méditerranée Métropole, [CityGML LoD2.2 buildings, 2020](https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier), [original archive](https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_Bat3D.zip), Open Data Commons Open Database License (ODbL), as stated in the municipal catalogue.
- [OpenStreetMap](https://www.openstreetmap.org/way/283339491), © OpenStreetMap contributors, ODbL 1.0; only identity/address/name tags are retained from the replaced OSM object.
- Dominique Ganibenc, [L’Hôtel de Région en Languedoc-Roussillon (1986–1989), un chantier de recherche](https://journals.openedition.org/pds/1222), *Patrimoines du Sud* 3 (2016), pp. 125–126, figures 13–14, DOI 10.4000/pds.1222. The text documents two closed glass facades measuring 21 × 8 m, installed in 1989. The two contemporary photographs establish the central recessed composition; the article's only elevation drawing (fig. 8) describes an earlier, subsequently modified design. No photograph or drawing is redistributed in this fixture.

`src/lib/data/hotel-region-facade.json` separates those documented dimensions from the interpreted bottom level (+8 m above source ground) and recess depth (1.5 m). The printed recess is bounded to 0.24–0.40 mm for readability and retains at least 0.8 mm of central material. This is a documentary facade relief, not a measured architectural model, and it does not reconstruct small windows, mouldings or an open passage. Roofs, source ground and the footprint remain unchanged.
