import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { Point2D } from "@/types/geometry";
import { repairCoincident } from "./repair-coincident";
import { repairCollinear } from "./repair-collinear";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}
export interface AqueductSection {
  fromMm: number;
  toMm: number;
  kind: "pitot-double" | "giral-terminal";
  /** Terminal count must be supplied; Pitot defaults to its historical pitch. */
  spanCount?: number;
}
export interface AqueductDimensions {
  mainOpeningM: number;
  mainSpringOpeningM: number;
  mainPierM: number;
  smallOpeningM: number;
  smallPierM: number;
  upperStageM: number;
  baseWidthM: number;
  springWidthM: number;
  topWidthM: number;
  /** These two values are assumptions, not dimensions certified by the plan. */
  interstageHeaderM: number;
  topHeaderM: number;
}
export const HISTORICAL_AQUEDUCT_DIMENSIONS: AqueductDimensions = {
  mainOpeningM: 8.4,
  mainSpringOpeningM: 9.02,
  mainPierM: 3.75,
  smallOpeningM: 3.12,
  smallPierM: 0.97,
  upperStageM: 5.25,
  baseWidthM: 4,
  springWidthM: 3.35,
  topWidthM: 2.6,
  interstageHeaderM: 0.5,
  topHeaderM: 0.5,
};
export interface AqueductOptions {
  axisPolylineMm: Point2D[];
  sections: AqueductSection[];
  clip: CrossSection;
  /** Optional real outline, never a location-only inventory buffer. */
  footprint?: CrossSection;
  surfaceAt: (x: number, y: number) => number;
  terrainMaxZ: number;
  foundationZ: number;
  /** Constant model Z supplied from an explicit datum or a declared hypothesis. */
  deckZMm: number;
  scaleFactor: number;
  minFeatureMm: number;
  dimensions?: Partial<AqueductDimensions>;
}
export interface ReconstructedAqueduct {
  solid: Manifold;
  /** Only inferred passages, above foundationZ; the common bedplate is intact. */
  cutter: Manifold;
  footprint: CrossSection;
  spanCount: number;
  largeSpanCount: number;
  smallSpanCount: number;
  boundarySupportCount: number;
  modifiedForPrinting: boolean;
  approximateGeometry: true;
  dimensions: AqueductDimensions;
  assumptions: string[];
}

