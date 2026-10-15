#!/usr/bin/env python3
"""Derive INCOMPLETE visible terrace patches from public IGN LiDAR returns.

This is an offline preparation tool, not an automatic facade/solid survey.
Dependencies: numpy, shapely==2.1.2, matplotlib; laspy[lazrs] for --download.
No application dependency is added. Reproduce from the delivered reference:

  python3 scripts/derive-arbre-blanc-lidar.py --download --plot /tmp/arbre.png

The reference JSON supplies only the authentic OSM core and municipal ground
boundary. Derived patches are recalculated from the point cloud, never used as
input. A cached NPZ can be supplied with --points. To create the first reference,
use --citygml <B102558 member XML> --osm <OSM way441634682/full XML>.

At 0.5 m the raster, filtering, gap closure and simplification infer contours.
They do not establish complete balconies, undersides, slab thickness or load
bearing structure. Empty/occluded regions are not filled to look complete.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
import xml.etree.ElementTree as ET

# Optional isolated analysis environment; never import a different Python ABI.
if os.environ.get("PRINTMAP_LIDAR_PYTHON_LIBS"):
    sys.path.insert(0, os.environ["PRINTMAP_LIDAR_PYTHON_LIBS"])

import numpy as np
import shapely
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_MQ_2024-12-19/LHD_FXX_0772_6279_PTS_LAMB93_IGN69.copc.laz"
SOURCE_DATE = "2021-05-28"
CROP_MIN = np.array([772505.0, 6278918.0, 0.0])
CROP_MAX = np.array([772555.0, 6278980.0, 85.0])
# Frozen density maxima observed in this cloud, not assumed storey spacing.
LEVELS = (17.05, 20.25, 23.05, 25.75, 28.45, 31.25, 34.05, 36.85,
          39.65, 42.35, 45.05, 47.85, 50.65, 53.35, 56.25, 59.55, 62.75)
GRID_M = .5
BAND_M = .2
MAX_CORE_GAP_M = 1.5
MAX_CONTOUR_INFERENCE_M = .5
SIMPLIFY_M = .25

# Same GRS80 Lambert-93 transformation as src/lib/data/lambert93.ts.
A = 6378137
E = math.sqrt(2 / 298.257222101 - 1 / 298.257222101 ** 2)
RAD = math.pi / 180


def iso(phi):
    return math.log(math.tan(math.pi / 4 + phi / 2) *
                    ((1 - E * math.sin(phi)) / (1 + E * math.sin(phi))) ** (E / 2))


def m(phi):
    return math.cos(phi) / math.sqrt(1 - E * E * math.sin(phi) ** 2)


N = math.log(m(44 * RAD) / m(49 * RAD)) / (iso(49 * RAD) - iso(44 * RAD))
C = A * m(44 * RAD) * math.exp(N * iso(44 * RAD)) / N
YS = 6600000 + C * math.exp(-N * iso(46.5 * RAD))


def to_lambert(lon, lat):
    radius = C * math.exp(-N * iso(lat * RAD))
    angle = N * (lon - 3) * RAD
    return 700000 + radius * math.sin(angle), YS - radius * math.cos(angle)


def from_lambert(x, y):
    radius = math.hypot(x - 700000, YS - y)
    latitude_iso = -math.log(radius / C) / N
    phi = 2 * math.atan(math.exp(latitude_iso)) - math.pi / 2
    for _ in range(8):
        phi = 2 * math.atan(math.exp(latitude_iso) *
                            ((1 + E * math.sin(phi)) / (1 - E * math.sin(phi))) ** (E / 2)) - math.pi / 2
    return {"lat": round(phi / RAD, 9),
            "lon": round(3 + math.atan2(x - 700000, YS - y) / N / RAD, 9)}


def geographic_polygon(polygon):
    return {"outer": [from_lambert(x, y) for x, y in polygon.exterior.coords],
            "holes": [[from_lambert(x, y) for x, y in ring.coords]
                      for ring in polygon.interiors]}


def projected_polygon(polygon):
    def ring(points):
        return [to_lambert(p["lon"], p["lat"]) for p in points]
    return Polygon(ring(polygon["outer"]), [ring(r) for r in polygon["holes"]])


def source_boundaries(args):
    if args.citygml and args.osm:
        namespaces = {"b": "http://www.opengis.net/citygml/building/2.0",
                      "g": "http://www.opengis.net/gml"}
        fragment = Path(args.citygml).read_text()
        wrapper = ('<root xmlns:core="http://www.opengis.net/citygml/2.0" '
                   'xmlns:bldg="http://www.opengis.net/citygml/building/2.0" '
                   'xmlns:gml="http://www.opengis.net/gml" '
                   'xmlns:gen="http://www.opengis.net/citygml/generics/2.0" '
                   'xmlns:xlink="http://www.w3.org/1999/xlink">')
        root = ET.fromstring(wrapper + fragment + "</root>")
        building = root.find('.//b:Building[@g:id="B102558"]', namespaces)
        if building is None:
            raise ValueError("Source must contain municipal building B102558")
        ground_surface = building.find(".//b:GroundSurface//g:Polygon", namespaces)
        if ground_surface is None:
            raise ValueError("Measured municipal ground boundary is missing")
        def city_ring(xpath):
            values = list(map(float, ground_surface.find(xpath, namespaces).text.split()))
            return list(zip(values[::3], values[1::3]))
        outer = city_ring("./g:exterior//g:posList")
        holes = []
        for interior in ground_surface.findall("./g:interior//g:posList", namespaces):
            values = list(map(float, interior.text.split()))
            holes.append(list(zip(values[::3], values[1::3])))
        ground = Polygon(outer, holes)
        osm = ET.parse(args.osm).getroot()
        nodes = {n.attrib["id"]: to_lambert(float(n.attrib["lon"]), float(n.attrib["lat"]))
                 for n in osm.findall("node")}
        way = osm.find('./way[@id="441634682"]')
        if way is None:
            raise ValueError("OSM source must include way 441634682 and its nodes")
        core = Polygon([nodes[n.attrib["ref"]] for n in way.findall("nd")])
    else:
        reference = json.loads(args.reference.read_text())
        # Preserve the exact source coordinates across regeneration. The WGS84
        # publication is rounded for a compact browser asset, not a new survey.
        lambert = reference.get("referenceBoundariesLambert93")
        if lambert:
            core = Polygon(lambert["core"]["outer"], lambert["core"]["holes"])
            ground = Polygon(lambert["ground"]["outer"], lambert["ground"]["holes"])
        else:
            core = projected_polygon(reference["coreFootprint"])
            ground = projected_polygon(reference["groundFootprint"])
    if not core.is_valid or not ground.is_valid or not 500 < core.area < 1100 or not 1000 < ground.area < 1800:
        raise ValueError("Invalid or incorrectly projected reference boundaries")
    return core, ground


def download_crop(destination):
    import laspy
    import laspy.copc as copc
    started = time.monotonic()
    used = 0
    lock = threading.Lock()
    original_read = copc.HttpRangeStream.read
    def bounded_read(stream, length):
        nonlocal used
        if length == 0:
            return b""
        if length < 0 or length > 8 * 1024 * 1024 or time.monotonic() - started > 85:
            raise RuntimeError("COPC range/deadline budget exceeded")
        with lock:
            used += length
            if used > 32 * 1024 * 1024:
                raise RuntimeError("COPC total download budget exceeded")
        with stream.session.get(stream.url, headers={"Range": f"bytes={stream.range_start}-{stream.range_start + length - 1}"}, stream=True, timeout=18) as response:
            if response.status_code != 206:
                raise RuntimeError(f"Public COPC Range request returned HTTP {response.status_code}")
            data = response.raw.read(length + 1)
            if len(data) != length:
                raise RuntimeError("Incomplete or excessive COPC Range response")
        stream.range_start += length
        return data
    copc.HttpRangeStream.read = bounded_read
    try:
        with laspy.CopcReader.open(SOURCE_URL, http_num_threads=4) as reader:
            points = reader.query(bounds=copc.Bounds(CROP_MIN, CROP_MAX))
        if len(points) > 500000:
            raise RuntimeError("Crop point budget exceeded")
        np.savez_compressed(destination, x=np.asarray(points.x), y=np.asarray(points.y),
                            z=np.asarray(points.z), classification=np.asarray(points.classification))
    finally:
        copc.HttpRangeStream.read = original_read
    print(json.dumps({"downloadBytes": used, "seconds": round(time.monotonic() - started, 3)}))


def components(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    return [p for g in getattr(geometry, "geoms", []) for p in components(g)]


def derive(xy, z, classification, core, ground):
    selected = ((classification == 6) & shapely.contains_xy(ground, xy[:, 0], xy[:, 1]) &
                ~shapely.contains_xy(core, xy[:, 0], xy[:, 1]))
    levels, plots = [], []
    for elevation in LEVELS:
        mask = selected & (np.abs(z - elevation) <= BAND_M)
        points, heights = xy[mask], z[mask]
        cells, counts = np.unique(np.floor(points / GRID_M).astype(np.int64), axis=0, return_counts=True)
        observed = unary_union([box(x * GRID_M, y * GRID_M, (x + 1) * GRID_M, (y + 1) * GRID_M)
                                for (x, y), count in zip(cells, counts) if count >= 2]).intersection(ground).difference(core)
        # An occupied one-cell wall trace is not a measured terrace. Opening
        # removes such narrow traces and may also omit narrow real terraces.
        opened = observed.buffer(-.251, join_style=2).buffer(.251, join_style=2)
        closed = opened.buffer(.25, join_style=2).buffer(-.25, join_style=2)
        derived = closed.simplify(SIMPLIFY_M, preserve_topology=True)
        # Enforce the bound explicitly: mitered joins and simplification may
        # otherwise bridge an arbitrarily long concavity at an acute corner.
        derived = derived.intersection(observed.buffer(MAX_CONTOUR_INFERENCE_M)).intersection(ground).difference(core)
        kept, gaps, verification = [], [], []
        for polygon in sorted(components(derived), key=lambda p: (-p.area, p.centroid.x, p.centroid.y)):
            gap = polygon.distance(core)
            support = polygon.intersection(observed).area
            if polygon.area < 1 or gap > MAX_CORE_GAP_M or support < polygon.area * .8:
                continue
            nearby = shapely.intersects_xy(polygon.buffer(.01), points[:, 0], points[:, 1])
            if int(nearby.sum()) < 8:
                continue
            kept.append(polygon)
            gaps.append(gap)
            # Actual source returns, not triangle centroids, for independent QA.
            candidates = np.flatnonzero(nearby)
            distances = shapely.distance(shapely.points(points[candidates]), polygon.boundary)
            order = np.lexsort((points[candidates, 1], points[candidates, 0], -distances))
            for index in candidates[order]:
                point = points[index]
                clearance = float(shapely.distance(shapely.Point(*point), polygon.boundary))
                if clearance < .3:
                    continue
                if any(math.hypot(point[0] - v["x"], point[1] - v["y"]) < 1 for v in verification):
                    continue
                verification.append({**from_lambert(*point), "elevationM": elevation,
                                     "observedElevationM": round(float(heights[index]), 3),
                                     "clearanceM": round(clearance, 3), "x": float(point[0]), "y": float(point[1])})
                break
        retained = unary_union(kept)
        # Coordinate publication is rounded by <0.1 mm, below every bound here.
        for polygon in kept:
            if not polygon.is_valid or polygon.intersection(core).area > 1e-6 or polygon.difference(ground).area > 1e-6:
                raise ValueError("A derived patch leaves its declared reference mask")
        levels.append({"elevationM": elevation, "polygons": [geographic_polygon(p) for p in kept],
                       "pointCount": int(mask.sum()), "observedAreaM2": round(retained.intersection(observed).area, 3),
                       "derivedAreaM2": round(retained.area, 3), "rawObservedAreaM2": round(observed.area, 3),
                       "inferredAreaM2": round(retained.difference(observed).area, 3),
                       "maxCoreGapM": round(max(gaps, default=0), 4),
                       "verificationPoints": [{k: v for k, v in p.items() if k not in ("x", "y")} for p in verification]})
        plots.append((elevation, points, observed, kept))
    return levels, plots


def plot_result(path, core, ground, plots):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon as Patch
    fig, axes = plt.subplots(4, 5, figsize=(16, 14))
    ox, oy = 772530, 6278950
    for ax, (elevation, points, observed, kept) in zip(axes.flat, plots):
        ax.scatter(points[:, 0] - ox, points[:, 1] - oy, s=.8, color="black", alpha=.5)
        for polygon in kept:
            ax.add_patch(Patch(np.asarray(polygon.exterior.coords) - [ox, oy], facecolor="#1ca896", alpha=.5))
            for ring in polygon.interiors:
                ax.add_patch(Patch(np.asarray(ring.coords) - [ox, oy], facecolor="white"))
        for polygon, color in [(ground, "#8c8c8c"), (core, "#2860bd")]:
            x, y = polygon.exterior.xy
            ax.plot(np.asarray(x) - ox, np.asarray(y) - oy, color=color, lw=1)
        ax.set(xlim=(-25, 25), ylim=(-32, 32), aspect="equal",
               title=f"{elevation:g} m IGN69 · {len(kept)} parties · {sum(p.area for p in kept):.1f} m²")
        ax.tick_params(labelsize=7)
    for ax in list(axes.flat)[len(plots):]:
        ax.set_visible(False)
    fig.suptitle("Arbre Blanc · LiDAR IGN 28/05/2021 · contours visibles dérivés INCOMPLETS\n"
                 "Noir : retours classe6 ±0,20m ; vert : contours dérivés ; bleu : noyau OSM ; gris : emprise municipale", fontsize=12)
    fig.text(.03, .015, "Licence Ouverte 2.0/ODbL. Raster0,5m, ≥2retours/cellule ; traces fines retirées ; lacunes refermées≤0,5m ; simplification≤0,25m.\n"
             "Parties à plus de1,5m du noyau omises. Les raccords, sous-faces et épaisseurs ne sont pas mesurés ; les193 balcons ne sont pas reconstruits.", fontsize=9)
    fig.tight_layout(rect=(0, .05, 1, .94))
    fig.savefig(path, dpi=160)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--points", type=Path, default=Path("/tmp/printmap-arbre-lidar-crop.npz"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--citygml", type=Path)
    parser.add_argument("--osm", type=Path)
    parser.add_argument("--reference", type=Path, default=ROOT / "src/lib/data/arbre-blanc-lidar.json")
    parser.add_argument("--output", type=Path, default=ROOT / "src/lib/data/arbre-blanc-lidar.json")
    parser.add_argument("--plot", type=Path, default=Path("/tmp/printmap-arbre-blanc-lidar-derived.png"))
    args = parser.parse_args()
    core, ground = source_boundaries(args)
    if args.download:
        download_crop(args.points)
    with np.load(args.points, allow_pickle=False) as cloud:
        xy = np.c_[cloud["x"], cloud["y"]]
        z, classification = cloud["z"], cloud["classification"]
    if len(xy) > 500000 or xy.shape != (len(z), 2) or len(classification) != len(z) or not np.isfinite(xy).all() or not np.isfinite(z).all():
        raise ValueError("Invalid or excessive source crop")
    levels, plots = derive(xy, z, classification, core, ground)
    vertices = sum(len(p["outer"]) + sum(map(len, p["holes"])) for level in levels for p in level["polygons"])
    polygons = sum(len(level["polygons"]) for level in levels)
    if vertices > 8000 or polygons > 256:
        raise ValueError("Derived geometry budget exceeded")
    output = {"version": 1, "source": "IGN LiDAR HD · plateaux visibles dérivés, incomplets",
              "sourceDate": SOURCE_DATE, "sourceUrl": SOURCE_URL,
              "licence": {"name": "Licence Ouverte 2.0 (LiDAR) et ODbL 1.0 (emprises OSM/municipales)", "url": "https://opendatacommons.org/licenses/odbl/1-0/"},
              "crs": "EPSG:4326", "sourceCrs": "EPSG:2154", "verticalDatum": "IGN69", "incomplete": True,
              "coreFootprint": geographic_polygon(core), "groundFootprint": geographic_polygon(ground),
              "referenceBoundariesLambert93": {
                  "core": {"outer": list(core.exterior.coords), "holes": [list(r.coords) for r in core.interiors]},
                  "ground": {"outer": list(ground.exterior.coords), "holes": [list(r.coords) for r in ground.interiors]}},
              "bounds": [min(p["lat"] for p in geographic_polygon(ground)["outer"]), min(p["lon"] for p in geographic_polygon(ground)["outer"]),
                         max(p["lat"] for p in geographic_polygon(ground)["outer"]), max(p["lon"] for p in geographic_polygon(ground)["outer"])],
              "method": {"gridM": GRID_M, "halfBandM": BAND_M, "minimumReturnsPerCell": 2,
                         "wallTraceOpeningRadiusM": .251, "maxClosingM": .5, "closingRadiusM": .25,
                         "maxSimplificationM": SIMPLIFY_M, "maxContourInferenceM": MAX_CONTOUR_INFERENCE_M,
                         "coreConnectionMaxM": MAX_CORE_GAP_M, "minimumPartAreaM2": 1,
                         "minimumObservedAreaFraction": .8, "maxVertices": 8000, "maxPolygons": 256,
                         "slabThicknessMeasured": False, "undersidesMeasured": False,
                         "surfaceRoleClassified": False,
                         "description": "Pics de densité verticale figés du nuage ; pixels occupés puis ouverture, fermeture et simplification bornées. Aucun contour global convexe, aucun noyau ajouté aux plateaux. Raccords vers le noyau non inclus et non mesurés."},
              "provenance": {"pointCloud": {"tile": "0772-6279", "flightDate": SOURCE_DATE, "publicationDate": "2024-12-19",
                                            "cropLambert93": [CROP_MIN.tolist(), CROP_MAX.tolist()],
                                            "pointCount": len(xy), "buildingPointCount": int((classification == 6).sum()),
                                            "cropFileSha256": hashlib.sha256(args.points.read_bytes()).hexdigest(),
                                            "licence": "Licence Ouverte / Open Licence 2.0",
                                            "licenceUrl": "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
                                            "catalogue": "https://www.data.gouv.fr/datasets/nuages-de-points-lidar-hd"},
                             "core": {"source": "© OpenStreetMap contributors", "wayId": 441634682,
                                      "url": "https://www.openstreetmap.org/way/441634682", "licence": "ODbL", "snapshotDate": "2026-10-12"},
                             "ground": {"source": "Montpellier Méditerranée Métropole", "sourceId": "MMM/B102558", "year": 2020,
                                        "url": "https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier", "licence": "ODbL"},
                             "generator": {"script": "scripts/derive-arbre-blanc-lidar.py", "version": 1,
                                           "numpy": np.__version__, "shapely": shapely.__version__}},
              "levels": levels, "warnings": [
                  "Reconstruction partielle dérivée de retours LiDAR aériens, et non relevé complet des193 balcons.",
                  "Les façades et dessous occultés, les garde-corps et l’épaisseur des dalles ne sont pas mesurés par cette dérivation.",
                  "Les surfaces horizontales visibles peuvent inclure des dessus de terrasses, des brise-soleil ou des pergolas ; leur fonction n’est pas classée dans le nuage.",
                  "Les contours sont inférés sur une grille de 0,5 m ; fermeture et simplification bornées. Les points isolés, traces fines et parties éloignées du noyau sont omis.",
                  "Tout raccord vers le noyau (1,5 m au maximum) et toute épaisseur minimale ajoutés pour imprimer devront être déclarés comme inférés.",
                  "Le noyau provient du contour OpenStreetMap ; son extrusion est une approximation de façade, pas une maquette architecturale."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")
    plot_result(args.plot, core, ground, plots)
    print(json.dumps({"output": str(args.output), "plot": str(args.plot), "levels": len(levels),
                      "nonemptyLevels": sum(bool(level["polygons"]) for level in levels), "polygons": polygons,
                      "vertices": vertices, "areasM2": [level["derivedAreaM2"] for level in levels]}))


if __name__ == "__main__":
    main()
