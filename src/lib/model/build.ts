import Module, {
  type CrossSection,
  type Manifold,
  type ManifoldToplevel,
} from "manifold-3d";
import type { ElevationGrid, MapData } from "@/types/osm";
import { bboxDimensions } from "@/lib/data/bbox";
import { extractFeatures, type Line, type Poly, type Ring } from "./features";
import {
  centroid,
  defaultRoofHeightM,
  isConvex,
  orientedBox,
  roofFrame,
  roofHullPoints,
  type OrientedBox,
} from "./roofs";
import type { Roof } from "@/lib/osm/building-height";
import {
  computeLayout,
  tileLabel,
  type LayerId,
  type Layout,
  type ModelSettings,
} from "./settings";

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}
export interface TilePart extends MeshData {
  layer: LayerId;
}
export interface BuiltTile {
  col: number;
  /** Row 0 is the northern row, as on the assembly plan. */
  row: number;
  label: string;
  /** Position of the plate's south-west corner in the assembled model. */
  x0: number;
  y0: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  volumeMm3: number;
  /** One closed solid per colour, for multi-material 3MF and the preview. */
  parts: TilePart[];
  /** Everything fused into a single closed solid, for STL. */
  solid: MeshData;
  /** Preview only: thin silhouette of what is hollowed out underneath
   * (key pockets, plate number), which shading alone barely shows. */
  marks: MeshData | null;
}
export interface BuiltModel {
  layout: Layout;
  heightMm: number;
  tiles: BuiltTile[];
  /** Bow-tie keys to print once, pressed under the seams. */
  keys: (MeshData & { count: number; thicknessMm: number }) | null;
  stats: {
    buildings: number;
    /** Buildings given a sloped roof from OpenStreetMap tags. */
    roofs: number;
    estimatedHeights: number;
    triangles: number;
    volumeCm3: number;
    relief: boolean;
    reliefRangeM: number;
  };
  warnings: string[];
}
export interface BuildInput {
  data: MapData;
  settings: ModelSettings;
}
export type Progress = (fraction: number, label: string) => void;

let runtime: Promise<ManifoldToplevel> | undefined;
function getRuntime() {
  runtime ??= Module(
    typeof self === "undefined"
      ? undefined
      : { locateFile: () => "/manifold.wasm" },
  ).then((wasm) => {
    wasm.setup();
    return wasm;
  });
  return runtime;
}

/** Thickness of the coloured skin under roads, water and parks. */
const SKIN_MM = 0.6;
const MIN_BUILDING_MM = 0.6;
const LABEL_DEPTH_MM = 0.4;
/** Outline deviation allowed when removing vertices: invisible once printed. */
const TOLERANCE_MM = 0.05;
/** A roof lower than this once printed is not worth modelling. */
const MIN_ROOF_MM = 0.3;
/** Building tops snap to a usual layer height: fewer, larger solids to fuse. */
const HEIGHT_STEP_MM = 0.2;

function signedArea(ring: Ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return area / 2;
}
const oriented = (ring: Ring, ccw: boolean) =>
  signedArea(ring) > 0 === ccw ? ring : [...ring].reverse();

/** Outer rings counter-clockwise and holes clockwise: with the "Positive"
 * fill rule any number of overlapping polygons becomes their exact union. */
function pushPoly(contours: Ring[], poly: Poly) {
  contours.push(oriented(poly.outer, true));
  for (const hole of poly.holes) contours.push(oriented(hole, false));
}

function pushStroke(
  contours: Ring[],
  line: Line,
  halfWidth: number,
  width: number,
  depth: number,
) {
  const p = line.points;
  const cap: Ring = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 2 * Math.PI + Math.PI / 8;
    cap.push([Math.cos(a) * halfWidth, Math.sin(a) * halfWidth]);
  }
  const outside = (x: number, y: number) =>
    x < -halfWidth ||
    y < -halfWidth ||
    x > width + halfWidth ||
    y > depth + halfWidth;
  for (let i = 0; i < p.length; i++) {
    const [x, y] = p[i];
    if (!outside(x, y)) contours.push(cap.map(([cx, cy]) => [x + cx, y + cy]));
    if (i === 0) continue;
    const [ax, ay] = p[i - 1];
    if (
      (ax < -halfWidth && x < -halfWidth) ||
      (ay < -halfWidth && y < -halfWidth) ||
      (ax > width + halfWidth && x > width + halfWidth) ||
      (ay > depth + halfWidth && y > depth + halfWidth)
    )
      continue;
    const length = Math.hypot(x - ax, y - ay);
    if (length < 1e-6) continue;
    const nx = (-(y - ay) / length) * halfWidth,
      ny = ((x - ax) / length) * halfWidth;
    contours.push([
      [ax - nx, ay - ny],
      [x - nx, y - ny],
      [x + nx, y + ny],
      [ax + nx, ay + ny],
    ]);
  }
}

