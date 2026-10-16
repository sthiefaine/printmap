import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { Point2D } from "@/types/geometry";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

export interface BeamBridgeOptions {
  /** The physical mapped deck outline, including any holes, in millimetres. */
  footprint: CrossSection;
  clip: CrossSection;
  /** Ordered samples on the carried route, in the same vertical datum as terrain. */
  profile: readonly { point: Point2D; z: number }[];
  thicknessMm: number;
  terrainSolid: Manifold;
  terrainMaxZ: number;
}

export interface BeamBridge {
  solid: Manifold;
  footprint: CrossSection;
  /** Terrain above a documented deck must not conceal it. No underpass is carved. */
  aboveDeck: Manifold;
  deckAt(x: number, y: number): number;
  inferredThicknessMm: number;
}

/**
 * A beam classification justifies a deck, not the location or shape of its piers.
 * Keep the mapped outline and interpolate the supplied top profile. The
 * underside is an explicitly inferred printable thickness, with no new arch,
 * column, river-floor correction or artificial support down to the socle.
 */
export function makeBeamBridge(
  cad: ManifoldToplevel,
  owner: Handles,
  options: BeamBridgeOptions,
): BeamBridge | null {
  const a = options.profile[0],
    b = options.profile.at(-1);
  if (!a || !b || options.profile.length < 2) return null;
  const dx = b.point[0] - a.point[0],
    dy = b.point[1] - a.point[1];
  const length2 = dx * dx + dy * dy;
  if (
    ![
      ...options.profile.flatMap((p) => [...p.point, p.z]),
      options.thicknessMm,
      options.terrainMaxZ,
    ].every(Number.isFinite) ||
    length2 < 0.000001 ||
    options.thicknessMm <= 0 ||
    Math.min(a.z, b.z) <= options.thicknessMm ||
    options.footprint.isEmpty()
  )
    return null;
  const temporary: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(handle: T): T => {
    temporary.push(handle);
    return handle;
  };
  const outputs = new Set<{ delete(): void }>();
  try {
    const footprint = keep(options.footprint.intersect(options.clip));
    if (footprint.isEmpty()) return null;
    const length = Math.sqrt(length2);
    const direction: Point2D = [dx / length, dy / length];
    const station = (point: Point2D) =>
      (point[0] - a.point[0]) * direction[0] +
      (point[1] - a.point[1]) * direction[1];
    const samples = options.profile.map((p) => ({
      s: station(p.point),
      z: p.z,
    }));
    if (samples.some((p, i) => i > 0 && p.s <= samples[i - 1].s + 0.00001))
      return null;
    const deckAt = (x: number, y: number) => {
      const s = station([x, y]);
      let i = samples.findIndex((p, index) => index > 0 && p.s >= s) - 1;
      if (i < 0) i = s <= samples[0].s ? 0 : samples.length - 2;
      const p = samples[i],
        q = samples[i + 1];
      return p.z + ((s - p.s) / (q.s - p.s)) * (q.z - p.z);
    };
    const points = footprint.toPolygons().flat();
    const stations = points.map(station);
    const min = Math.min(...stations),
      max = Math.max(...stations);
    const bounds = footprint.bounds();
    const across =
      Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) +
      1;
    const slabs: Manifold[] = [],
      cutters: Manifold[] = [];
    const height = Math.max(
      1,
      options.terrainMaxZ +
        Math.max(...samples.map((p) => p.z)) -
        Math.min(...samples.map((p) => p.z)) +
        1,
    );
    for (let i = 0; i < samples.length - 1; i++) {
      const p = samples[i],
        q = samples[i + 1];
      const from = i === 0 ? min - 1 : p.s;
      const to = i === samples.length - 2 ? max + 1 : q.s;
      if (to <= min || from >= max) continue;
      const local = (s: number, t: number): Point2D => [
        a.point[0] + s * direction[0] - t * direction[1],
        a.point[1] + s * direction[1] + t * direction[0],
      ];
      const strip = keep(
        new cad.CrossSection([
          [
            local(from, -across),
            local(to, -across),
            local(to, across),
            local(from, across),
          ],
        ]),
      );
      const part = keep(footprint.intersect(strip));
      if (part.isEmpty()) continue;
      const z = (x: number, y: number) =>
        p.z + ((station([x, y]) - p.s) / (q.s - p.s)) * (q.z - p.z);
      slabs.push(
        keep(
          keep(part.extrude(options.thicknessMm)).warp((vertex) => {
            vertex[2] += z(vertex[0], vertex[1]) - options.thicknessMm;
          }),
        ),
      );
      cutters.push(
        keep(
          keep(part.extrude(height)).warp((vertex) => {
            vertex[2] += z(vertex[0], vertex[1]);
          }),
        ),
      );
    }
    if (!slabs.length) return null;
    const solid = keep(cad.Manifold.union(slabs));
    if (solid.isEmpty() || solid.status() !== "NoError") return null;
    // Real banks must support this selection; an isolated mid-span cell is not
    // given a fictitious pier. No river bed or lower path is moved by this helper.
    const components = solid.decompose().map(keep);
    for (const component of components) {
      const contact = keep(component.intersect(options.terrainSolid));
      if (contact.isEmpty() || contact.volume() <= 1e-8) return null;
    }
    const aboveDeck = keep(cad.Manifold.union(cutters));
    for (const handle of [solid, footprint, aboveDeck]) {
      outputs.add(handle);
      owner.keep(handle);
    }
    return {
      solid,
      footprint,
      aboveDeck,
      deckAt,
      inferredThicknessMm: options.thicknessMm,
    };
  } catch {
    return null;
  } finally {
    for (let i = temporary.length - 1; i >= 0; i--)
      if (!outputs.has(temporary[i])) temporary[i].delete();
  }
}
