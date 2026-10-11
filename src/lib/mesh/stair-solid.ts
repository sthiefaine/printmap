import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import type { RoadData } from "../osm/parse-elements";
import { parseLengthMeters } from "../osm/building-height";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

export interface StairOptions {
  scaleFactor: number;
  halfWidth: number;
  minTreadMm: number;
  minRiserMm?: number;
  foundationZ: number;
  terrainMaxZ: number;
  surfaceAt: (x: number, y: number) => number;
  hasElevation: boolean;
  clip: CrossSection;
}

export interface StairFlight {
  solid: Manifold;
  /** Replace the existing terrain above the common foundation with the stairs. */
  cutter: Manifold;
  footprint: CrossSection;
  sourceSteps: number;
  printedSteps: number;
  estimatedRise: boolean;
  estimatedCount: boolean;
  grouped: boolean;
  riseMm: number;
}

function positiveCount(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const count = Number(value);
  return count > 0 && count <= 10000 ? count : null;
}

function numericIncline(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^([+-]?\d+(?:[.,]\d+)?)\s*(%|°|deg)?$/.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1].replace(",", "."));
  const slope =
    match[2] === "°" || match[2] === "deg"
      ? Math.tan((number * Math.PI) / 180)
      : number / 100;
  return Number.isFinite(slope) && Math.abs(slope) <= 4 ? slope : null;
}

/**
 * Horizontal treads follow the mapped stair route. Fine source steps are grouped
 * at the chosen print resolution; no isolated decorative ribs are added.
 */