const DIGITS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgecd",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
  "-": "g",
};
/** Seven-segment text as rectangles, centred on (cx, cy) and mirrored so that
 * it reads correctly when the plate is turned over. */
function labelContours(text: string, cx: number, cy: number, h: number) {
  const w = h * 0.55,
    s = Math.max(0.9, h * 0.14),
    gap = w * 0.4;
  const total = text.length * w + (text.length - 1) * gap;
  const contours: Ring[] = [];
  [...text].forEach((char, index) => {
    const x0 = -total / 2 + index * (w + gap),
      y0 = -h / 2;
    const boxes: Record<string, [number, number, number, number]> = {
      a: [0, h - s, w, h],
      d: [0, 0, w, s],
      g: [0, h / 2 - s / 2, w, h / 2 + s / 2],
      f: [0, h / 2, s, h],
      b: [w - s, h / 2, w, h],
      e: [0, 0, s, h / 2],
      c: [w - s, 0, w, h / 2],
    };
    for (const segment of DIGITS[char] ?? "") {
      const [ax, ay, bx, by] = boxes[segment];
      // Mirror in X: turning the plate over swaps east and west.
      const l = cx - (x0 + bx),
        r = cx - (x0 + ax);
      contours.push([
        [l, cy + y0 + ay],
        [r, cy + y0 + ay],
        [r, cy + y0 + by],
        [l, cy + y0 + by],
      ]);
    }
  });
  return contours;
}

function sampleGrid(grid: ElevationGrid, u: number, v: number) {
  const x = Math.min(1, Math.max(0, u)) * (grid.cols - 1),
    y = Math.min(1, Math.max(0, v)) * (grid.rows - 1);
  const c = Math.min(grid.cols - 2, Math.floor(x)),
    r = Math.min(grid.rows - 2, Math.floor(y));
  const fx = x - c,
    fy = y - r,
    at = (rr: number, cc: number) => grid.points[rr * grid.cols + cc];
  return (
    at(r, c) * (1 - fx) * (1 - fy) +
    at(r, c + 1) * fx * (1 - fy) +
    at(r + 1, c) * (1 - fx) * fy +
    at(r + 1, c + 1) * fx * fy
  );
}

