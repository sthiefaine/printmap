import type { Manifold, ManifoldToplevel, Mesh } from "manifold-3d";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

type Point = [number, number, number];
interface EdgeContact {
  a: Point;
  b: Point;
  count: number;
  direction: number;
  originalId: number;
  faces: { points: [Point, Point, Point]; direction: number }[];
}

export interface EdgeContactRepair {
  solid: Manifold;
  repairedCount: number;
  removedVolumeMm3: number;
}

/**
 * Open only line contacts which would weld to more than two export faces.
 * A narrow cut removes material around each detected edge, keeping existing
 * cavities empty. Nearly coincident overlapping faces need their entire thin
 * contact film removed; cutting only its edge would move the singularity.
 * The source's material IDs are used for new faces.
 */
export function openEdgeContacts(
  cad: ManifoldToplevel,
  owner: Handles,
  solid: Manifold,
  clearanceMm = 0.005,
): EdgeContactRepair {
  if (!Number.isFinite(clearanceMm) || clearanceMm <= 0 || clearanceMm > 0.01)
    throw new Error(
      "L’ouverture du contact doit être comprise entre 0 et 0,01 mm.",
    );
  const contacts = findContacts(solid.getMesh());
  if (!contacts.length) return { solid, repairedCount: 0, removedVolumeMm3: 0 };
  const cutters: Manifold[] = [];
  let maximumRemovedVolume = 0;
  for (const edge of contacts) {
    let positioned = makeCoplanarContactCut(cad, owner, edge, clearanceMm);
    if (!positioned) {
      const delta = subtract(edge.b, edge.a);
      const length = Math.hypot(...delta);
      if (length === 0) continue;
      if (length <= clearanceMm * 2) {
        // On a sub-clearance edge, a cylindrical cut can stop inside the thin
        // adjacent film and create another four-face edge. Clear those faces'
        // full micron-thick sheets, with the same volume bounds below.
        positioned = makeFaceContactCut(cad, owner, edge, clearanceMm);
      } else {
        const w = delta.map((value) => value / length) as Point;
        const axis: Point =
          Math.abs(w[0]) <= Math.abs(w[1]) && Math.abs(w[0]) <= Math.abs(w[2])
            ? [1, 0, 0]
            : Math.abs(w[1]) <= Math.abs(w[2])
              ? [0, 1, 0]
              : [0, 0, 1];
        const u = unit(cross(w, axis));
        const v = cross(w, u);
        const cylinder = owner.keep(
          cad.Manifold.cylinder(
            length + clearanceMm * 2,
            clearanceMm,
            clearanceMm,
            12,
          ),
        );
        positioned = owner.keep(
          cylinder.warp((vertex) => {
            const [x, y, z] = vertex;
            for (let i = 0; i < 3; i++)
              vertex[i] =
                edge.a[i] + u[i] * x + v[i] * y + w[i] * (z - clearanceMm);
          }),
        );
      }
    }
    const mesh = positioned.getMesh();
    const cutter = owner.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: mesh.numProp,
          vertProperties: mesh.vertProperties,
          triVerts: mesh.triVerts,
          mergeFromVert: mesh.mergeFromVert,
          mergeToVert: mesh.mergeToVert,
          runIndex: mesh.runIndex,
          runOriginalID: new Uint32Array(mesh.runOriginalID.length).fill(
            edge.originalId,
          ),
          runTransform: mesh.runTransform,
          faceID: mesh.faceID,
          tolerance: mesh.tolerance,
        }),
      ),
    );
    if (cutter.status() !== "NoError")
      throw new Error("L’ouverture locale du contact a échoué.");
    cutters.push(cutter);
    maximumRemovedVolume += cutter.volume();
  }
  const cut = owner.keep(cad.Manifold.union(cutters));
  const result = owner.keep(solid.subtract(cut));
  // Measure the tiny removed region directly. Subtracting the volumes of two
  // whole neighbourhoods loses precision when a micron-scale cut is applied.
  const removedVolumeMm3 = owner.keep(solid.intersect(cut)).volume();
  const volumeDifference = solid.volume() - result.volume();
  const numericalVolumeTolerance = Math.max(
    0.000001,
    Math.abs(solid.volume()) * 1e-8,
  );
  if (
    result.status() !== "NoError" ||
    removedVolumeMm3 < -0.000001 ||
    removedVolumeMm3 > maximumRemovedVolume * 1.05 + 0.000001 ||
    Math.abs(volumeDifference - removedVolumeMm3) > numericalVolumeTolerance ||
    removedVolumeMm3 > Math.max(0.000001, Math.abs(solid.volume()) * 0.0001)
  )
    throw new Error(
      "L’ouverture du contact dépasse le volume de correction autorisé.",
    );
  return {
    solid: result,
    repairedCount: cutters.length,
    removedVolumeMm3: Math.max(0, removedVolumeMm3),
  };
}

