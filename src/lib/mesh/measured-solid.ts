import type {
  CrossSection,
  Manifold,
  ManifoldToplevel,
  Vec3,
} from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import type { MeasuredSolid } from "@/types/osm";
import { signedArea } from "../polygon/area";
import { pointInPolygon } from "../polygon/point-in-polygon";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

export type MeasuredBuildingSolid = MeasuredSolid;

export interface MeasuredSolidOptions {
  groundElevation: number;
  project: (lon: number, lat: number) => [number, number];
  scaleFactor: number;
  buildingScale: number;
  surfaceZ: number;
  foundationZ: number;
  minimumHeight: number;
  /** Selection rectangle; never use only the ground-support footprint here. */
  clip: CrossSection;
  /** Local source seams repaired on an already surveyed coplanar face. */
  onRepair?: (count: number) => void;
}

/**
 * An invalid architectural shell may still supply complete surveyed roofs.
 * Its convex selection envelope also contains courtyards and space between
 * wings, so it cannot be used to test roof coverage. Keep the actual roof and
 * ground projections, including holes. makeMeasuredRoof still checks that
 * these ground contacts are covered; no missing roof is manufactured here.
 */
export function makeMeasuredRoofFallbackFootprint(
  cad: ManifoldToplevel,
  owner: Handles,
  data: MeasuredBuildingSolid,
  options: Pick<MeasuredSolidOptions, "project" | "scaleFactor" | "clip">,
): CrossSection | null {
  if (
    !Array.isArray(data?.surfaces) ||
    !data.surfaces.length ||
    data.surfaces.length > 5000 ||
    !Number.isFinite(options.scaleFactor) ||
    options.scaleFactor <= 0
  )
    return null;
  const temporary: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(handle: T): T => {
    temporary.push(handle);
    return handle;
  };
  let output: CrossSection | null = null;
  try {
    const sections: CrossSection[] = [];
    let roofs = 0,
      grounds = 0,
      vertices = 0;
    for (const surface of data.surfaces) {
      if (surface.kind !== "roof" && surface.kind !== "ground") continue;
      if (
        !Array.isArray(surface.outer) ||
        !Array.isArray(surface.holes) ||
        [surface.outer, ...surface.holes].some(
          (ring) => !Array.isArray(ring) || ring.length < 3,
        )
      )
        return null;
      const rings: Point2D[][] = [];
      for (const ring of [surface.outer, ...surface.holes]) {
        const points: Point2D[] = [];
        for (const point of ring) {
          if (
            !point ||
            ![point.lat, point.lon, point.elevation].every(Number.isFinite) ||
            ++vertices > 200000
          )
            return null;
          const projected = options.project(point.lon, point.lat);
          const xy: Point2D = [
            projected[0] * options.scaleFactor,
            projected[1] * options.scaleFactor,
          ];
          if (!xy.every(Number.isFinite)) return null;
          points.push(xy);
        }
        rings.push(points);
      }
      const section = keep(new cad.CrossSection(rings, "EvenOdd"));
      if (section.isEmpty()) continue;
      sections.push(section);
      if (surface.kind === "roof") roofs++;
      else grounds++;
    }
    if (!roofs || !grounds) return null;
    const bounded = keep(
      keep(cad.CrossSection.union(sections)).intersect(options.clip),
    );
    if (bounded.isEmpty()) return null;
    output = owner.keep(bounded);
    return output;
  } catch {
    return null;
  } finally {
    for (let i = temporary.length - 1; i >= 0; i--)
      if (temporary[i] !== output) temporary[i].delete();
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function difference(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Close only planar open joints lying entirely on an existing source face. */
function closePlanarJoints(
  cad: ManifoldToplevel,
  arena: Handles,
  vertices: Vec3[],
  triangles: number[][],
  surfaces: { rings: Vec3[][] }[],
): number | null {
  const edges = new Map<string, { a: number; b: number; count: number }>();
  for (const [a, b, c] of triangles)
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const entry = edges.get(key) ?? { a: from, b: to, count: 0 };
      entry.count++;
      edges.set(key, entry);
    }
  if ([...edges.values()].some((edge) => edge.count > 2)) return null;
  const boundary = [...edges.values()].filter((edge) => edge.count === 1);
  if (!boundary.length) return 0;
  const neighbours = new Map<number, number[]>();
  for (const edge of boundary)
    for (const [a, b] of [
      [edge.a, edge.b],
      [edge.b, edge.a],
    ]) {
      const next = neighbours.get(a) ?? [];
      next.push(b);
      neighbours.set(a, next);
    }
  if ([...neighbours.values()].some((next) => next.length !== 2)) return null;
  const visited = new Set<number>();
  let repairs = 0;
  for (const first of neighbours.keys()) {
    if (visited.has(first)) continue;
    const loop = [first];
    let previous = -1,
      current = first;
    do {
      visited.add(current);
      const next = neighbours
        .get(current)!
        .find((point) => point !== previous)!;
      previous = current;
      current = next;
      if (current === first) break;
      if (visited.has(current)) return null;
      loop.push(current);
    } while (loop.length <= neighbours.size);
    if (current !== first || loop.length < 3) return null;
    const points = loop.map((index) => vertices[index]);
    const normal: Vec3 = [0, 0, 0];
    for (let i = 0; i < points.length; i++) {
      const a = points[i],
        b = points[(i + 1) % points.length];
      normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
      normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
      normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const norm = Math.hypot(...normal);
    if (norm < 0.000001) return null;
    const unit = normal.map((value) => value / norm) as Vec3;
    const onPlane = (point: Vec3) => {
      const delta = difference(point, points[0]);
      return (
        Math.abs(delta[0] * unit[0] + delta[1] * unit[1] + delta[2] * unit[2]) <
        0.00003
      );
    };
    if (!points.every(onPlane)) return null;
    const axis = normal
      .map(Math.abs)
      .indexOf(Math.max(...normal.map(Math.abs)));
    const planar = (point: Vec3): Point2D =>
      axis === 0
        ? [point[1], point[2]]
        : axis === 1
          ? [point[0], point[2]]
          : [point[0], point[1]];
    const ring = points.map(planar);
    const candidates = surfaces.filter((surface) =>
      surface.rings.flat().every(onPlane),
    );
    // A ceiling opening itself is not a closure. Only actual coverage by another
    // measured face authorises the repair of the coincident open joint.
    const covering = candidates.filter((surface) =>
      ring.every(
        ([x, y]) =>
          pointInPolygon(x, y, surface.rings[0].map(planar)) &&
          !surface.rings
            .slice(1)
            .some((hole) => pointInPolygon(x, y, hole.map(planar))),
      ),
    );
    if (!covering.length) return null;
    const coverage = arena.keep(
      cad.CrossSection.union(
        covering.map((surface) =>
          arena.keep(
            new cad.CrossSection(
              surface.rings.map((source, index) => {
                const polygon = source.map(planar);
                return signedArea(polygon) > 0 === (index === 0)
                  ? polygon
                  : polygon.toReversed();
              }),
              "NonZero",
            ),
          ),
        ),
      ),
    );
    const section = arena.keep(
      new cad.CrossSection(
        [signedArea(ring) > 0 ? ring : ring.toReversed()],
        "NonZero",
      ),
    );
    if (
      arena.keep(section.subtract(coverage)).area() >
      Math.max(0.000001, section.area() * 0.000001)
    )
      return null;
    const ordered = signedArea(ring) > 0 ? loop : loop.toReversed();
    for (const face of cad.triangulate(
      [ordered.map((index) => planar(vertices[index]))],
      0.000001,
      false,
    ))
      triangles.push(face.map((index) => ordered[index]));
    repairs++;
  }
  return repairs;
}

/** Orient each closed source component coherently, without guessing outward wall normals. */
function orientClosedMesh(
  vertices: Vec3[],
  input: number[][],
): number[] | null {
  const triangles = input.map((face) => [...face]);
  const edges = new Map<string, { face: number; sign: number }[]>();
  for (let face = 0; face < triangles.length; face++) {
    const [a, b, c] = triangles[face];
    const area = cross(
      difference(vertices[b], vertices[a]),
      difference(vertices[c], vertices[a]),
    );
    if (Math.hypot(...area) <= 1e-10) return null;
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const uses = edges.get(key) ?? [];
      uses.push({ face, sign: from < to ? 1 : -1 });
      edges.set(key, uses);
    }
  }
  if ([...edges.values()].some((uses) => uses.length !== 2)) return null;
  const adjacency = Array.from(
    { length: triangles.length },
    () => [] as { face: number; flip: boolean }[],
  );
  for (const [a, b] of edges.values()) {
    adjacency[a.face].push({ face: b.face, flip: a.sign === b.sign });
    adjacency[b.face].push({ face: a.face, flip: a.sign === b.sign });
  }
  const flips = new Map<number, boolean>();
  for (let first = 0; first < triangles.length; first++) {
    if (flips.has(first)) continue;
    const queue = [first],
      component: number[] = [];
    flips.set(first, false);
    for (let at = 0; at < queue.length; at++) {
      const face = queue[at];
      component.push(face);
      for (const next of adjacency[face]) {
        const flip = flips.get(face)! !== next.flip;
        if (flips.has(next.face)) {
          if (flips.get(next.face) !== flip) return null;
        } else {
          flips.set(next.face, flip);
          queue.push(next.face);
        }
      }
    }
    let volume = 0;
    for (const face of component) {
      if (flips.get(face))
        [triangles[face][1], triangles[face][2]] = [
          triangles[face][2],
          triangles[face][1],
        ];
      const [a, b, c] = triangles[face].map((index) => vertices[index]);
      const normal = cross(b, c);
      volume += (a[0] * normal[0] + a[1] * normal[1] + a[2] * normal[2]) / 6;
    }
    if (!Number.isFinite(volume) || Math.abs(volume) < 0.000001) return null;
    if (volume < 0)
      for (const face of component)
        [triangles[face][1], triangles[face][2]] = [
          triangles[face][2],
          triangles[face][1],
        ];
  }
  return triangles.flat();
}

/**
 * Build the surveyed closed shell, including underside and vertical hole rings.
 * Foundations are added under surveyed ground contacts only. Projecting every
 * roof to the ground would fill arches and other measured passages.
 */
export function makeMeasuredSolid(
  cad: ManifoldToplevel,
  owner: Handles,
  data: MeasuredBuildingSolid,
  options: MeasuredSolidOptions,
): Manifold | null {
  const surfaces = data?.surfaces;
  if (
    !Array.isArray(surfaces) ||
    !surfaces.length ||
    surfaces.length > 5000 ||
    ![
      options.groundElevation,
      options.scaleFactor,
      options.buildingScale,
      options.surfaceZ,
      options.foundationZ,
      options.minimumHeight,
    ].every(Number.isFinite) ||
    options.scaleFactor <= 0 ||
    options.buildingScale <= 0
  )
    return null;
  let maximumElevation = -Infinity,
    count = 0;
  for (const surface of surfaces) {
    if (
      !surface ||
      !Array.isArray(surface.outer) ||
      !Array.isArray(surface.holes)
    )
      return null;
    for (const ring of [surface.outer, ...surface.holes]) {
      if (!Array.isArray(ring) || ring.length < 3) return null;
      for (const point of ring) {
        if (
          !point ||
          ![point.lat, point.lon, point.elevation].every(Number.isFinite) ||
          ++count > 200000
        )
          return null;
        maximumElevation = Math.max(maximumElevation, point.elevation);
      }
    }
  }
  const height = maximumElevation - options.groundElevation;
  if (height <= 0 || height > 1000) return null;
  const zFactor =
    options.scaleFactor *
    options.buildingScale *
    Math.max(
      1,
      options.minimumHeight /
        (height * options.scaleFactor * options.buildingScale),
    );
  const vertices: Vec3[] = [],
    ids = new Map<string, number>();
  const addVertex = (point: Vec3) => {
    const key = point.map((value) => Math.round(value * 100000)).join(",");
    let id = ids.get(key);
    if (id == null) {
      id = vertices.length;
      vertices.push(point);
      ids.set(key, id);
    }
    return id;
  };
  const projectSurfaces = () =>
    surfaces.map((surface) => ({
      kind: surface.kind,
      rings: [surface.outer, ...surface.holes].map((raw) => {
        const ring: Vec3[] = [];
        for (const point of raw) {
          const [x, y] = options.project(point.lon, point.lat);
          const vertex: Vec3 = [
            x * options.scaleFactor,
            y * options.scaleFactor,
            options.surfaceZ +
              (point.elevation - options.groundElevation) * zFactor,
          ];
          if (!vertex.every(Number.isFinite))
            throw new Error("Invalid projection");
          if (
            !ring.length ||
            Math.hypot(...difference(vertex, ring.at(-1)!)) > 0.00001
          )
            ring.push(vertex);
        }
        if (
          ring.length > 2 &&
          Math.hypot(...difference(ring[0], ring.at(-1)!)) <= 0.00001
        )
          ring.pop();
        return ring;
      }),
    }));
  const temporary: { delete(): void }[] = [];
  const arena: Handles = {
    keep(handle) {
      temporary.push(handle);
      return handle;
    },
  };
  let output: Manifold | null = null;
  try {
    const projected = projectSurfaces();
    const triangles: number[][] = [];
    for (const surface of projected) {
      if (surface.rings.some((ring) => ring.length < 3)) return null;
      const outer = surface.rings[0];
      const normal: Vec3 = [0, 0, 0];
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i],
          b = outer[(i + 1) % outer.length];
        normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
        normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
        normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const axis = normal
        .map(Math.abs)
        .indexOf(Math.max(...normal.map(Math.abs)));
      if (Math.hypot(...normal) < 1e-10) return null;
      const planar = (point: Vec3): Point2D =>
        axis === 0
          ? [point[1], point[2]]
          : axis === 1
            ? [point[0], point[2]]
            : [point[0], point[1]];
      const rings = surface.rings.map((ring, index) => {
        const ordered = [...ring];
        if (signedArea(ordered.map(planar)) > 0 !== (index === 0))
          ordered.reverse();
        return ordered;
      });
      const points = rings.flat().map(addVertex);
      for (const face of cad.triangulate(
        rings.map((ring) => ring.map(planar)),
        0.000001,
        false,
      ))
        triangles.push(face.map((index) => points[index]));
    }
    const repairedJoints = closePlanarJoints(
      cad,
      arena,
      vertices,
      triangles,
      projected,
    );
    if (repairedJoints == null) return null;
    const oriented = orientClosedMesh(vertices, triangles);
    if (!oriented) return null;
    const shell = arena.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: new Float32Array(vertices.flat()),
          triVerts: new Uint32Array(oriented),
          tolerance: 0.00001,
        }),
      ),
    );
    if (shell.status() !== "NoError" || shell.isEmpty()) return null;
    const sourceParts = shell.decompose().map((part) => arena.keep(part));
    const measured = arena.keep(cad.Manifold.union(sourceParts));
    const foundations: Manifold[] = [];
    for (const surface of projected.filter((item) => item.kind === "ground")) {
      const rings = surface.rings.map((ring, index) => {
        const ordered = [...ring];
        if (signedArea(ordered.map(([x, y]) => [x, y])) > 0 !== (index === 0))
          ordered.reverse();
        return ordered;
      });
      if (Math.abs(signedArea(rings[0].map(([x, y]) => [x, y]))) < 0.000001)
        continue;
      // A closed source ground face can be buried below the walking terrain.
      // Preserve its absolute datum instead of raising the whole architecture.
      // The socle already supports source faces lying below the foundation.
      if (rings.flat().every((point) => point[2] <= options.foundationZ))
        continue;
      const top = rings.flat(),
        n = top.length;
      const positions = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        positions.set(top[i], i * 3);
        // A tiny upward overlap avoids a coplanar shell/foundation boundary.
        positions[i * 3 + 2] = Math.max(top[i][2], options.foundationZ) + 0.001;
        positions.set([top[i][0], top[i][1], options.foundationZ], (i + n) * 3);
      }
      const faces: number[] = [];
      for (const [a, b, c] of cad.triangulate(
        rings.map((ring) => ring.map(([x, y]) => [x, y] as Point2D)),
        0.000001,
        false,
      ))
        faces.push(a, b, c, a + n, c + n, b + n);
      let at = 0;
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const a = at + i,
            b = at + ((i + 1) % ring.length);
          faces.push(a, a + n, b, b, a + n, b + n);
        }
        at += ring.length;
      }
      const foundation = arena.keep(
        new cad.Manifold(
          new cad.Mesh({
            numProp: 3,
            vertProperties: positions,
            triVerts: new Uint32Array(faces),
            tolerance: 0.00001,
          }),
        ),
      );
      if (foundation.status() !== "NoError") return null;
      foundations.push(foundation);
    }
    const solid = arena.keep(cad.Manifold.union([measured, ...foundations]));
    const boundary = arena.keep(
      options.clip.extrude(options.surfaceZ + height * zFactor + 1),
    );
    const clipped = arena.keep(solid.intersect(boundary));
    if (clipped.status() !== "NoError" || clipped.isEmpty()) return null;
    const components = clipped
      .decompose()
      .map((component) => arena.keep(component));
    if (
      components.some(
        (component) =>
          component.volume() > 0.000001 &&
          component.boundingBox().min[2] > options.foundationZ + 0.0001,
      )
    )
      return null;
    output = owner.keep(clipped);
    if (repairedJoints) options.onRepair?.(repairedJoints);
    return output;
  } catch {
    return null;
  } finally {
    for (let i = temporary.length - 1; i >= 0; i--)
      if (temporary[i] !== output) temporary[i].delete();
  }
}
