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
from collections import defaultdict

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
NORMAL_RADIUS_M = 1.25
NORMAL_MIN_POINTS = 8
NORMAL_MIN_Z = .9
NORMAL_MAX_PLANARITY = .03
NORMAL_MAX_RESIDUAL_M = .12
HORIZONTAL_OPENING_M = .125

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


def derive_legacy(xy, z, classification, core, ground):
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


def horizontal_returns(xy, z, classification, candidates):
    """Validate candidate returns against an UNSLICED 3D neighbourhood.

    Fitting only the +/-0.2m band would make every sliced vertical wall look
    horizontal. All class 1/6 returns within a 1.25m sphere take part instead.
    Class 1 returns additionally need native building returns in that plane.
    Existing contours do not depend on this additional, conservative test.
    """
    xyz = np.c_[xy, z]
    buckets = defaultdict(list)
    for index in np.flatnonzero((classification == 6) | (classification == 1)):
        buckets[tuple(np.floor(xy[index] / NORMAL_RADIUS_M).astype(np.int64))].append(index)
    selected = np.zeros(len(z), dtype=bool)
    details = {}
    for index in np.flatnonzero(candidates):
        cell = np.floor(xy[index] / NORMAL_RADIUS_M).astype(np.int64)
        nearby = []
        for a in range(-1, 2):
            for b in range(-1, 2):
                nearby.extend(buckets.get((cell[0] + a, cell[1] + b), []))
        # Bounded offline work; an unusually dense/ambiguous region simply
        # receives no additional reconstruction, without losing old contours.
        if len(nearby) > 5000:
            continue
        indices = np.asarray(nearby, dtype=np.int64)
        distance2 = ((xyz[indices] - xyz[index]) ** 2).sum(axis=1)
        indices = indices[distance2 <= NORMAL_RADIUS_M ** 2]
        if len(indices) < NORMAL_MIN_POINTS:
            continue
        points = xyz[indices]
        mean = points.mean(axis=0)
        delta = points - mean
        eigenvalues, vectors = np.linalg.eigh(delta.T @ delta / len(points))
        normal = vectors[:, 0]
        planarity = float(eigenvalues[0] / max(eigenvalues.sum(), 1e-12))
        residual = float(abs(np.dot(xyz[index] - mean, normal)))
        building_support = int(((classification[indices] == 6) &
                                (abs((points - mean) @ normal) <= NORMAL_MAX_RESIDUAL_M)).sum())
        if (abs(normal[2]) < NORMAL_MIN_Z or planarity > NORMAL_MAX_PLANARITY or
                residual > NORMAL_MAX_RESIDUAL_M or eigenvalues[1] <= .01 or
                (classification[index] == 1 and building_support < 3)):
            continue
        selected[index] = True
        details[int(index)] = {"neighbourCount": len(indices),
                               "normalZ": round(float(abs(normal[2])), 4),
                               "planarity": round(planarity, 5),
                               "residualM": round(residual, 4),
                               "nativeBuildingSupport": building_support}
    return selected, details