/** Historical dimensions reconstruct a printable silhouette, not a current survey. */
export function makeAqueduct(
  cad: ManifoldToplevel,
  owner: Handles,
  options: AqueductOptions,
): ReconstructedAqueduct | null {
  const dimensions = {
    ...HISTORICAL_AQUEDUCT_DIMENSIONS,
    ...options.dimensions,
  };
  if (
    ![
      options.terrainMaxZ,
      options.foundationZ,
      options.deckZMm,
      options.scaleFactor,
      options.minFeatureMm,
      ...Object.values(dimensions),
    ].every(Number.isFinite) ||
    options.foundationZ < 0 ||
    options.terrainMaxZ < options.foundationZ ||
    options.deckZMm <= options.foundationZ ||
    options.scaleFactor <= 0 ||
    options.minFeatureMm <= 0 ||
    Object.values(dimensions).some((value) => value <= 0) ||
    options.clip.isEmpty()
  )
    return null;
  const path = options.axisPolylineMm.filter(
    (p, i, all) =>
      p.every(Number.isFinite) &&
      (i === 0 ||
        Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 0.00001),
  );
  if (path.length < 2 || path.length !== options.axisPolylineMm.length)
    return null;
  const distances = [0];
  const normals: Point2D[] = [];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i][0] - path[i - 1][0],
      dy = path[i][1] - path[i - 1][1],
      length = Math.hypot(dx, dy);
    distances.push(distances.at(-1)! + length);
    normals.push([-dy / length, dx / length]);
    if (
      i > 1 &&
      normals[i - 2][0] * normals[i - 1][0] +
        normals[i - 2][1] * normals[i - 1][1] <
        -0.5
    )
      return null;
  }
  const total = distances.at(-1)!;
  const sections = options.sections.slice().sort((a, b) => a.fromMm - b.fromMm);
  if (
    !sections.length ||
    sections.some(
      (s, i) =>
        ![s.fromMm, s.toMm].every(Number.isFinite) ||
        s.fromMm < 0 ||
        s.toMm > total + 0.00001 ||
        s.toMm <= s.fromMm ||
        (i > 0 && s.fromMm < sections[i - 1].toMm - 0.00001) ||
        (s.kind !== "pitot-double" && s.kind !== "giral-terminal") ||
        (s.kind === "giral-terminal" && !s.spanCount) ||
        (s.spanCount != null &&
          (!Number.isInteger(s.spanCount) ||
            s.spanCount < 1 ||
            s.spanCount > 1000)),
    )
  )
    return null;
  const handles: { delete(): void }[] = [],
    outputs = new Set<{ delete(): void }>();
  const arena: Handles = {
    keep(handle) {
      handles.push(handle);
      return handle;
    },
  };
  const { scaleFactor: sf, foundationZ, deckZMm: deck } = options;
  const minimum = Math.max(0.4, options.minFeatureMm);
  const minHeader = Math.max(0.4, minimum / 2);
  const header = Math.max(minHeader, dimensions.topHeaderM * sf);
  const interstage = Math.max(minHeader, dimensions.interstageHeaderM * sf);
  const largePitch = (dimensions.mainOpeningM + dimensions.mainPierM) * sf;
  const upperCrown = deck - header;
  const upperFloor = upperCrown - dimensions.upperStageM * sf;
  const lowerCrown = upperFloor - interstage;
  const baseWidth = Math.max(minimum, dimensions.baseWidthM * sf);
  const springWidth = Math.max(minimum, dimensions.springWidthM * sf);
  const topWidth = Math.max(minimum, dimensions.topWidthM * sf);
  let modifiedForPrinting =
    header !== dimensions.topHeaderM * sf ||
    interstage !== dimensions.interstageHeaderM * sf ||
    baseWidth !== dimensions.baseWidthM * sf ||
    springWidth !== dimensions.springWidthM * sf ||
    topWidth !== dimensions.topWidthM * sf;
  const assumptions = [
    "Profil reconstitué d’après un dessin historique, pas un relevé de l’ouvrage actuel.",
    "Épaisseurs entre étages et au-dessus des voûtes supposées ; la cote d’étage de 5,25 m est utilisée comme hauteur du profil reconstruit.",
    "Planchers des grandes ouvertures interpolés depuis le relief local ; l’altitude du tablier est constante et doit être déclarée par l’appelant.",
  ];
  const station = (distance: number) => {
    const bounded = Math.max(0, Math.min(total, distance));
    let segment = 0;
    while (
      segment + 1 < path.length - 1 &&
      bounded > distances[segment + 1] + 0.000001
    )
      segment++;
    const alpha =
      (bounded - distances[segment]) /
      (distances[segment + 1] - distances[segment]);
    const center: Point2D = [
      path[segment][0] + alpha * (path[segment + 1][0] - path[segment][0]),
      path[segment][1] + alpha * (path[segment + 1][1] - path[segment][1]),
    ];
    let normal = normals[segment],
      miter = 1;
    const vertex = distances.findIndex(
      (d, i) =>
        i > 0 && i < path.length - 1 && Math.abs(d - bounded) < 0.000001,
    );
    if (vertex >= 0) {
      const before = normals[vertex - 1],
        after = normals[vertex],
        sum: Point2D = [before[0] + after[0], before[1] + after[1]],
        length = Math.hypot(...sum);
      normal = [sum[0] / length, sum[1] / length];
      miter = Math.min(
        3,
        1 / Math.max(0.01, normal[0] * after[0] + normal[1] * after[1]),
      );
    }
    return {
      center,
      normal,
      miter,
      direction: [normal[1], -normal[0]] as Point2D,
    };
  };
  const corridor = (from: number, to: number, width: number): CrossSection => {
    const stations = [
      from,
      ...distances.filter((d) => d > from + 0.000001 && d < to - 0.000001),
      to,
    ].map(station);
    const polygons: Point2D[][] = [];
    for (let i = 0; i < stations.length - 1; i++) {
      const a = stations[i],
        b = stations[i + 1];
      const side = (s: typeof a, sign: number): Point2D => [
        s.center[0] + (sign * s.normal[0] * s.miter * width) / 2,
        s.center[1] + (sign * s.normal[1] * s.miter * width) / 2,
      ];
      polygons.push([side(a, 1), side(a, -1), side(b, -1), side(b, 1)]);
    }
    return arena.keep(new cad.CrossSection(polygons, "NonZero"));
  };
  const loft = (
    from: number,
    to: number,
    levels: [number, number][],
  ): Manifold => {
    const stations = [
      from,
      ...distances.filter((d) => d > from + 0.000001 && d < to - 0.000001),
      to,
    ].map(station);
    const positions: number[] = [],
      triangles: number[] = [];
    const vertex = (level: number, at: number, side: number) =>
      (level * stations.length + at) * 2 + side;
    for (const [z, width] of levels)
      for (const st of stations)
        for (const sign of [1, -1])
          positions.push(
            st.center[0] + (sign * st.normal[0] * st.miter * width) / 2,
            st.center[1] + (sign * st.normal[1] * st.miter * width) / 2,
            z,
          );
    const quad = (a: number, b: number, c: number, d: number) =>
      triangles.push(a, b, c, a, c, d);
    const last = levels.length - 1,
      end = stations.length - 1;
    for (let at = 0; at < end; at++) {
      quad(
        vertex(0, at, 0),
        vertex(0, at + 1, 0),
        vertex(0, at + 1, 1),
        vertex(0, at, 1),
      );
      quad(
        vertex(last, at, 0),
        vertex(last, at, 1),
        vertex(last, at + 1, 1),
        vertex(last, at + 1, 0),
      );
      for (let level = 0; level < last; level++) {
        quad(
          vertex(level, at, 1),
          vertex(level, at + 1, 1),
          vertex(level + 1, at + 1, 1),
          vertex(level + 1, at, 1),
        );
        quad(
          vertex(level, at + 1, 0),
          vertex(level, at, 0),
          vertex(level + 1, at, 0),
          vertex(level + 1, at + 1, 0),
        );
      }
    }
    for (let level = 0; level < last; level++) {
      quad(
        vertex(level, 0, 0),
        vertex(level, 0, 1),
        vertex(level + 1, 0, 1),
        vertex(level + 1, 0, 0),
      );
      quad(
        vertex(level, end, 1),
        vertex(level, end, 0),
        vertex(level + 1, end, 0),
        vertex(level + 1, end, 1),
      );
    }
    // One continuous shell avoids coincident internal end caps at bends.
    return arena.keep(
      new cad.Manifold(
        new cad.Mesh({
          numProp: 3,
          vertProperties: new Float32Array(positions),
          triVerts: new Uint32Array(triangles),
        }),
      ),
    );
  };
  try {
    const sectionOutlines = sections.map((section) =>
      corridor(section.fromMm, section.toMm, baseWidth),
    );
    let footprint = arena.keep(cad.CrossSection.union(sectionOutlines));
    if (options.footprint)
      footprint = arena.keep(footprint.intersect(options.footprint));
    footprint = arena.keep(footprint.intersect(options.clip));
    if (footprint.isEmpty()) return null;
    const column = arena.keep(
      arena
        .keep(footprint.extrude(deck - foundationZ + 1))
        .translate([0, 0, foundationZ - 0.005]),
    );
    const blocks: Manifold[] = [],
      cutters: Manifold[] = [];
    let largeSpanCount = 0,
      smallSpanCount = 0;
    const makeOpening = (
      centerDistance: number,
      jamb: number,
      spring: number,
      crown: number,
      upperFloorZ: number | null,
      mask: Manifold,
    ): boolean => {
      const st = station(centerDistance),
        half = spring / 2,
        springZ = crown - half;
      if (crown <= foundationZ + 0.05) return false;
      const lower = upperFloorZ ?? foundationZ + 0.00001;
      if (lower >= crown - 0.05) return false;
      const profile: Point2D[] = [
        [-jamb / 2, lower],
        [jamb / 2, lower],
        [half, Math.max(lower, springZ)],
      ];
      const facets = Math.max(16, Math.min(96, Math.ceil(spring / 0.12)));
      for (let i = 1; i <= facets; i++) {
        const theta = (i / facets) * Math.PI;
        profile.push([
          half * Math.cos(theta),
          springZ + half * Math.sin(theta),
        ]);
      }
      let section = arena.keep(new cad.CrossSection([profile], "NonZero"));
      if (upperFloorZ == null) {
        const floor: Point2D[] = [];
        const count = Math.max(8, Math.min(64, Math.ceil(spring / 0.25)));
        for (let i = 0; i <= count; i++) {
          const x = -half + (i / count) * spring;
          const px = st.center[0] + x * st.direction[0],
            py = st.center[1] + x * st.direction[1];
          const values = [-baseWidth / 2, 0, baseWidth / 2].map((across) =>
            options.surfaceAt(
              px + across * st.normal[0],
              py + across * st.normal[1],
            ),
          );
          if (!values.every(Number.isFinite))
            throw new Error("Relief aqueduc invalide");
          floor.push([x, Math.max(foundationZ + 0.00001, Math.min(...values))]);
        }
        floor.push(
          [half, Math.max(deck, options.terrainMaxZ) + 1],
          [-half, Math.max(deck, options.terrainMaxZ) + 1],
        );
        section = arena.keep(
          section.intersect(
            arena.keep(new cad.CrossSection([floor], "NonZero")),
          ),
        );
      }
      // The fixed upper gallery floor must also stay above the common bedplate.
      const aboveBedplate = arena.keep(
        cad.CrossSection.square([
          spring + 1,
          Math.max(deck, options.terrainMaxZ) + 2,
        ]).translate([-spring / 2 - 0.5, foundationZ + 0.00001]),
      );
      section = arena.keep(section.intersect(aboveBedplate));
      if (section.isEmpty()) return false;
      const passage = arena.keep(
        arena.keep(section.extrude(baseWidth + 2)).warp((vertex) => {
          const [x, z, y] = vertex;
          // Swapping the profile Y and extrusion Z needs the opposite transverse
          // direction, otherwise the warp reverses the winding of the cutter.
          const across = (baseWidth + 2) / 2 - y;
          vertex[0] =
            st.center[0] + x * st.direction[0] + across * st.normal[0];
          vertex[1] =
            st.center[1] + x * st.direction[1] + across * st.normal[1];
          vertex[2] = z;
        }),
      );
      const cut = arena.keep(passage.intersect(mask));
      if (
        cut.status() !== "NoError" ||
        cut.isEmpty() ||
        cut.volume() < 0.000001
      )
        return false;
      cutters.push(cut);
      return true;
    };
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index],
        length = section.toMm - section.fromMm;
      const isDouble = section.kind === "pitot-double";
      const count =
        section.spanCount ?? Math.max(1, Math.ceil(length / largePitch));
      const pitch = section.spanCount ? length / count : largePitch;
      const pier = Math.max(minimum, dimensions.mainPierM * sf);
      const opening = Math.max(0.12, pitch - pier);
      const springOpening = isDouble
        ? Math.min(pitch - minimum, dimensions.mainSpringOpeningM * sf)
        : opening;
      const effectiveOpening = Math.min(opening, springOpening);
      if (effectiveOpening < minimum / 2) return null;
      if (
        pier !== dimensions.mainPierM * sf ||
        (springOpening !== dimensions.mainSpringOpeningM * sf && isDouble)
      )
        modifiedForPrinting = true;
      const crown = isDouble ? lowerCrown : upperCrown;
      const levels: [number, number][] = [[foundationZ - 0.005, baseWidth]];
      const addLevel = (z: number, width: number) => {
        if (z > levels.at(-1)![0] + 0.00001 && z < deck - 0.00001)
          levels.push([z, width]);
      };
      addLevel(crown - springOpening / 2, springWidth);
      addLevel(crown, springWidth);
      if (isDouble) addLevel(upperFloor, topWidth);
      levels.push([deck, isDouble ? topWidth : springWidth]);
      const body = arena.keep(
        loft(section.fromMm, section.toMm, levels).intersect(column),
      );
      blocks.push(body);
      const sectionColumn = arena.keep(
        arena
          .keep(sectionOutlines[index].extrude(deck - foundationZ + 1))
          .translate([0, 0, foundationZ - 0.005]),
      );
      const mask = arena.keep(sectionColumn.intersect(column));
      for (let span = 0; span < count; span++) {
        const center = section.fromMm + (span + 0.5) * pitch;
        if (
          makeOpening(
            center,
            effectiveOpening,
            springOpening,
            crown,
            null,
            mask,
          )
        )
          largeSpanCount++;
        if (isDouble) {
          const smallPitch = pitch / 3,
            smallPier = Math.max(minimum, dimensions.smallPierM * sf),
            smallOpening = Math.min(
              dimensions.smallOpeningM * sf,
              smallPitch - smallPier,
            );
          if (smallOpening < minimum / 2) {
            modifiedForPrinting = true;
            continue;
          }
          if (
            smallPier !== dimensions.smallPierM * sf ||
            smallOpening !== dimensions.smallOpeningM * sf
          )
            modifiedForPrinting = true;
          for (let small = 0; small < 3; small++)
            if (
              makeOpening(
                section.fromMm + (span + (small + 0.5) / 3) * pitch,
                smallOpening,
                smallOpening,
                upperCrown,
                upperFloor,
                mask,
              )
            )
              smallSpanCount++;
        }
      }
      if (!isDouble)
        assumptions.push(
          "Trois travées terminales réparties régulièrement dans le segment Giral déclaré ; frontière, portées et hauteur du profil non relevées.",
        );
    }
    if (!cutters.length) return null;
    let cutter = arena.keep(cad.Manifold.union(cutters));
    let solid = arena.keep(
      arena.keep(cad.Manifold.union(blocks)).subtract(cutter),
    );
    if (solid.status() !== "NoError" || solid.isEmpty()) return null;
    let boundarySupportCount = 0;
    const components = solid.decompose();
    for (const component of components) arena.keep(component);
    for (const component of components) {
      if (
        component.volume() <= 0.000001 ||
        component.boundingBox().min[2] <= foundationZ + 0.00001
      )
        continue;
      const projection = arena.keep(component.project());
      const bounds = component.boundingBox(),
        mid: Point2D = [
          (bounds.min[0] + bounds.max[0]) / 2,
          (bounds.min[1] + bounds.max[1]) / 2,
        ];
      let nearest = 0,
        best = Infinity;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i],
          b = path[i + 1],
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          t = Math.max(
            0,
            Math.min(
              1,
              ((mid[0] - a[0]) * dx + (mid[1] - a[1]) * dy) /
                (dx * dx + dy * dy),
            ),
          ),
          d = Math.hypot(mid[0] - a[0] - t * dx, mid[1] - a[1] - t * dy);
        if (d < best) {
          best = d;
          nearest = distances[i] + t * (distances[i + 1] - distances[i]);
        }
      }
      const st = station(nearest),
        points = projection.toPolygons().flat();
      let minimumAlong = Infinity;
      for (const point of points)
        minimumAlong = Math.min(
          minimumAlong,
          (point[0] - st.center[0]) * st.direction[0] +
            (point[1] - st.center[1]) * st.direction[1],
        );
      const center: Point2D = [
        st.center[0] + (minimumAlong + minimum / 2) * st.direction[0],
        st.center[1] + (minimumAlong + minimum / 2) * st.direction[1],
      ];
      const halfAcross = baseWidth + 1,
        halfAlong = minimum / 2;
      const corners: Point2D[] = [
        [-halfAlong, -halfAcross],
        [halfAlong, -halfAcross],
        [halfAlong, halfAcross],
        [-halfAlong, halfAcross],
      ].map(([along, across]) => [
        center[0] + along * st.direction[0] + across * st.normal[0],
        center[1] + along * st.direction[1] + across * st.normal[1],
      ]);
      const supportSection = arena.keep(
        arena
          .keep(new cad.CrossSection([corners], "NonZero"))
          .intersect(projection),
      );
      if (supportSection.isEmpty()) return null;
      const support = arena.keep(
        arena
          .keep(supportSection.extrude(deck - foundationZ + 0.005))
          .translate([0, 0, foundationZ - 0.005]),
      );
      solid = arena.keep(solid.add(support));
      cutter = arena.keep(cutter.subtract(support));
      boundarySupportCount++;
      modifiedForPrinting = true;
    }
    if (boundarySupportCount)
      assumptions.push(
        "Appuis d’impression ajoutés uniquement au bord des couronnes privées de leurs piles par la coupe de sélection.",
      );
    // Boolean cuts can leave edges far below the precision of exported buffers.
    // Collapse those numerical subdivisions before exposing either closed solid.
    solid = arena.keep(arena.keep(solid.setTolerance(0.0001)).simplify(0.0001));
    cutter = arena.keep(
      arena.keep(cutter.setTolerance(0.0001)).simplify(0.0001),
    );
    solid = arena.keep(
      new cad.Manifold(
        repairCollinear(cad, repairCoincident(cad, solid.getMesh())),
      ),
    );
    cutter = arena.keep(
      new cad.Manifold(
        repairCollinear(cad, repairCoincident(cad, cutter.getMesh())),
      ),
    );
    if (
      solid.status() !== "NoError" ||
      cutter.status() !== "NoError" ||
      solid.isEmpty()
    )
      return null;
    for (const handle of [solid, cutter, footprint]) {
      owner.keep(handle);
      outputs.add(handle);
    }
    return {
      solid,
      cutter,
      footprint,
      spanCount: largeSpanCount + smallSpanCount,
      largeSpanCount,
      smallSpanCount,
      boundarySupportCount,
      modifiedForPrinting,
      approximateGeometry: true,
      dimensions,
      assumptions,
    };
  } catch {
    return null;
  } finally {
    for (let i = handles.length - 1; i >= 0; i--)
      if (!outputs.has(handles[i])) handles[i].delete();
  }
}
