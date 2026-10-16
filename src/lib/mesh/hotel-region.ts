import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import type { RoofSurface } from "@/types/osm";
import reference from "../data/hotel-region-facade.json";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}
export interface HotelRegionFacadeOptions {
  sourceId: string | undefined;
  osmId?: string;
  surfaces: RoofSurface[];
  groundElevation: number;
  project: (lon: number, lat: number) => Point2D;
  scaleFactor: number;
  buildingScale: number;
  /** The printed altitude corresponding to the source's absolute ground. */
  surfaceZ: number;
  minFeatureMm: number;
  clip: CrossSection;
}
export interface HotelRegionFacade {
  solid: Manifold;
  recessCount: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  minimumCentralWallMm: number;
  bottomZMm: number;
  topZMm: number;
  /** Window-width direction; the two recesses face its perpendicular. */
  axis: Point2D;
  center: Point2D;
  adaptedForPrinting: boolean;
  interpreted: true;
  sources: string[];
  warnings: string[];
}

export function isHotelRegion(sourceId: string | undefined, osmId?: string) {
  return (
    (sourceId === reference.sourceId || sourceId === reference.osmId) &&
    (osmId === undefined || osmId === reference.osmId)
  );
}

/**
 * Documentary relief of two CLOSED glass facades. The 21 × 8 m dimensions are
 * published; their bottom level and recess depth are explicitly interpreted.
 * This only subtracts two shallow boxes, leaving a thick central glass wall,
 * the ground footprint and every source roof plane unchanged.
 */