def derive(xy, z, classification, core, ground, selection_core=None):
    # Recompute the historical observations independently, preserving all of
    # their contours and frozen source witnesses. New plane evidence is ONLY
    # additive; an ambiguous PCA normal must never erase a real old terrace.
    levels, legacy_plots = derive_legacy(xy, z, classification, core, ground)
    selection_core = selection_core if selection_core is not None else core
    exterior = (shapely.contains_xy(ground, *xy.T) &
                ~shapely.contains_xy(selection_core, *xy.T))
    in_bands = np.any(abs(z[:, None] - np.asarray(LEVELS)[None, :]) <= BAND_M, axis=1)
    candidates = exterior & in_bands & ((classification == 6) | (classification == 1))
    horizontal, support_details = horizontal_returns(xy, z, classification, candidates)
    plots = []
    for level, (_, old_points, old_observed, old_parts) in zip(levels, legacy_plots):
        elevation = level["elevationM"]
        indices = np.flatnonzero(horizontal & (abs(z - elevation) <= BAND_M))
        points = xy[indices]
        cells = np.unique(np.floor(points / GRID_M).astype(np.int64), axis=0)
        observed = unary_union([box(x * GRID_M, y * GRID_M,
                                    (x + 1) * GRID_M, (y + 1) * GRID_M)
                                for x, y in cells]).intersection(ground).difference(selection_core)
        opened = observed.buffer(-HORIZONTAL_OPENING_M, join_style=2).buffer(HORIZONTAL_OPENING_M, join_style=2)
        closed = opened.buffer(.25, join_style=2).buffer(-.25, join_style=2)
        derived = (closed.simplify(SIMPLIFY_M, preserve_topology=True)
                   .intersection(observed.buffer(MAX_CONTOUR_INFERENCE_M))
                   .intersection(ground).difference(selection_core))
        additional = []
        rejected_gap_area = 0.
        for polygon in components(derived):
            if polygon.area < 1 or polygon.intersection(observed).area < polygon.area * .8:
                continue
            if polygon.distance(selection_core) > MAX_CORE_GAP_M:
                rejected_gap_area += polygon.area
                continue
            nearby = shapely.intersects_xy(polygon.buffer(.01), *points.T)
            if int(nearby.sum()) < 8:
                continue
            additional.append(polygon)
        old = unary_union(old_parts)
        retained = unary_union([old, *additional])
        delta = retained.difference(old)
        parts = sorted(components(retained), key=lambda p: (-p.area, p.centroid.x, p.centroid.y))
        for polygon in parts:
            if not polygon.is_valid or polygon.intersection(selection_core).area > 1e-6 or polygon.difference(ground).area > 1e-6:
                raise ValueError("Recovered patch leaves the declared source masks")
        witnesses = list(level["verificationPoints"])
        recovered_witnesses = []
        for polygon in sorted(components(delta), key=lambda p: -p.area):
            nearby = np.flatnonzero(shapely.intersects_xy(polygon, *points.T))
            if not len(nearby):
                continue
            distances = shapely.distance(shapely.points(points[nearby]), polygon.boundary)
            order = np.lexsort((points[nearby, 1], points[nearby, 0], -distances))
            for local_index in nearby[order]:
                point = points[local_index]
                clearance = float(shapely.distance(shapely.Point(*point), polygon.boundary))
                if clearance < .15:
                    continue
                index = int(indices[local_index])
                witness = {**from_lambert(*point), "elevationM": elevation,
                           "observedElevationM": round(float(z[index]), 3),
                           "clearanceM": round(clearance, 3),
                           "classification": int(classification[index]),
                           "recoveredHorizontal": True,
                           "localPlane": support_details[index]}
                witnesses.append(witness)
                recovered_witnesses.append(witness)
                break
        all_observed = unary_union([old_observed, observed])
        level.update({"polygons": [geographic_polygon(p) for p in parts],
                      "baselineDerivedAreaM2": level["derivedAreaM2"],
                      "additionalHorizontalAreaM2": round(delta.area, 3),
                      "horizontalPointCount": len(points),
                      "horizontalClass1PointCount": int((classification[indices] == 1).sum()),
                      "horizontalRejectedCoreGapAreaM2": round(rejected_gap_area, 3),
                      "derivedAreaM2": round(retained.area, 3),
                      "observedAreaM2": round(retained.intersection(all_observed).area, 3),
                      "inferredAreaM2": round(retained.difference(all_observed).area, 3),
                      "rawObservedAreaM2": round(all_observed.area, 3),
                      "maxCoreGapM": round(max((p.distance(selection_core) for p in parts), default=0), 4),
                      "verificationPoints": witnesses,
                      "recoveredVerificationPoints": recovered_witnesses})
        plots.append((elevation, np.r_[old_points, points], all_observed, parts))
    return levels, plots