export function makeStairFlight(
  cad: ManifoldToplevel,
  owner: Handles,
  road: RoadData,
  options: StairOptions,
): StairFlight | null {
  if (road.roadType !== "steps") return null;
  const { scaleFactor, halfWidth, foundationZ, surfaceAt, clip } = options;
  if (
    ![scaleFactor, halfWidth, foundationZ].every(Number.isFinite) ||
    scaleFactor <= 0 ||
    halfWidth <= 0
  )
    return null;
  const points = road.polyline.filter(
    (point, index, all) =>
      point.every(Number.isFinite) &&
      (index === 0 ||
        Math.hypot(point[0] - all[index - 1][0], point[1] - all[index - 1][1]) >
          0.00001),
  );
  if (points.length < 2) return null;
  const distances = [0];
  for (let i = 1; i < points.length; i++)
    distances.push(
      distances.at(-1)! +
        Math.hypot(
          points[i][0] - points[i - 1][0],
          points[i][1] - points[i - 1][1],
        ),
    );
  const length = distances.at(-1)!;
  if (length < 0.05) return null;
  const tags = road.tags;
  const taggedCount = positiveCount(tags.step_count ?? tags.steps);
  const tread = parseLengthMeters(tags["step:length"]);
  const sourceSteps =
    taggedCount ??
    Math.max(
      1,
      Math.min(10000, Math.round(length / (scaleFactor * (tread ?? 0.28)))),
    );
  const first = points[0],
    last = points.at(-1)!;
  const startSurface = surfaceAt(...first),
    endSurface = surfaceAt(...last);
  if (![startSurface, endSurface].every(Number.isFinite)) return null;
  const terrainRise = endSurface - startSurface;
  const slope = numericIncline(tags.incline);
  const inclination = tags.incline?.trim().toLowerCase();
  const direction =
    inclination === "down"
      ? -1
      : inclination === "up"
        ? 1
        : slope != null && slope !== 0
          ? Math.sign(slope)
          : terrainRise !== 0 && options.hasElevation
            ? Math.sign(terrainRise)
            : 1;
  const stepHeight = parseLengthMeters(tags["step:height"]);
  // A mapped direction/count does not supply altitude. In explicit flat mode,
  // raising a conventional flight would invent a terrace with no landing.
  if (
    !options.hasElevation &&
    !(stepHeight != null && stepHeight > 0) &&
    !(slope != null && slope !== 0)
  )
    return null;
  let rise: number;
  if (stepHeight != null && stepHeight > 0)
    rise = sourceSteps * stepHeight * scaleFactor * direction;
  else if (slope != null && slope !== 0)
    rise = length * Math.abs(slope) * direction;
  else if (options.hasElevation && Math.abs(terrainRise) > 0.02) {
    // Both measured landings must coincide with the terrain. A contradictory
    // coarse DEM cannot justify moving the upper landing away from its ground.
    if (Math.sign(terrainRise) !== direction) return null;
    rise = terrainRise;
  } else return null;
  if (!Number.isFinite(rise) || Math.abs(rise) <= 0 || Math.abs(rise) > 200)
    return null;
  const minRiser = Math.max(0.02, options.minRiserMm ?? 0.12);
  const minTread = Math.max(0.05, options.minTreadMm);
  if (Math.abs(rise) < minRiser || length < minTread) return null;
  const printedSteps = Math.max(
    1,
    Math.min(
      sourceSteps,
      512,
      Math.floor(length / minTread),
      Math.floor(Math.abs(rise) / minRiser),
    ),
  );
  // Match both DEM landings; explicit vertical measurements take priority when
  // provided and remain anchored on the lower landing's local ground.
  const lowerSurface = direction > 0 ? startSurface : endSurface;
  const startZ = direction > 0 ? lowerSurface : lowerSurface + Math.abs(rise);
  const temporary: { delete(): void }[] = [];
  const arena: Handles = {
    keep(handle) {
      temporary.push(handle);
      return handle;
    },
  };
  const outputs = new Set<{ delete(): void }>();
  try {
    const normal = (segment: number): Point2D => {
      const [a, b] = [points[segment], points[segment + 1]];
      const distance = distances[segment + 1] - distances[segment];
      return [-(b[1] - a[1]) / distance, (b[0] - a[0]) / distance];
    };
    const station = (distance: number): { left: Point2D; right: Point2D } => {
      let segment = 0;
      while (
        segment + 1 < points.length - 1 &&
        distance > distances[segment + 1] + 0.000001
      )
        segment++;
      const alpha =
        (distance - distances[segment]) /
        (distances[segment + 1] - distances[segment]);
      const center: Point2D = [
        points[segment][0] +
          alpha * (points[segment + 1][0] - points[segment][0]),
        points[segment][1] +
          alpha * (points[segment + 1][1] - points[segment][1]),
      ];
      let offset = normal(segment),
        width = halfWidth;
      const vertex = distances.findIndex(
        (at, i) =>
          i > 0 && i < points.length - 1 && Math.abs(at - distance) < 0.000001,
      );
      if (vertex >= 0) {
        const before = normal(vertex - 1),
          after = normal(vertex);
        const sum: Point2D = [before[0] + after[0], before[1] + after[1]];
        const norm = Math.hypot(...sum);
        if (norm > 0.00001) {
          offset = [sum[0] / norm, sum[1] / norm];
          width = Math.min(
            halfWidth * 3,
            halfWidth /
              Math.max(0.05, offset[0] * after[0] + offset[1] * after[1]),
          );
        }
      }
      return {
        left: [center[0] + offset[0] * width, center[1] + offset[1] * width],
        right: [center[0] - offset[0] * width, center[1] - offset[1] * width],
      };
    };
    const sections: CrossSection[] = [],
      solids: Manifold[] = [];
    let maximumZ = options.terrainMaxZ;
    for (let i = 0; i < printedSteps; i++) {
      const from = (i / printedSteps) * length,
        to = ((i + 1) / printedSteps) * length;
      const stations = [
        from,
        ...distances.filter((at) => at > from + 0.000001 && at < to - 0.000001),
        to,
      ].map(station);
      const ring = [
        ...stations.map((at) => at.left),
        ...stations.map((at) => at.right).reverse(),
      ];
      const section = arena.keep(
        arena.keep(new cad.CrossSection([ring], "NonZero")).intersect(clip),
      );
      if (section.isEmpty()) continue;
      const topZ =
        startZ +
        rise * (direction > 0 ? (i + 1) / printedSteps : i / printedSteps);
      if (topZ <= foundationZ + 0.01) return null;
      maximumZ = Math.max(maximumZ, topZ);
      sections.push(section);
      solids.push(
        arena.keep(
          arena
            .keep(section.extrude(topZ - foundationZ))
            .translate([0, 0, foundationZ]),
        ),
      );
    }
    if (!solids.length) return null;
    const solid = arena.keep(cad.Manifold.union(solids));
    if (solid.status() !== "NoError" || solid.isEmpty()) return null;
    const footprint = arena.keep(cad.CrossSection.union(sections));
    // Clear the existing ramp five microns beyond the replacement staircase.
    // Coincident source/stair side walls otherwise leave a zero-thickness film
    // after Float32 export; the treads and measured landings stay unchanged.
    const cutter = arena.keep(
      arena
        .keep(
          arena
            .keep(footprint.offset(0.005, "Miter"))
            .extrude(maximumZ - foundationZ + 1),
        )
        .translate([0, 0, foundationZ]),
    );
    for (const handle of [solid, footprint, cutter]) {
      outputs.add(handle);
      owner.keep(handle);
    }
    return {
      solid,
      footprint,
      cutter,
      sourceSteps,
      printedSteps,
      estimatedRise: false,
      estimatedCount: taggedCount == null,
      grouped: printedSteps < sourceSteps,
      riseMm: Math.abs(rise),
    };
  } catch {
    return null;
  } finally {
    for (let i = temporary.length - 1; i >= 0; i--)
      if (!outputs.has(temporary[i])) temporary[i].delete();
  }
}