export function applyHotelRegionFacade(
  cad: ManifoldToplevel,
  owner: Handles,
  source: Manifold,
  options: HotelRegionFacadeOptions,
): HotelRegionFacade | null {
  const { surfaces, scaleFactor: sf, buildingScale, surfaceZ } = options;
  if (
    !isHotelRegion(options.sourceId, options.osmId) ||
    !Array.isArray(surfaces) ||
    !surfaces.length ||
    surfaces.length > 5000 ||
    ![
      sf,
      buildingScale,
      surfaceZ,
      options.groundElevation,
      options.minFeatureMm,
    ].every(Number.isFinite) ||
    sf <= 0 ||
    buildingScale <= 0 ||
    options.minFeatureMm <= 0 ||
    source.isEmpty() ||
    source.status() !== "NoError"
  )
    return null;
  const points = surfaces.flatMap((surface) => surface.outer);
  if (
    points.length < 3 ||
    points.length > 200000 ||
    points.some((p) => ![p.lat, p.lon, p.elevation].every(Number.isFinite))
  )
    return null;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  let minimumRoofElevation = Infinity;
  for (const point of points) {
    bounds[0] = Math.min(bounds[0], point.lat);
    bounds[1] = Math.min(bounds[1], point.lon);
    bounds[2] = Math.max(bounds[2], point.lat);
    bounds[3] = Math.max(bounds[3], point.lon);
    minimumRoofElevation = Math.min(minimumRoofElevation, point.elevation);
  }
  // Identity plus a few metres of source revision; an unrelated/relocated cache
  // must never acquire this building-specific interpreted facade.
  if (bounds.some((value, i) => Math.abs(value - reference.bounds[i]) > 0.00003))
    return null;
  let axis: Point2D = [0, 0],
    longest = 0;
  for (const surface of surfaces)
    for (let i = 1; i < surface.outer.length; i++) {
      const a = options.project(surface.outer[i - 1].lon, surface.outer[i - 1].lat);
      const b = options.project(surface.outer[i].lon, surface.outer[i].lat);
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length > longest) {
        longest = length;
        axis = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
      }
    }
  if (longest < 15 || longest > 60) return null;
  if (axis[1] < 0) axis = [-axis[0], -axis[1]];
  const normal: Point2D = [-axis[1], axis[0]];
  const local = (point: Point2D): Point2D => [
    point[0] * axis[0] + point[1] * axis[1],
    point[0] * normal[0] + point[1] * normal[1],
  ];
  const world = (u: number, v: number): Point2D => [
    u * axis[0] + v * normal[0],
    u * axis[1] + v * normal[1],
  ];
  let minimumU = Infinity,
    maximumU = -Infinity;
  for (const point of points) {
    const p = options.project(point.lon, point.lat);
    if (!p.every(Number.isFinite)) return null;
    const [u] = local([p[0] * sf, p[1] * sf]);
    minimumU = Math.min(minimumU, u);
    maximumU = Math.max(maximumU, u);
  }
  const centerU = (minimumU + maximumU) / 2;
  const widthMm = reference.documented.glazingWidthM * sf;
  const heightMm = reference.documented.glazingHeightM * sf * buildingScale;
  // Never widen the real documented opening to satisfy a printer setting.
  if (widthMm < 0.4 || heightMm < 0.4) return null;
  const bottomZMm =
    surfaceZ + reference.interpreted.bottomAboveGroundM * sf * buildingScale;
  const topZMm = bottomZMm + heightMm;
  const lowestRoofZ =
    surfaceZ +
    (minimumRoofElevation - options.groundElevation) *
      sf *
      buildingScale;
  if (topZMm > lowestRoofZ - 0.2) return null;

  const handles: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(handle: T): T => {
    handles.push(handle);
    return handle;
  };
  const outputs = new Set<{ delete(): void }>();
  try {
    const section = keep(source.slice((bottomZMm + topZMm) / 2));
    if (section.isEmpty()) return null;
    const rings = section.toPolygons().map((ring) => ring.map(local));
    const extrema = (u: number) => {
      const hits: number[] = [];
      for (const ring of rings)
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i],
            b = ring[(i + 1) % ring.length];
          if ((a[0] <= u && b[0] > u) || (b[0] <= u && a[0] > u))
            hits.push(a[1] + ((u - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
        }
      // A pre-existing hollow/multiple volume is not interpreted as two solid
      // pillars. Leave its real geometry untouched instead of filling any void.
      if (hits.length !== 2) return null;
      return [Math.min(...hits), Math.max(...hits)];
    };
    const ranges = [-0.5, 0, 0.5].map((fraction) =>
      extrema(centerU + fraction * widthMm),
    );
    if (ranges.some((range) => !range)) return null;
    const valid = ranges as number[][];
    const front = Math.max(...valid.map((range) => range[0]));
    const back = Math.min(...valid.map((range) => range[1]));
    const minimumCentralWallMm = Math.max(
      reference.printing.minimumCentralWallMm,
      options.minFeatureMm,
    );
    const inferredDepth = reference.interpreted.recessDepthM * sf;
    const depthMm = Math.min(
      reference.printing.maximumReliefDepthMm,
      Math.max(reference.printing.minimumReliefDepthMm, inferredDepth),
    );
    if (back - front - 2 * depthMm < minimumCentralWallMm) return null;
    // Facades must be approximately planar over the documented bay width.
    // Only their existing exterior face is recessed, not an arbitrary XY slab.
    if (
      Math.max(...valid.map((range) => range[0])) -
        Math.min(...valid.map((range) => range[0])) >
        0.01 ||
      Math.max(...valid.map((range) => range[1])) -
        Math.min(...valid.map((range) => range[1])) >
        0.01
    )
      return null;
    const parts: Manifold[] = [];
    for (const [from, to] of [
      [front - 1, front + depthMm],
      [back - depthMm, back + 1],
    ]) {
      const outline = keep(
        new cad.CrossSection([
          [
            world(centerU - widthMm / 2, from),
            world(centerU + widthMm / 2, from),
            world(centerU + widthMm / 2, to),
            world(centerU - widthMm / 2, to),
          ],
        ]),
      );
      const clipped = keep(outline.intersect(options.clip));
      if (clipped.isEmpty()) continue;
      const cutter = keep(
        keep(clipped.extrude(heightMm)).translate([0, 0, bottomZMm]),
      );
      const overlap = keep(source.intersect(cutter));
      if (!overlap.isEmpty() && overlap.volume() > 0.000001) parts.push(cutter);
    }
    if (!parts.length) return null;
    const cutters = keep(cad.Manifold.union(parts));
    const removed = keep(source.intersect(cutters));
    const result = keep(source.subtract(cutters));
    if (result.isEmpty() || result.status() !== "NoError") return null;
    const sourceVolume = source.volume();
    const removedVolume = sourceVolume - result.volume();
    if (
      removedVolume <= 0 ||
      Math.abs(removedVolume - removed.volume()) >
        Math.max(1e-6, sourceVolume * 1e-7) ||
      removedVolume > parts.length * widthMm * heightMm * (depthMm + 0.011)
    )
      return null;
    const before = source.decompose().map(keep);
    const after = result.decompose().map(keep);
    const positive = (items: Manifold[]) => items.filter((p) => p.volume() > 1e-6);
    if (positive(after).length !== positive(before).length) return null;
    const roofPlane = lowestRoofZ - 0.1;
    const upperBefore = keep(source.trimByPlane([0, 0, 1], roofPlane));
    const upperAfter = keep(result.trimByPlane([0, 0, 1], roofPlane));
    if (Math.abs(upperBefore.volume() - upperAfter.volume()) > 1e-7) return null;
    outputs.add(result);
    owner.keep(result);
    return {
      solid: result,
      recessCount: parts.length,
      widthMm,
      heightMm,
      depthMm,
      minimumCentralWallMm,
      bottomZMm,
      topZMm,
      axis,
      center: world(centerU, (front + back) / 2),
      adaptedForPrinting: Math.abs(depthMm - inferredDepth) > 1e-9,
      interpreted: true,
      sources: [
        `${reference.documented.reference} · ${reference.documented.url}`,
      ],
      warnings: [
        ...reference.limits,
        `Verrières : ${reference.documented.glazingHeightM} × ${reference.documented.glazingWidthM} m documentés ; niveau bas estimé à ${reference.interpreted.bottomAboveGroundM} m au-dessus du sol, retrait imprimé ${depthMm.toFixed(2)} mm. Mur central fermé ≥ ${minimumCentralWallMm.toFixed(2)} mm conservé.`,
      ],
    };
  } catch {
    return null;
  } finally {
    for (let i = handles.length - 1; i >= 0; i--)
      if (!outputs.has(handles[i])) handles[i].delete();
  }
}