export async function buildModel(
  { data, settings }: BuildInput,
  onProgress: Progress = () => {},
): Promise<BuiltModel> {
  const wasm = await getRuntime();
  const { Manifold, CrossSection, Mesh } = wasm;
  const arena: { delete(): void }[] = [];
  const keep = <T extends { delete(): void }>(handle: T) => {
    arena.push(handle);
    return handle;
  };
  try {
    const warnings: string[] = [];
    const { widthM, heightM } = bboxDimensions(data.bbox);
    const layout = computeLayout(widthM, heightM, settings);
    const { widthMm: W, depthMm: D, mmPerM: k, cols, rows } = layout;
    const { tileWidthMm: tw, tileDepthMm: td } = layout;
    const multi = cols * rows > 1;
    const minFeature = Math.min(2, Math.max(0.3, settings.minFeatureMm));
    const base = Math.min(20, Math.max(1, settings.baseMm));

    onProgress(0.05, "Lecture des données");
    const features = extractFeatures(data.elements, data.bbox, k);
    const rect = keep(CrossSection.square([W, D]));
    const region = (contours: Ring[]): CrossSection | null => {
      if (!contours.length) return null;
      const clipped = keep(
        keep(new CrossSection(contours, "Positive")).intersect(rect),
      );
      return clipped.isEmpty() ? null : clipped;
    };
    /** Drop slivers the nozzle cannot draw, then remove needless vertices. */
    const printable = (shape: CrossSection | null) => {
      if (!shape) return null;
      const opened = keep(
        keep(
          keep(shape.offset(-minFeature / 2, "Round", 2, 8)).offset(
            minFeature / 2,
            "Round",
            2,
            8,
          ),
        ).simplify(TOLERANCE_MM),
      );
      return opened.isEmpty() ? null : opened;
    };

    // ── Ground ────────────────────────────────────────────────────────────
    const grid = settings.relief ? data.elevation : null;
    const reliefRangeM = grid ? grid.maxElev - grid.minElev : 0;
    const reliefGain = k * Math.min(5, Math.max(0.2, settings.reliefScale));
    const relief = !!grid && reliefRangeM * reliefGain >= 0.2;
    if (settings.relief && !data.elevation)
      warnings.push("Relief indisponible pour cette zone : socle plat.");
    else if (settings.relief && !relief)
      warnings.push(
        "Terrain presque plat à cette échelle : le socle reste plat.",
      );
    // The mesh never needs to be finer than the elevation samples it shows.
    const cells = (source: number, side: number) =>
      Math.max(8, Math.min(source - 1, 100, Math.round(side / 1.5)));
    const nx = relief ? cells(grid!.cols, W) : 1,
      ny = relief ? cells(grid!.rows, D) : 1;
    const ground = new Float32Array((nx + 1) * (ny + 1));
    let groundMax = 0;
    if (relief)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) {
          const h =
            (sampleGrid(grid!, i / nx, j / ny) - grid!.minElev) * reliefGain;
          ground[j * (nx + 1) + i] = h;
          groundMax = Math.max(groundMax, h);
        }
    const groundAt = (x: number, y: number) => {
      if (!relief) return 0;
      const gx = Math.min(nx, Math.max(0, (x / W) * nx)),
        gy = Math.min(ny, Math.max(0, (y / D) * ny));
      const i = Math.min(nx - 1, Math.floor(gx)),
        j = Math.min(ny - 1, Math.floor(gy));
      const fx = gx - i,
        fy = gy - j,
        at = (jj: number, ii: number) => ground[jj * (nx + 1) + ii];
      return (
        at(j, i) * (1 - fx) * (1 - fy) +
        at(j, i + 1) * fx * (1 - fy) +
        at(j + 1, i) * (1 - fx) * fy +
        at(j + 1, i + 1) * fx * fy
      );
    };
    /** The ground solid with its top surface shifted vertically by `offset`. */
    const terrain = (offset: number): Manifold => {
      if (!relief) return keep(Manifold.cube([W, D, base + offset]));
      const top = (nx + 1) * (ny + 1);
      const ringIds: number[] = [];
      for (let i = 0; i < nx; i++) ringIds.push(i);
      for (let j = 0; j < ny; j++) ringIds.push(j * (nx + 1) + nx);
      for (let i = nx; i > 0; i--) ringIds.push(ny * (nx + 1) + i);
      for (let j = ny; j > 0; j--) ringIds.push(j * (nx + 1));
      const positions = new Float32Array((top + ringIds.length + 1) * 3);
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) {
          const v = j * (nx + 1) + i;
          positions[v * 3] = (i / nx) * W;
          positions[v * 3 + 1] = (j / ny) * D;
          positions[v * 3 + 2] = base + ground[v] + offset;
        }
      ringIds.forEach((v, n) => {
        positions[(top + n) * 3] = positions[v * 3];
        positions[(top + n) * 3 + 1] = positions[v * 3 + 1];
      });
      const centre = top + ringIds.length;
      positions[centre * 3] = W / 2;
      positions[centre * 3 + 1] = D / 2;
      const tris: number[] = [];
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const a = j * (nx + 1) + i,
            b = a + 1,
            c = a + nx + 2,
            d = a + nx + 1;
          tris.push(a, b, c, a, c, d);
        }
      ringIds.forEach((ta, n) => {
        const m = (n + 1) % ringIds.length,
          tb = ringIds[m],
          ba = top + n,
          bb = top + m;
        tris.push(ba, bb, tb, ba, tb, ta, centre, bb, ba);
      });
      const mesh = new Mesh({
        numProp: 3,
        vertProperties: positions,
        triVerts: new Uint32Array(tris),
      });
      return keep(new Manifold(mesh));
    };

    // ── Buildings ─────────────────────────────────────────────────────────
    onProgress(0.15, "Bâtiments");
    let buildingCount = 0,
      roofCount = 0,
      estimatedHeights = 0,
      tallest = 0;
    let footprints: CrossSection | null = null;
    let buildings: Manifold | null = null;
    if (settings.buildings && features.buildings.length) {
      const bounds = (ring: Ring) => {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (const [x, y] of ring) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
        return [x0, y0, x1, y1];
      };
      // A building outline mostly covered by detailed 3D parts is redundant
      // and would bury them under a single block.
      const partContours: Ring[] = [];
      const partBounds: number[][] = [];
      for (const b of features.buildings)
        if (b.part) {
          pushPoly(partContours, b.poly);
          partBounds.push(bounds(b.poly.outer));
        }
      const parts = partContours.length
        ? keep(new CrossSection(partContours, "Positive"))
        : null;
      const scale = Math.min(5, Math.max(0.2, settings.buildingScale));
      const groups = new Map<number, Ring[]>();
      const roofJobs: Array<{
        poly: Poly;
        roof: Roof;
        box: OrientedBox;
        /** Top of the walls above the base, as snapped for their group. */
        top: number;
        height: number;
      }> = [];
      for (const b of features.buildings) {
        const [x0, y0, x1, y1] = bounds(b.poly.outer);
        if (x1 < 0 || y1 < 0 || x0 > W || y0 > D) continue;
        const area =
          Math.abs(signedArea(b.poly.outer)) -
          b.poly.holes.reduce((sum, h) => sum + Math.abs(signedArea(h)), 0);
        if (area < 0.05) continue;
        if (
          !b.part &&
          parts &&
          partBounds.some(
            (p) => p[0] < x1 && p[2] > x0 && p[1] < y1 && p[3] > y0,
          )
        ) {
          const own: Ring[] = [];
          pushPoly(own, b.poly);
          const shape = keep(new CrossSection(own, "Positive"));
          const covered = keep(shape.intersect(parts)).area();
          if (covered > 0.7 * shape.area()) continue;
        }
        // Walls and roof: an OSM height reaches the roof top, an IGN height
        // stops at the gutter, an estimate only describes the walls.
        let wallM = b.heightM,
          roofMm = 0,
          box: OrientedBox | null = null;
        if (settings.roofs && b.roof) {
          box = orientedBox(b.poly.outer);
          let roofM =
            b.roof.heightM ?? defaultRoofHeightM(b.roof.shape, (2 * box.b) / k);
          if (b.eaveM != null) wallM = b.eaveM;
          else if (b.includesRoof) {
            roofM = Math.min(roofM, b.heightM * 0.6);
            wallM = b.heightM - roofM;
          }
          roofMm = roofM * k * scale;
          // Too low to show, or too narrow for its walls to be sure to
          // survive the nozzle-width clean-up: keep a plain block.
          if (roofMm < MIN_ROOF_MM || 2 * box.b < 1.25 * minFeature) {
            roofMm = 0;
            wallM = b.heightM;
          }
        }
        const height = Math.max(MIN_BUILDING_MM, wallM * k * scale);
        let top = height;
        if (relief) {
          let sum = 0,
            highest = 0;
          for (const [x, y] of b.poly.outer) {
            const g = groundAt(x, y);
            sum += g;
            highest = Math.max(highest, g);
          }
          top = Math.max(
            sum / b.poly.outer.length + height,
            highest + MIN_BUILDING_MM,
          );
        }
        const key = Math.round(top / HEIGHT_STEP_MM);
        let contours = groups.get(key);
        if (!contours) groups.set(key, (contours = []));
        pushPoly(contours, b.poly);
        if (roofMm && box)
          roofJobs.push({
            poly: b.poly,
            roof: b.roof!,
            box,
            top: key * HEIGHT_STEP_MM,
            height: roofMm,
          });
        buildingCount++;
        if (b.estimated) estimatedHeights++;
      }
      // A tiny building inside a block prints as part of that block; only
      // what stays thinner than the nozzle once everything is merged is lost.
      const raw: Array<[number, CrossSection]> = [];
      for (const [key, contours] of groups) {
        const clipped = region(contours);
        if (clipped) raw.push([key * HEIGHT_STEP_MM, clipped]);
      }
      const merged = raw.length
        ? keep(CrossSection.union(raw.map(([, shape]) => shape)))
        : null;
      footprints = printable(merged);
      const solids: Manifold[] = [];
      if (footprints && merged) {
        // Subtracting the few unprintable slivers is far cheaper than
        // intersecting every height group with the whole city.
        const slivers = keep(merged.subtract(footprints));
        for (const [top, clipped] of raw) {
          const shape = keep(
            (slivers.isEmpty()
              ? clipped
              : keep(clipped.subtract(slivers))
            ).simplify(TOLERANCE_MM),
          );
          if (shape.isEmpty()) continue;
          tallest = Math.max(tallest, top);
          solids.push(
            relief
              ? keep(shape.extrude(base + top))
              : keep(keep(shape.extrude(top)).translate(0, 0, base)),
          );
        }
        // Each roof is a convex volume over the footprint's bounding box,
        // trimmed to the footprint: closed whatever the outline looks like.
        for (const job of roofJobs) {
          const own: Ring[] = [];
          pushPoly(own, job.poly);
          const shape = region(own);
          if (!shape) continue;
          const h = job.height;
          const outer = job.poly.outer;
          const whole =
            !job.poly.holes.length &&
            shape.area() > 0.98 * Math.abs(signedArea(outer));
          let solid: Manifold;
          if (
            (job.roof.shape === "cone" || job.roof.shape === "pyramidal") &&
            whole &&
            isConvex(outer)
          ) {
            // Every side rises to a point above the centre, as on a turret.
            const [gx, gy] = centroid(outer);
            solid = keep(
              keep(
                keep(shape.translate(-gx, -gy)).extrude(h, 0, 0, [0, 0]),
              ).translate(gx, gy, 0),
            );
          } else {
            const frame = roofFrame(job.box, job.roof);
            const points = roofHullPoints(
              frame,
              job.roof.shape === "cone" ? "pyramidal" : job.roof.shape,
              h,
            );
            const volume = points
              ? keep(Manifold.hull(points))
              : keep(
                  keep(
                    keep(
                      keep(Manifold.sphere(1, 32)).scale([
                        frame.ar,
                        frame.bs,
                        h,
                      ]),
                    ).rotate(
                      0,
                      0,
                      (Math.atan2(frame.ry, frame.rx) * 180) / Math.PI,
                    ),
                  ).translate(frame.cx, frame.cy, 0),
                );
            solid = keep(volume.intersect(keep(shape.extrude(h))));
          }
          if (solid.isEmpty()) continue;
          solids.push(keep(solid.translate(0, 0, base + job.top)));
          tallest = Math.max(tallest, job.top + h);
          roofCount++;
        }
      }
      if (solids.length) {
        const fused = keep(Manifold.union(solids));
        buildings = relief ? keep(fused.subtract(terrain(0))) : fused;
      } else footprints = null;
    }

    // ── Flat layers: roads over water over greenery, never under buildings ──
    onProgress(0.4, "Routes, eau et espaces verts");
    // Material kept between the bed and the lowest coloured skin: enough for
    // the key pockets when the model is cut into plates.
    const pocketDepth = Math.min(1.6, Math.max(0.8, base - 1.6));
    const wantPockets = multi && settings.connectors && base >= 2.4;
    if (multi && settings.connectors && !wantPockets)
      warnings.push(
        "Socle trop fin pour les clés d’assemblage : il faut au moins 2,4 mm.",
      );
    const floor = wantPockets ? pocketDepth + 0.4 : 0.6;
    const lowest = -(base - floor - 0.2);
    let taken = footprints;
    const claim = (contours: Ring[]) => {
      let shape = region(contours);
      if (shape && taken) shape = keep(shape.subtract(taken));
      shape = printable(shape);
      if (shape) taken = taken ? keep(taken.add(shape)) : shape;
      return shape;
    };
    const roadContours: Ring[] = [];
    if (settings.roads) {
      const levels =
        settings.roadLevel === "major"
          ? ["major"]
          : settings.roadLevel === "streets"
            ? ["major", "streets"]
            : ["major", "streets", "all"];
      const widthScale = Math.min(4, Math.max(0.3, settings.roadWidthScale));
      for (const road of features.roads)
        if (levels.includes(road.level))
          pushStroke(
            roadContours,
            road,
            Math.max(minFeature, road.widthM * k * widthScale) / 2,
            W,
            D,
          );
      for (const area of features.roadAreas) pushPoly(roadContours, area);
    }
    const waterContours: Ring[] = [];
    if (settings.water) {
      for (const area of features.waterAreas) pushPoly(waterContours, area);
      for (const line of features.waterLines)
        pushStroke(
          waterContours,
          line,
          Math.max(minFeature, line.widthM * k) / 2,
          W,
          D,
        );
    }
    const greenContours: Ring[] = [];
    if (settings.green)
      for (const area of features.green) pushPoly(greenContours, area);
    const flatLayers: Array<[LayerId, CrossSection | null, number]> = [
      ["roads", claim(roadContours), settings.roadOffsetMm],
      ["water", claim(waterContours), settings.waterOffsetMm],
      ["green", claim(greenContours), settings.greenOffsetMm],
    ];

    onProgress(0.55, "Socle");
    const parts: Array<[LayerId, Manifold]> = [];
    const cutters: Manifold[] = [];
    const reach = base + groundMax + 4;
    for (const [layer, shape, wanted] of flatLayers) {
      if (!shape) continue;
      const top = Math.min(2, Math.max(lowest, wanted));
      const bottom = Math.max(Math.min(top, 0) - SKIN_MM, -(base - floor));
      if (top - bottom < 0.15) continue;
      if (relief) {
        const above = keep(
          keep(shape.extrude(reach)).subtract(terrain(bottom)),
        );
        cutters.push(above);
        parts.push([layer, keep(above.intersect(terrain(top)))]);
      } else {
        cutters.push(
          keep(keep(shape.extrude(reach)).translate(0, 0, base + bottom)),
        );
        parts.push([
          layer,
          keep(
            keep(shape.extrude(top - bottom)).translate(0, 0, base + bottom),
          ),
        ]);
      }
    }
    let baseSolid = terrain(0);
    if (cutters.length)
      baseSolid = keep(baseSolid.subtract(keep(Manifold.union(cutters))));

    // ── Assembly helpers under the plates ─────────────────────────────────
    let keys: BuiltModel["keys"] = null;
    if (multi) {
      const size = Math.min(1, Math.max(0.5, Math.min(tw, td) / 45));
      const L = 7 * size,
        waist = 2.5 * size,
        end = 4.5 * size;
      const bowTie = (cx: number, cy: number, vertical: boolean): Ring =>
        (
          [
            [-L, -end],
            [0, -waist],
            [L, -end],
            [L, end],
            [0, waist],
            [-L, end],
          ] as Ring
        ).map(([x, y]) => (vertical ? [cx - y, cy + x] : [cx + x, cy + y]));
      const under: Manifold[] = [];
      if (wantPockets) {
        const spots: Ring[] = [];
        const along = (length: number) =>
          length >= 100 ? [0.25, 0.75] : [0.5];
        for (let c = 1; c < cols; c++)
          for (let r = 0; r < rows; r++)
            for (const f of along(td))
              spots.push(bowTie(c * tw, (r + f) * td, false));
        for (let r = 1; r < rows; r++)
          for (let c = 0; c < cols; c++)
            for (const f of along(tw))
              spots.push(bowTie((c + f) * tw, r * td, true));
        const pockets = keep(
          keep(new CrossSection(spots, "Positive")).offset(0.15, "Round", 2, 8),
        );
        under.push(keep(pockets.extrude(pocketDepth)));
        const thickness = pocketDepth - 0.2,
          count = spots.length + 2,
          perRow = Math.ceil(Math.sqrt(count));
        const keyShapes: Ring[] = [];
        for (let n = 0; n < count; n++)
          keyShapes.push(
            bowTie(
              L + (n % perRow) * (2 * L + 3),
              end + Math.floor(n / perRow) * (2 * end + 3),
              false,
            ),
          );
        const keySolid = keep(
          keep(new CrossSection(keyShapes, "Positive")).extrude(thickness),
        );
        keys = { ...toMesh(keySolid), count, thicknessMm: thickness };
      }
      if (settings.labels && base >= 1.4 && Math.min(tw, td) >= 30) {
        const text: Ring[] = [];
        const h = Math.min(10, Math.max(5, Math.min(tw, td) * 0.12));
        for (let c = 0; c < cols; c++)
          for (let r = 0; r < rows; r++)
            text.push(
              ...labelContours(
                tileLabel(c, r),
                (c + 0.5) * tw,
                D - (r + 0.5) * td,
                h,
              ),
            );
        under.push(
          keep(keep(new CrossSection(text, "NonZero")).extrude(LABEL_DEPTH_MM)),
        );
      }
      if (under.length)
        baseSolid = keep(baseSolid.subtract(keep(Manifold.union(under))));
    }
    parts.unshift(["base", baseSolid]);
    if (buildings && !buildings.isEmpty()) parts.push(["buildings", buildings]);

    onProgress(0.7, "Fusion en un solide imprimable");
    const whole = keep(Manifold.union(parts.map(([, solid]) => solid)));
    if (whole.isEmpty() || whole.status() !== "NoError")
      throw new Error("Le solide n’a pas pu être construit pour cette zone.");

    // ── Cut into plates ───────────────────────────────────────────────────
    onProgress(0.8, multi ? "Découpe en plaques" : "Finalisation");
    const split = (solid: Manifold, axis: 0 | 1, cuts: number[]) => {
      const pieces: Manifold[] = [];
      let rest = solid;
      for (const cut of cuts) {
        const [high, low] = rest.splitByPlane(
          axis ? [0, 1, 0] : [1, 0, 0],
          cut,
        );
        pieces.push(keep(low));
        rest = keep(high);
      }
      pieces.push(rest);
      return pieces;
    };
    const xCuts = Array.from({ length: cols - 1 }, (_, i) => (i + 1) * tw);
    const yCuts = Array.from({ length: rows - 1 }, (_, i) => (i + 1) * td);
    /** [col][rowFromSouth] */
    const dice = (solid: Manifold) =>
      split(solid, 0, xCuts).map((column) => split(column, 1, yCuts));
    const wholeDiced = dice(whole);
    const partsDiced = parts.map(
      ([layer, solid]) => [layer, dice(solid)] as const,
    );
    const tiles: BuiltTile[] = [];
    let triangles = 0,
      heightMm = 0;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const south = rows - 1 - r,
          x0 = c * tw,
          y0 = south * td;
        const local = (solid: Manifold) => keep(solid.translate(-x0, -y0, 0));
        const solid = local(wholeDiced[c][south]);
        let marks: MeshData | null = null;
        if (multi) {
          const hollow = keep(
            keep(CrossSection.square([tw, td])).subtract(
              keep(solid.slice(0.2)),
            ),
          );
          if (!hollow.isEmpty())
            marks = toMesh(
              keep(keep(hollow.extrude(0.05)).translate(0, 0, -0.1)),
            );
        }
        const box = solid.boundingBox();
        const mesh = toMesh(solid);
        triangles += mesh.indices.length / 3;
        heightMm = Math.max(heightMm, box.max[2]);
        tiles.push({
          col: c,
          row: r,
          label: tileLabel(c, r),
          x0,
          y0,
          widthMm: tw,
          depthMm: td,
          heightMm: box.max[2],
          volumeMm3: solid.volume(),
          solid: mesh,
          marks,
          parts: partsDiced.flatMap(([layer, diced]) => {
            const piece = diced[c][south];
            return piece.isEmpty() ? [] : [{ layer, ...toMesh(local(piece)) }];
          }),
        });
      }
    if (estimatedHeights > buildingCount * 0.5 && buildingCount > 20)
      warnings.push(
        "Plus de la moitié des hauteurs de bâtiments sont estimées : les données de hauteur sont rares dans cette zone.",
      );
    onProgress(1, "Terminé");
    return {
      layout,
      heightMm,
      tiles,
      keys,
      stats: {
        buildings: buildingCount,
        roofs: roofCount,
        estimatedHeights,
        triangles,
        volumeCm3: whole.volume() / 1000,
        relief,
        reliefRangeM,
      },
      warnings,
    };
  } finally {
    for (const handle of arena)
      try {
        handle.delete();
      } catch {
        // Already released together with its parent.
      }
  }
}

function toMesh(solid: Manifold): MeshData {
  const mesh = solid.getMesh();
  const { numProp, vertProperties, triVerts } = mesh;
  if (numProp === 3)
    return {
      positions: new Float32Array(vertProperties),
      indices: new Uint32Array(triVerts),
    };
  const count = vertProperties.length / numProp;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++)
    positions.set(vertProperties.subarray(i * numProp, i * numProp + 3), i * 3);
  return { positions, indices: new Uint32Array(triVerts) };
}