def plot_result(path, core, ground, plots, selection_core=None):
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
        if selection_core is not None:
            x, y = selection_core.exterior.xy
            ax.plot(np.asarray(x) - ox, np.asarray(y) - oy, color="#db7e22", lw=1)
        ax.set(xlim=(-25, 25), ylim=(-32, 32), aspect="equal",
               title=f"{elevation:g} m IGN69 · {len(kept)} parties · {sum(p.area for p in kept):.1f} m²")
        ax.tick_params(labelsize=7)
    for ax in list(axes.flat)[len(plots):]:
        ax.set_visible(False)
    fig.suptitle("Arbre Blanc · LiDAR IGN 28/05/2021 · contours visibles dérivés INCOMPLETS\n"
                 "Noir : retours observés ; vert : contours dérivés ; bleu : OSM ; orange : façade documentaire ; gris : emprise municipale", fontsize=12)
    fig.text(.03, .015, "Licence Ouverte 2.0/ODbL. Contours historiques conservés + ajouts par voisinages 3D horizontaux, raster0,5m/ouverture0,125m.\n"
             "Bandes ±0,2m, aucune cote ajoutée ; nouveaux fragments à ≤1,5m du contour applicable. Raccords en bosses documentaires interprétés ; pas les193 balcons.", fontsize=9)
    fig.tight_layout(rect=(0, .05, 1, .94))
    fig.savefig(path, dpi=160)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--points", type=Path, default=Path("/tmp/printmap-arbre-lidar-crop.npz"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--citygml", type=Path)
    parser.add_argument("--osm", type=Path)
    parser.add_argument("--reference", type=Path, default=ROOT / "src/lib/data/arbre-blanc-lidar.json")
    parser.add_argument("--facade-reference", type=Path, default=ROOT / "src/lib/data/arbre-blanc-facade.json")
    parser.add_argument("--no-facade-mask", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "src/lib/data/arbre-blanc-lidar.json")
    parser.add_argument("--plot", type=Path, default=Path("/tmp/printmap-arbre-blanc-lidar-derived.png"))
    args = parser.parse_args()
    core, ground = source_boundaries(args)
    selection_core = core
    facade_reference = None
    if not args.no_facade_mask:
        facade_reference = json.loads(args.facade_reference.read_text())
        boundary = facade_reference["referenceBoundaryLambert93"]
        selection_core = Polygon(boundary["outer"], boundary["holes"])
        if (not selection_core.is_valid or
                selection_core.difference(core).area > 1e-4 or
                selection_core.area < core.area * .85):
            raise ValueError("Documentary facade mask must stay inside the original OSM core")
    if args.download:
        download_crop(args.points)
    with np.load(args.points, allow_pickle=False) as cloud:
        xy = np.c_[cloud["x"], cloud["y"]]
        z, classification = cloud["z"], cloud["classification"]
    if len(xy) > 500000 or xy.shape != (len(z), 2) or len(classification) != len(z) or not np.isfinite(xy).all() or not np.isfinite(z).all():
        raise ValueError("Invalid or excessive source crop")
    levels, plots = derive(xy, z, classification, core, ground, selection_core)
    vertices = sum(len(p["outer"]) + sum(map(len, p["holes"])) for level in levels for p in level["polygons"])
    polygons = sum(len(level["polygons"]) for level in levels)
    if vertices > 8000 or polygons > 256:
        raise ValueError("Derived geometry budget exceeded")
    output = {"version": 1, "source": "IGN LiDAR HD · plateaux visibles dérivés, incomplets",
              "sourceDate": SOURCE_DATE, "sourceUrl": SOURCE_URL,
              "licence": {"name": "Licence Ouverte 2.0 (LiDAR) et ODbL 1.0 (emprises OSM/municipales)", "url": "https://opendatacommons.org/licenses/odbl/1-0/"},
              "crs": "EPSG:4326", "sourceCrs": "EPSG:2154", "verticalDatum": "IGN69", "incomplete": True,
              "coreFootprint": geographic_polygon(core), "groundFootprint": geographic_polygon(ground),
              "selectionCoreFootprint": geographic_polygon(selection_core),
              "selectionCoreInterpreted": facade_reference is not None,
              "referenceBoundariesLambert93": {
                  "core": {"outer": list(core.exterior.coords), "holes": [list(r.coords) for r in core.interiors]},
                  "ground": {"outer": list(ground.exterior.coords), "holes": [list(r.coords) for r in ground.interiors]}},
              "bounds": [min(p["lat"] for p in geographic_polygon(ground)["outer"]), min(p["lon"] for p in geographic_polygon(ground)["outer"]),
                         max(p["lat"] for p in geographic_polygon(ground)["outer"]), max(p["lon"] for p in geographic_polygon(ground)["outer"])],
              "method": {"gridM": GRID_M, "halfBandM": BAND_M, "minimumReturnsPerCell": 2,
                         "wallTraceOpeningRadiusM": .251, "maxClosingM": .5, "closingRadiusM": .25,
                         "maxSimplificationM": SIMPLIFY_M, "maxContourInferenceM": MAX_CONTOUR_INFERENCE_M,
                         "coreConnectionMaxM": MAX_CORE_GAP_M,
                         "coreConnectionBoundRole": "Filtre de distance des nouveaux fragments au contour de sélection applicable ; pas une garantie de longueur des raccords imprimés vers la façade documentaire dans les deux anciennes bosses OSM.",
                         "minimumPartAreaM2": 1,
                         "minimumObservedAreaFraction": .8, "maxVertices": 8000, "maxPolygons": 256,
                         "slabThicknessMeasured": False, "undersidesMeasured": False,
                         "surfaceRoleClassified": False,
                         "additionalMinimumReturnsPerCell": 1,
                         "horizontalOpeningRadiusM": HORIZONTAL_OPENING_M,
                         "horizontalNeighbourhoodRadiusM": NORMAL_RADIUS_M,
                         "horizontalMinimumNeighbours": NORMAL_MIN_POINTS,
                         "horizontalMinimumNormalZ": NORMAL_MIN_Z,
                         "horizontalMaximumPlanarityRatio": NORMAL_MAX_PLANARITY,
                         "horizontalMaximumResidualM": NORMAL_MAX_RESIDUAL_M,
                         "horizontalMinimumSecondVarianceM2": .01,
                         "unclassifiedMinimumBuildingSupport": 3,
                         "preservesLegacyObservations": True,
                         "description": "17 pics de densité verticale inchangés. Contours historiques conservés, complétés uniquement par des retours dont le voisinage 3D NON limité à la bande est horizontal et plan. Pour les ajouts, un seul retour validé par cellule suffit ; ouverture0,125m, fermeture et simplification bornées. Classe1 admise seulement avec au moins3 voisins natifs bâtiment dans le plan. Aucun contour global convexe ni étage ajouté. Le masque documentaire de façade libère deux bosses OSM sans changer la référence OSM brute. Raccords vers le noyau non inclus et non mesurés."},
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
                             "selectionCore": {"source": facade_reference["source"],
                                               "url": facade_reference["sourceUrl"],
                                               "interpreted": True} if facade_reference else {"source": "OSM core unchanged", "interpreted": False},
                             "generator": {"script": "scripts/derive-arbre-blanc-lidar.py", "version": 2,
                                           "numpy": np.__version__, "shapely": shapely.__version__}},
              "levels": levels, "warnings": [
                  "Reconstruction partielle dérivée de retours LiDAR aériens, et non relevé complet des193 balcons.",
                  "Les façades et dessous occultés, les garde-corps et l’épaisseur des dalles ne sont pas mesurés par cette dérivation.",
                  "Les surfaces horizontales visibles peuvent inclure des dessus de terrasses, des brise-soleil ou des pergolas ; leur fonction n’est pas classée dans le nuage.",
                  "Les contours sont inférés sur une grille de 0,5 m ; les observations historiques sont conservées. Les ajouts utilisent une planéité 3D locale, avec ouverture0,125m et fermeture/simplification bornées. Les parties éloignées du noyau restent omises.",
                  "Deux bosses du noyau OSM sont exclues du masque de sélection selon les plans publiés R+9/R+16 ; ce contour est documentaire et interprété, pas un relevé géométrique de façade.",
                  "Les nouveaux fragments sont filtrés à 1,5 m du contour de sélection applicable. Les raccords vers la façade corrigée dans les deux anciennes bosses OSM peuvent être plus longs : ils restent locaux, documentaires et interprétés, comme les épaisseurs minimales ajoutées pour imprimer.",
                  "Le noyau provient du contour OpenStreetMap ; son extrusion est une approximation de façade, pas une maquette architecturale."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")
    plot_result(args.plot, core, ground, plots, selection_core)
    print(json.dumps({"output": str(args.output), "plot": str(args.plot), "levels": len(levels),
                      "nonemptyLevels": sum(bool(level["polygons"]) for level in levels), "polygons": polygons,
                      "vertices": vertices, "areasM2": [level["derivedAreaM2"] for level in levels]}))


if __name__ == "__main__":
    main()