function subtract(a: Point, b: Point): Point {
  return a.map((value, i) => value - b[i]) as Point;
}

function dot(a: Point, b: Point): number {
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}

function unit(vector: Point): Point {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length) as Point;
}

function makeCoplanarContactCut(
  cad: ManifoldToplevel,
  owner: Handles,
  edge: EdgeContact,
  clearanceMm: number,
): Manifold | null {
  for (let i = 0; i < edge.faces.length; i++) {
    const first = edge.faces[i];
    const [a, b, c] = first.points;
    const crossFirst = cross(subtract(b, a), subtract(c, a));
    if (Math.hypot(...crossFirst) < 1e-10) continue;
    let normal = unit(crossFirst);
    for (let j = i + 1; j < edge.faces.length; j++) {
      const second = edge.faces[j];
      const [d, e, f] = second.points;
      const crossSecond = cross(subtract(e, d), subtract(f, d));
      if (Math.hypot(...crossSecond) < 1e-10) continue;
      // A collapsed contact film can have equal or opposite boundary normals.
      // Opposite normals occur where two roof prisms touch through an internal
      // sheet. Check positive overlap below rather than assuming a winding.
      let maxCoordinate = 1;
      for (const point of [...first.points, ...second.points])
        for (const coordinate of point)
          maxCoordinate = Math.max(maxCoordinate, Math.abs(coordinate));
      const coordinateTolerance = Math.max(0.00001, maxCoordinate * 0.0000005);
      const altitude = (points: [Point, Point, Point], area: Point) =>
        Math.hypot(...area) /
        Math.max(
          Math.hypot(...subtract(points[0], points[1])),
          Math.hypot(...subtract(points[1], points[2])),
          Math.hypot(...subtract(points[2], points[0])),
        );
      const firstAltitude = altitude(first.points, crossFirst);
      const secondAltitude = altitude(second.points, crossSecond);
      // Float32 rounding makes normals unreliable on a triangle only a few
      // coordinate steps wide. Use the wider face's plane and still require
      // every vertex to lie within coordinate precision of that plane.
      normal = unit(firstAltitude >= secondAltitude ? crossFirst : crossSecond);
      if (
        Math.abs(dot(unit(crossFirst), unit(crossSecond))) < 0.9999999 &&
        Math.min(firstAltitude, secondAltitude) > coordinateTolerance * 4
      )
        continue;
      if (
        [...first.points, ...second.points].some(
          (point) =>
            Math.abs(dot(subtract(point, a), normal)) > coordinateTolerance,
        )
      )
        continue;
      const u = unit(subtract(edge.b, edge.a)),
        v = cross(normal, u);
      const rings = [first.points, second.points].map((triangle) =>
        triangle.map((point) => {
          const delta = subtract(point, a);
          return [dot(delta, u), dot(delta, v)] as [number, number];
        }),
      );
      const sections = rings.map((ring) =>
        owner.keep(new cad.CrossSection([ring], "EvenOdd")),
      );
      const overlap = owner.keep(sections[0].intersect(sections[1]));
      // Ordinary coplanar neighbours meet only along their shared edge. They
      // must not be removed as a thin film merely because their planes match.
      if (overlap.area() <= 1e-12) continue;
      const section = owner.keep(cad.CrossSection.union(sections));
      const expanded = owner.keep(section.offset(clearanceMm, "Round", 2, 12));
      const prism = owner.keep(expanded.extrude(clearanceMm * 2));
      return owner.keep(
        prism.warp((vertex) => {
          const [x, y, z] = vertex;
          for (let axis = 0; axis < 3; axis++)
            vertex[axis] =
              a[axis] +
              u[axis] * x +
              v[axis] * y +
              normal[axis] * (z - clearanceMm);
        }),
      );
    }
  }
  return null;
}

