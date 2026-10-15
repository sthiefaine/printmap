import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import type { OverpassElement } from "@/types/osm";
import { elementPolygons } from "../osm/relation-polygons";
import { pointInPolygon } from "../polygon/point-in-polygon";
import { signedArea } from "../polygon/area";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

export interface OceanTerrainOptions {
  elements: OverpassElement[];
  projectMm: (lon: number, lat: number) => Point2D;
  clip: CrossSection;
  terrainSolid: Manifold;
  surfaceAt: (x: number, y: number) => number;
  /** The caller converts elevation 0 m using the active common datum and scale. */
  seaLevelMm: number;
}

export interface OceanTerrain {
  solid: Manifold;
  section: CrossSection;
  surfaceAt: (x: number, y: number) => number;
  seaLevelMm: number;
  oceanCount: number;
  sourceIds: string[];
  gridVertices: Point2D[];
  gridEdges: [Point2D, Point2D][];
}

function marine(element: OverpassElement) {
  // A natural=bay can also be a bay inside a freshwater lake. Only explicit
  // marine classification is sufficient to replace terrain with sea level.
  return element.tags?.natural === "sea" || element.tags?.water === "ocean";
}

function freshwater(element: OverpassElement) {
  return (
    !marine(element) &&
    (element.tags?.natural === "water" ||
      element.tags?.waterway === "riverbank" ||
      element.tags?.landuse === "reservoir" ||
      element.tags?.landuse === "basin")
  );
}

function onBoundary(point: Point2D, ring: Point2D[]) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      length2 = dx * dx + dy * dy;
    const t = length2
      ? Math.max(
          0,
          Math.min(
            1,
            ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2,
          ),
        )
      : 0;
    if (Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy) <= 1e-8)
      return true;
  }
  return false;
}

/**
 * Replace only the mapped ocean footprint with a closed horizontal sea surface.
 * No footprint dilation, DEM mutation or global altitude renormalization occurs.
 * Mapped islands and overlapping inland water stay on the original terrain.
 */
export function applyOceanTerrain(
  cad: ManifoldToplevel,
  owner: Handles,
  options: OceanTerrainOptions,
): OceanTerrain | null {
  if (!options.elements.some(marine)) return null;
  const source = options.terrainSolid;
  if (
    !Number.isFinite(options.seaLevelMm) ||
    options.clip.isEmpty() ||
    source.isEmpty() ||
    source.status() !== "NoError"
  )
    return null;
  const bounds = source.boundingBox(),
    bottom = bounds.min[2];
  if (options.seaLevelMm <= bottom) return null;
  const ways = new Map(
    options.elements.filter((e) => e.type === "way").map((e) => [e.id, e]),
  );
  const oceans: CrossSection[] = [],
    exclusions: CrossSection[] = [];
  const sourceIds: string[] = [];
  const footprint = owner.keep(source.project());
  const boundsSection = owner.keep(options.clip.intersect(footprint));
  if (boundsSection.isEmpty()) return null;
  const projectRing = (ring: Array<{ lon: number; lat: number }>) =>
    ring.map((p) => options.projectMm(p.lon, p.lat));
  for (const element of options.elements) {
    const isMarine = marine(element);
    if (!isMarine && !freshwater(element)) continue;
    let used = false;
    for (const polygon of elementPolygons(element, ways)) {
      const outer = projectRing(polygon.outer),
        holes = polygon.holes.map(projectRing);
      if (
        [outer, ...holes].some(
          (ring) =>
            ring.length < 3 || ring.some((p) => !p.every(Number.isFinite)),
        )
      )
        continue;
      const section = owner.keep(
        new cad.CrossSection([outer, ...holes], "EvenOdd"),
      );
      if (isMarine) {
        const clipped = owner.keep(section.intersect(boundsSection));
        if (clipped.isEmpty()) continue;
        oceans.push(clipped);
        used = true;
        // An overlapping, less detailed marine polygon must not fill an island
        // explicitly retained by another source contour.
        for (const hole of holes)
          exclusions.push(owner.keep(new cad.CrossSection([hole], "EvenOdd")));
      } else exclusions.push(section);
    }
    if (used) sourceIds.push(`${element.type}/${element.id}`);
  }
  if (!oceans.length) return null;
  let section = owner.keep(cad.CrossSection.union(oceans));
  if (exclusions.length)
    section = owner.keep(
      section.subtract(owner.keep(cad.CrossSection.union(exclusions))),
    );
  if (section.isEmpty()) return null;
  // Both operations share the exact section. Never create overlap by extending
  // the replacement across the shoreline, island or selection boundary.
  const cutter = owner.keep(
    owner
      .keep(
        section.extrude(
          Math.max(bounds.max[2], options.seaLevelMm) - bottom + 1,
        ),
      )
      .translate([0, 0, bottom]),
  );
  const ocean = owner.keep(
    owner
      .keep(section.extrude(options.seaLevelMm - bottom))
      .translate([0, 0, bottom]),
  );
  const solid = owner.keep(owner.keep(source.subtract(cutter)).add(ocean));
  if (solid.status() !== "NoError" || solid.isEmpty())
    throw new Error("La surface marine ne peut pas être raccordée au terrain.");
  const rings = section.toPolygons();
  const contains = (x: number, y: number) => {
    let inside = false;
    for (const ring of rings) {
      if (onBoundary([x, y], ring)) return signedArea(ring) > 0;
      if (pointInPolygon(x, y, ring)) inside = !inside;
    }
    return inside;
  };
  const gridVertices: Point2D[] = [],
    gridEdges: [Point2D, Point2D][] = [];
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      gridVertices.push(ring[i]);
      gridEdges.push([ring[i], ring[(i + 1) % ring.length]]);
    }
  return {
    solid,
    section,
    seaLevelMm: options.seaLevelMm,
    surfaceAt: (x, y) =>
      contains(x, y) ? options.seaLevelMm : options.surfaceAt(x, y),
    oceanCount: sourceIds.length,
    sourceIds,
    gridVertices,
    gridEdges,
  };
}
