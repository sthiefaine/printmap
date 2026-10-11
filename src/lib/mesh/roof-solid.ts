import type { Manifold, ManifoldToplevel, Vec3 } from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import type { RoofShape } from "../constants";
import type { BuildingData } from "../osm/parse-elements";
import { roofRidgeAxis, roofDirection } from "../osm/building-height";
import { orientedFootprintBounds } from "../polygon/footprint-classify";
import { signedArea } from "../polygon/area";
import type { CrossSection } from "manifold-3d";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

export interface MeasuredRoofSurface {
  outer: { lat: number; lon: number; elevation: number }[];
  holes: { lat: number; lon: number; elevation: number }[][];
}

/** Measured roof polygons become solids with full foundations, not decorative faces. */
export function makeMeasuredRoof(
  cad: ManifoldToplevel,
  owner: Handles,
  surfaces: MeasuredRoofSurface[],
  groundElevation: number,
  project: (lon: number, lat: number) => [number, number],
  scaleFactor: number,
  buildingScale: number,
  surfaceZ: number,
  foundationZ: number,
  footprint: CrossSection,
  minimumHeight: number,
): Manifold | null {
  if (
    !Array.isArray(surfaces) ||
    !surfaces.length ||
    surfaces.length > 5000 ||
    !Number.isFinite(groundElevation)
  )
    return null;
  let maximumElevation = -Infinity,
    vertexCount = 0;
  for (const surface of surfaces) {
    if (
      !surface ||
      !Array.isArray(surface.outer) ||
      !Array.isArray(surface.holes) ||
      surface.holes.some((ring) => !Array.isArray(ring))
    )
      return null;
    for (const ring of [surface.outer, ...surface.holes])
      for (const point of ring) {
        if (!point || !Number.isFinite(point.elevation)) return null;
        maximumElevation = Math.max(maximumElevation, point.elevation);
        if (++vertexCount > 200000) return null;
      }
  }
  const maximumRelative = maximumElevation - groundElevation;
  if (
    !Number.isFinite(maximumRelative) ||
    maximumRelative <= 0 ||
    maximumRelative > 1000
  )
    return null;
  const factor =
    scaleFactor *
    buildingScale *
    Math.max(
      1,
      minimumHeight / (maximumRelative * scaleFactor * buildingScale),
    );
  if (!Number.isFinite(factor) || factor <= 0) return null;
  const temporary: { delete(): void }[] = [];
  const arena: Handles = {
    keep<T extends { delete(): void }>(handle: T): T {
      temporary.push(handle);
      return handle;
    },
  };
  let output: Manifold | null = null;
  try {
    const solids: Manifold[] = [],
      coverages: CrossSection[] = [];
    for (const surface of surfaces) {
      const rings: Vec3[][] = [];
      for (const [ringIndex, rawRing] of [
        surface.outer,
        ...surface.holes,
      ].entries()) {
        const ring: Vec3[] = [];
        for (const raw of rawRing) {
          if (![raw.lat, raw.lon, raw.elevation].every(Number.isFinite))
            return null;
          const [x, y] = project(raw.lon, raw.lat);
          const z = surfaceZ + (raw.elevation - groundElevation) * factor;
          const previous = ring.at(-1);
          if (
            !previous ||
            Math.hypot(
              x * scaleFactor - previous[0],
              y * scaleFactor - previous[1],
            ) > 0.00001
          )
            ring.push([x * scaleFactor, y * scaleFactor, z]);
        }
        if (
          ring.length > 2 &&
          Math.hypot(
            ring[0][0] - ring.at(-1)![0],
            ring[0][1] - ring.at(-1)![1],
          ) < 0.00001
        )
          ring.pop();
        if (
          ring.length < 3 ||
          Math.abs(signedArea(ring.map(([x, y]) => [x, y]))) < 0.00001
        ) {
          if (ringIndex === 0) {
            rings.length = 0;
            break;
          }
          continue;
        }
        if (signedArea(ring.map(([x, y]) => [x, y])) > 0 !== (ringIndex === 0))
          ring.reverse();
        rings.push(ring);
      }
      if (!rings.length) continue;
      if (rings.flat().some((point) => point[2] <= foundationZ)) return null;
      const polygons = rings.map((ring) =>
        ring.map(([x, y]) => [x, y] as Point2D),
      );
      const top = rings.flat(),
        count = top.length;
      const vertices = new Float32Array(count * 6);
      top.forEach((point, i) => {
        vertices.set(point, i * 3);
        vertices.set([point[0], point[1], foundationZ], (i + count) * 3);
      });
      const triangles: number[] = [];
      for (const [a, b, c] of cad.triangulate(polygons, 0.000001, false))
        triangles.push(a, b, c, a + count, c + count, b + count);
      let offset = 0;
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const a = offset + i,
            b = offset + ((i + 1) % ring.length);
          triangles.push(a, a + count, b, b, a + count, b + count);
        }
        offset += ring.length;
      }
      const solid = arena.keep(
        new cad.Manifold(
          new cad.Mesh({
            numProp: 3,
            vertProperties: vertices,
            triVerts: new Uint32Array(triangles),
          }),
        ),
      );
      if (solid.status() !== "NoError" || solid.isEmpty()) return null;
      solids.push(solid);
      coverages.push(arena.keep(new cad.CrossSection(polygons, "NonZero")));
    }
    if (!solids.length) return null;
    const coverage = arena.keep(cad.CrossSection.union(coverages));
    const missing = arena.keep(footprint.subtract(coverage));
    // Minor survey/OSM edge disagreement can be clipped, but missing roof panels
    // must not silently create a partly empty building.
    if (missing.area() > Math.max(0.02, footprint.area() * 0.02)) return null;
    const union = arena.keep(cad.Manifold.union(solids));
    const maxZ = surfaceZ + maximumRelative * factor;
    const clip = arena.keep(
      arena
        .keep(footprint.extrude(maxZ - foundationZ + 1))
        .translate([0, 0, foundationZ]),
    );
    const clipped = arena.keep(union.intersect(clip));
    if (clipped.status() === "NoError" && !clipped.isEmpty()) {
      // Coplanar survey panels can leave a zero-volume shell. Remove it before
      // Float32 stabilization, where rounding could give it a spurious volume.
      const components = clipped
        .decompose()
        .map((component) => arena.keep(component));
      const printable = components.filter(
        (component) => component.volume() > 0.000001,
      );
      if (
        printable.length &&
        printable.every(
          (component) => component.boundingBox().min[2] <= foundationZ + 0.0001,
        )
      )
        output = owner.keep(arena.keep(cad.Manifold.union(printable)));
    }
    return output;
  } catch {
    // Invalid survey polygons should produce an explicit fallback for that
    // building, rather than fail the complete selected neighbourhood.
    return null;
  } finally {
    for (let i = temporary.length - 1; i >= 0; i--)
      if (temporary[i] !== output) temporary[i].delete();
  }
}