function makeFaceContactCut(
  cad: ManifoldToplevel,
  owner: Handles,
  edge: EdgeContact,
  clearanceMm: number,
): Manifold {
  const pieces: Manifold[] = [];
  for (const { points } of edge.faces) {
    const [a, b, c] = points;
    const n = cross(subtract(b, a), subtract(c, a));
    if (Math.hypot(...n) < 1e-10) continue;
    const normal = unit(n),
      u = unit(subtract(b, a)),
      v = cross(normal, u);
    const ring = points.map((point) => {
      const delta = subtract(point, a);
      return [dot(delta, u), dot(delta, v)] as [number, number];
    });
    const section = owner.keep(new cad.CrossSection([ring], "EvenOdd"));
    const expanded = owner.keep(section.offset(clearanceMm, "Round", 2, 12));
    const prism = owner.keep(expanded.extrude(clearanceMm * 2));
    pieces.push(
      owner.keep(
        prism.warp((vertex) => {
          const [x, y, z] = vertex;
          for (let axis = 0; axis < 3; axis++)
            vertex[axis] =
              a[axis] +
              u[axis] * x +
              v[axis] * y +
              normal[axis] * (z - clearanceMm);
        }),
      ),
    );
  }
  return owner.keep(cad.Manifold.union(pieces));
}

function cross(a: Point, b: Point): Point {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function findContacts(mesh: Mesh): EdgeContact[] {
  const points: Point[] = Array.from(
    { length: mesh.vertProperties.length / mesh.numProp },
    (_, index) =>
      Array.from(
        mesh.vertProperties.subarray(
          index * mesh.numProp,
          index * mesh.numProp + 3,
        ),
      ) as Point,
  );
  const keys = points.map((point) =>
    point.map((value) => Math.round(value * 100000)).join(","),
  );
  const edges = new Map<string, EdgeContact>();
  let run = 0;
  for (let at = 0; at < mesh.triVerts.length; at += 3) {
    while (run + 1 < mesh.runOriginalID.length && at >= mesh.runIndex[run + 1])
      run++;
    const triangle = [
      mesh.triVerts[at],
      mesh.triVerts[at + 1],
      mesh.triVerts[at + 2],
    ];
    // Collapsed faces need the ordinary mesh cleanup, not a physical cut.
    if (new Set(triangle.map((index) => keys[index])).size < 3) continue;
    for (let side = 0; side < 3; side++) {
      const ai = triangle[side],
        bi = triangle[(side + 1) % 3];
      const a = keys[ai],
        b = keys[bi],
        key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = edges.get(key) ?? {
        a: points[ai],
        b: points[bi],
        count: 0,
        direction: 0,
        originalId: mesh.runOriginalID[run],
        faces: [],
      };
      edge.count++;
      edge.direction += a < b ? 1 : -1;
      edges.set(key, edge);
    }
  }
  const contacts = new Map(
    [...edges].filter(([, edge]) => edge.count > 2 && edge.direction === 0),
  );
  for (let at = 0; at < mesh.triVerts.length; at += 3) {
    const triangle = [
      mesh.triVerts[at],
      mesh.triVerts[at + 1],
      mesh.triVerts[at + 2],
    ];
    if (new Set(triangle.map((index) => keys[index])).size < 3) continue;
    for (let side = 0; side < 3; side++) {
      const a = keys[triangle[side]],
        b = keys[triangle[(side + 1) % 3]],
        key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = contacts.get(key);
      if (edge)
        edge.faces.push({
          points: triangle.map((index) => points[index]) as [
            Point,
            Point,
            Point,
          ],
          direction: a < b ? 1 : -1,
        });
    }
  }
  return [...contacts.values()];
}
