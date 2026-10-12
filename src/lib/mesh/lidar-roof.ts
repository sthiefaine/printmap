import earcut from "earcut";
import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { RoofSurface } from "@/types/osm";
import { conformIGNRoofSurfaces } from "../data/ign-roofs";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}
type Point = [number, number, number];
type Triangle = [number, number, number];
interface Node {
  x: number;
  y: number;
  heights: number[];
}
interface Polygon {
  rings: number[][];
}
interface Edge {
  a: number;
  b: number;
  nodeA: number;
  nodeB: number;
}

export interface LidarRoofOptions {
  groundElevation: number;
  project: (lon: number, lat: number) => [number, number];
  scaleFactor: number;
  buildingScale: number;
  surfaceZ: number;
  foundationZ: number;
  footprint: CrossSection;
  minimumHeight: number;
  /** Residual acceptance of the reconstructed planes, in source metres. */
  fitToleranceM: number;
}

/**
 * Assemble the reconstructed height field as one closed boundary. Shared roof
 * edges are conformed within the declared fitting residual; real height steps
 * receive vertical walls. There are no overlapping foundation prisms whose
 * internal faces could turn into four-face contacts during a native union.
 * This constructor is only for raster-derived roofs, never measured surveys.
 */
export function makeLidarRoof(
  cad: ManifoldToplevel,
  owner: Handles,
  surfaces: RoofSurface[],
  options: LidarRoofOptions,
): Manifold | null {
  const {
    groundElevation,
    project,
    scaleFactor,
    buildingScale,
    surfaceZ,
    foundationZ,
    footprint,
    minimumHeight,
    fitToleranceM,
  } = options;
  if (
    ![
      groundElevation,
      scaleFactor,
      buildingScale,
      surfaceZ,
      foundationZ,
      minimumHeight,
      fitToleranceM,
    ].every(Number.isFinite) ||
    scaleFactor <= 0 ||
    buildingScale <= 0 ||
    fitToleranceM <= 0 ||
    fitToleranceM > 2
  )
    return null;
  const conformed = conformIGNRoofSurfaces(surfaces, fitToleranceM);
  if (!conformed?.length) return null;
  const highest = Math.max(
    ...conformed.flatMap((surface) =>
      [surface.outer, ...surface.holes].flatMap((ring) =>
        ring.map((point) => point.elevation),
      ),
    ),
  );
  const relative = highest - groundElevation;
  if (!Number.isFinite(relative) || relative <= 0 || relative > 1000)
    return null;
  const factor =
    scaleFactor *
    buildingScale *
    Math.max(1, minimumHeight / (relative * scaleFactor * buildingScale));
  const temporary: { delete(): void }[] = [];
  const arena: Handles = {
    keep<T extends { delete(): void }>(handle: T): T {
      temporary.push(handle);
      return handle;
    },
  };
  let output: Manifold | null = null;
  try {
    const positions: Point[] = [];
    const nodeIds: number[] = [];
    const nodes: Node[] = [];
    const xyIds = new Map<string, number>();
    const xyzIds = new Map<string, number>();
    const nodeAt = (x: number, y: number) => {
      x = Math.fround(x);
      y = Math.fround(y);
      const key = `${x},${y}`;
      let id = xyIds.get(key);
      if (id == null) {
        id = nodes.length;
        xyIds.set(key, id);
        nodes.push({ x, y, heights: [] });
      }
      return id;
    };
    const vertexAt = (node: number, z: number) => {
      z = Math.fround(z);
      const key = `${node}:${z}`;
      let id = xyzIds.get(key);
      if (id == null) {
        id = positions.length;
        xyzIds.set(key, id);
        positions.push([nodes[node].x, nodes[node].y, z]);
        nodeIds.push(node);
        nodes[node].heights.push(id);
      }
      return id;
    };
    const signedArea = (ring: number[]) =>
      ring.reduce((sum, id, at) => {
        const a = positions[id],
          b = positions[ring[(at + 1) % ring.length]];
        return sum + a[0] * b[1] - b[0] * a[1];
      }, 0) / 2;
    const polygons: Polygon[] = [];
    for (const surface of conformed) {
      const rings = [surface.outer, ...surface.holes].map((ring) => {
        const ids: number[] = [];
        for (const point of ring.slice(0, -1)) {
          const [x, y] = project(point.lon, point.lat);
          const z = surfaceZ + (point.elevation - groundElevation) * factor;
          if (!Number.isFinite(z) || z <= foundationZ)
            throw new Error("Unsupported raster roof");
          const id = vertexAt(nodeAt(x * scaleFactor, y * scaleFactor), z);
          if (id !== ids.at(-1)) ids.push(id);
        }
        if (ids[0] === ids.at(-1)) ids.pop();
        return ids;
      });
      if (rings.some((ring) => ring.length < 3)) return null;
      for (const [at, ring] of rings.entries())
        if (signedArea(ring) > 0 !== (at === 0)) ring.reverse();
      polygons.push({ rings });
    }
    function boundaryEdges() {
      const edges = new Map<string, Edge[]>();
      for (const { rings } of polygons)
        for (const ring of rings)
          for (let at = 0; at < ring.length; at++) {
            const a = ring[at],
              b = ring[(at + 1) % ring.length];
            const nodeA = nodeIds[a],
              nodeB = nodeIds[b];
            if (nodeA === nodeB) continue;
            const key =
              nodeA < nodeB ? `${nodeA}:${nodeB}` : `${nodeB}:${nodeA}`;
            const entries = edges.get(key) ?? [];
            entries.push({ a, b, nodeA, nodeB });
            edges.set(key, entries);
          }
      return edges;
    }
    // If two independently fitted steps change order along their shared edge,
    // split at the actual plane crossing. A twisted vertical quad is invalid.
    const crossings = new Map<string, number>();
    for (const [key, entries] of boundaryEdges()) {
      if (entries.length > 2) return null;
      if (entries.length !== 2) continue;
      const [a, b] = entries;
      if (a.nodeA !== b.nodeB || a.nodeB !== b.nodeA) return null;
      const d0 = positions[a.a][2] - positions[b.b][2];
      const d1 = positions[a.b][2] - positions[b.a][2];
      if (d0 * d1 >= 0) continue;
      // Insert the actual intersection, without averaging either endpoint or
      // moving either edge. Its Z interpolates the already conformed ends:
      // the original per-pan residual bound cannot accumulate a second shift.
      const t = d0 / (d0 - d1),
        before = positions[a.a],
        after = positions[a.b];
      const node = nodeAt(
        before[0] + t * (after[0] - before[0]),
        before[1] + t * (after[1] - before[1]),
      );
      crossings.set(
        key,
        vertexAt(node, before[2] + t * (after[2] - before[2])),
      );
    }
    if (crossings.size)
      for (const polygon of polygons)
        polygon.rings = polygon.rings.map((ring) => {
          const result: number[] = [];
          for (let at = 0; at < ring.length; at++) {
            const a = ring[at],
              b = ring[(at + 1) % ring.length],
              na = nodeIds[a],
              nb = nodeIds[b];
            result.push(a);
            const crossing = crossings.get(
              na < nb ? `${na}:${nb}` : `${nb}:${na}`,
            );
            if (crossing != null && crossing !== a && crossing !== b)
              result.push(crossing);
          }
          return result;
        });
    const triangles: Triangle[] = [];
    const add = (a: number, b: number, c: number) => {
      if (a !== b && b !== c && c !== a) triangles.push([a, b, c]);
    };
    for (const { rings } of polygons) {
      const vertices = rings.flat();
      let cursor = rings[0].length;
      const holes = rings.slice(1).map((ring) => {
        const begin = cursor;
        cursor += ring.length;
        return begin;
      });
      const origin = positions[vertices[0]];
      const indices = earcut(
        vertices.flatMap((id) => [
          positions[id][0] - origin[0],
          positions[id][1] - origin[1],
        ]),
        holes,
      );
      let roof: Triangle[] = [];
      for (let at = 0; at < indices.length; at += 3) {
        const triangle = indices
          .slice(at, at + 3)
          .map((id) => vertices[id]) as Triangle;
        if (signedArea(triangle) < 0)
          [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
        roof.push(triangle);
      }
      // Earcut may omit collinear ring vertices. Keep every conformed T-node:
      // their height can bend a shared edge, even though its XY is straight.
      for (const id of vertices) {
        if (roof.some((triangle) => triangle.includes(id))) continue;
        const p = positions[id];
        const next: Triangle[] = [];
        for (const triangle of roof) {
          let split = false;
          if (!triangle.includes(id))
            for (let edge = 0; edge < 3; edge++) {
              const a = triangle[edge],
                b = triangle[(edge + 1) % 3],
                c = triangle[(edge + 2) % 3];
              const before = positions[a],
                after = positions[b];
              const dx = after[0] - before[0],
                dy = after[1] - before[1];
              const length2 = dx * dx + dy * dy;
              const t =
                ((p[0] - before[0]) * dx + (p[1] - before[1]) * dy) / length2;
              if (
                t > 1e-8 &&
                t < 1 - 1e-8 &&
                Math.hypot(
                  p[0] - before[0] - t * dx,
                  p[1] - before[1] - t * dy,
                ) <= 0.000002
              ) {
                next.push([a, id, c], [id, b, c]);
                split = true;
                break;
              }
            }
          if (!split) next.push(triangle);
        }
        roof = next;
      }
      for (const [a, b, c] of roof) {
        add(a, b, c);
        add(
          vertexAt(nodeIds[a], foundationZ),
          vertexAt(nodeIds[c], foundationZ),
          vertexAt(nodeIds[b], foundationZ),
        );
      }
    }
    for (const entries of boundaryEdges().values()) {
      if (entries.length > 2) return null;
      const a = entries[0];
      let lowA: number, lowB: number;
      if (entries.length === 2) {
        const b = entries[1];
        if (a.nodeA !== b.nodeB || a.nodeB !== b.nodeA) return null;
        lowA = b.b;
        lowB = b.a;
      } else {
        lowA = vertexAt(a.nodeA, foundationZ);
        lowB = vertexAt(a.nodeB, foundationZ);
      }
      add(a.a, lowA, a.b);
      add(a.b, lowA, lowB);
    }
    // At a corner with several real levels, each vertical wall uses the same
    // subdivisions. A long wall edge cannot skip the neighbouring lower roof.
    const divided: Triangle[] = [],
      pending = [...triangles];
    while (pending.length) {
      const triangle = pending.pop()!;
      let split = false;
      for (let edge = 0; edge < 3; edge++) {
        const a = triangle[edge],
          b = triangle[(edge + 1) % 3],
          c = triangle[(edge + 2) % 3];
        if (nodeIds[a] !== nodeIds[b]) continue;
        const za = positions[a][2],
          zb = positions[b][2];
        const id = nodes[nodeIds[a]].heights.find(
          (id) =>
            positions[id][2] > Math.min(za, zb) &&
            positions[id][2] < Math.max(za, zb),
        );
        if (id != null) {
          pending.push([a, id, c], [id, b, c]);
          split = true;
          break;
        }
      }
      if (!split) divided.push(triangle);
      if (divided.length + pending.length > 20000) return null;
    }
    if (divided.length > 20000 || positions.length > 16384) return null;
    const native = arena.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: new Float32Array(positions.flat()),
          triVerts: new Uint32Array(divided.flat()),
        }),
      ),
    );
    if (native.status() !== "NoError" || native.isEmpty()) return null;
    const coverage = arena.keep(
      cad.CrossSection.union(
        polygons.map(({ rings }) =>
          arena.keep(
            new cad.CrossSection(
              rings.map((ring) =>
                ring.map(
                  (id) =>
                    [positions[id][0], positions[id][1]] as [number, number],
                ),
              ),
              "EvenOdd",
            ),
          ),
        ),
      ),
    );
    if (
      arena.keep(footprint.subtract(coverage)).area() >
      Math.max(0.02, footprint.area() * 0.02)
    )
      return null;
    const clip = arena.keep(
      arena
        .keep(footprint.extrude(surfaceZ + relative * factor - foundationZ + 1))
        .translate([0, 0, foundationZ]),
    );
    const clipped = arena.keep(native.intersect(clip));
    if (clipped.status() !== "NoError" || clipped.isEmpty()) return null;
    output = owner.keep(clipped);
    return output;
  } catch {
    return null;
  } finally {
    for (let at = temporary.length - 1; at >= 0; at--)
      if (temporary[at] !== output) temporary[at].delete();
  }
}