/**
 * Closed parametric roof envelope, later intersected with the exact footprint.
 * Courtyards and concavities therefore remain open; they never become hull fill.
 * OSM shape tags describe a family, while untagged ridge/break positions are
 * geometric approximations. They are reported separately by the model builder.
 */
export function makeRoof(
  cad: ManifoldToplevel,
  arena: Handles,
  building: BuildingData,
  polygons: Point2D[][],
  baseZ: number,
  height: number,
  shape: RoofShape,
): Manifold {
  const axis = roofRidgeAxis(building.tags, building.classification);
  // For a single pitch the across-axis must point downhill, including its sign.
  const perpendicular: Point2D =
    shape === "skillion"
      ? (roofDirection(building.tags) ?? [-axis[1], axis[0]])
      : [-axis[1], axis[0]];
  const points2d = polygons.flat();
  const bounds = orientedFootprintBounds(points2d, axis);
  // The signed skillion perpendicular can oppose the bounds helper's axis.
  let minB = Infinity,
    maxB = -Infinity;
  for (const [x, y] of points2d) {
    const b = x * perpendicular[0] + y * perpendicular[1];
    minB = Math.min(minB, b);
    maxB = Math.max(maxB, b);
  }
  const centerA = (bounds.minAlong + bounds.maxAlong) / 2;
  const centerB = (minB + maxB) / 2;
  const halfA = (bounds.maxAlong - bounds.minAlong) / 2;
  const halfB = (maxB - minB) / 2;
  const point = (a: number, b: number, z: number): Vec3 => [
    (centerA + a) * axis[0] + (centerB + b) * perpendicular[0],
    (centerA + a) * axis[1] + (centerB + b) * perpendicular[1],
    baseZ + z,
  ];
  const corners = (a: number, b: number, z: number): Vec3[] => [
    point(-a, -b, z),
    point(a, -b, z),
    point(a, b, z),
    point(-a, b, z),
  ];
  const lower = corners(halfA, halfB, -0.02);

  if (shape === "dome" || shape === "cone" || shape === "onion") {
    // A faceted ellipse of revolution models tagged curved roofs rather than
    // replacing them with a pyramid. No arbitrary curves are added to flat roofs.
    const profile: [number, number][] =
      shape === "cone"
        ? [
            [1, 0],
            [0, 1],
          ]
        : shape === "onion"
          ? [
              [1, 0],
              [1.1, 0.18],
              [1.13, 0.32],
              [0.95, 0.52],
              [0.58, 0.72],
              [0.24, 0.87],
              [0, 1],
            ]
          : Array.from(
              { length: 9 },
              (_, i) =>
                [
                  Math.cos((i * Math.PI) / 16),
                  Math.sin((i * Math.PI) / 16),
                ] as [number, number],
            );
    const segments = 32;
    const vertices: number[] = [],
      triangles: number[] = [];
    const rings = [
      [1, -0.02 / height] as [number, number],
      ...profile.filter(([radius]) => radius > 0.000001),
    ];
    for (const [radius, z] of rings)
      for (let i = 0; i < segments; i++) {
        const theta = (i * Math.PI * 2) / segments;
        vertices.push(
          ...point(
            halfA * radius * Math.cos(theta),
            halfB * radius * Math.sin(theta),
            z * height,
          ),
        );
      }
    for (let ring = 0; ring + 1 < rings.length; ring++)
      for (let i = 0; i < segments; i++) {
        const a = ring * segments + i,
          b = ring * segments + ((i + 1) % segments);
        triangles.push(a, b, a + segments, b, b + segments, a + segments);
      }
    const bottom = vertices.length / 3;
    vertices.push(...point(0, 0, -0.02));
    const peak = vertices.length / 3;
    vertices.push(...point(0, 0, height));
    const last = (rings.length - 1) * segments;
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      triangles.push(bottom, next, i, last + i, last + next, peak);
    }
    return arena.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: new Float32Array(vertices),
          triVerts: new Uint32Array(triangles),
        }),
      ),
    );
  }

  const points: Vec3[] = [...lower, ...corners(halfA, halfB, 0)];
  if (shape === "skillion") {
    points.push(point(-halfA, -halfB, height), point(halfA, -halfB, height));
  } else if (shape === "round" || shape === "gambrel" || shape === "saltbox") {
    const profile: [number, number][] =
      shape === "round"
        ? Array.from(
            { length: 17 },
            (_, i) =>
              [-Math.cos((i * Math.PI) / 16), Math.sin((i * Math.PI) / 16)] as [
                number,
                number,
              ],
          )
        : shape === "gambrel"
          ? [
              [-1, 0],
              [-0.6, 0.65],
              [0, 1],
              [0.6, 0.65],
              [1, 0],
            ]
          : [
              [-1, 0],
              [0.25, 1],
              [1, 0],
            ];
    for (const [b, z] of profile)
      for (const a of [-halfA, halfA])
        points.push(point(a, halfB * b, height * z));
  } else {
    const ridge =
      shape === "pyramidal"
        ? 0
        : shape === "gabled"
          ? halfA
          : shape === "half-hipped"
            ? Math.max(0, halfA - halfB / 2)
            : Math.max(0, halfA - halfB);
    if (shape === "mansard")
      points.push(...corners(halfA * 0.8, halfB * 0.65, height * 0.65));
    if (shape === "half-hipped")
      for (const a of [-halfA, halfA])
        for (const b of [-halfB / 2, halfB / 2])
          points.push(point(a, b, height / 2));
    for (const a of ridge ? [-ridge, ridge] : [0])
      points.push(point(a, 0, height));
  }
  return arena.keep(cad.Manifold.hull(points));
}
