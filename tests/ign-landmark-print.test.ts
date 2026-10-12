import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import earcut from "earcut";
import {
  reconstructIGNRoof,
  type IGNRoofGrid,
} from "../src/lib/data/ign-roofs";
import { decimateIGNRoofGrid } from "../src/lib/data/ign-landmark-roofs";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import {
  SAINT_ETIENNE_STADIUM_BBOX,
  salonPrintLayouts,
  salonLayoutSettings,
} from "../src/lib/print-layout";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { PRINT_LAYERS, type PrintMesh } from "../src/types/print";
import type { OverpassElement, RoofSurface } from "../src/types/osm";
import { assertClosedSolid } from "./helpers/solid";

type Point = [number, number, number];
type Triangle = [Point, Point, Point];
const directory = new URL("./fixtures/", import.meta.url);
const fixture = JSON.parse(
  readFileSync(new URL("saint-etienne-landmark-roofs.json", directory), "utf8"),
) as {
  buildings: Array<{
    element: OverpassElement;
    grid: Omit<IGNRoofGrid, "mns" | "mnt"> & {
      mnsFile: string;
      mntFile: string;
    };
  }>;
};
const bil = (name: string) => {
  const bytes = readFileSync(new URL(name, directory));
  return Float32Array.from({ length: bytes.length / 4 }, (_, at) =>
    bytes.readFloatLE(at * 4),
  );
};
const entries: Array<{
  roof: NonNullable<ReturnType<typeof reconstructIGNRoof>>;
  element: OverpassElement;
}> = fixture.buildings.map(({ element, grid }) => {
  const sampled = decimateIGNRoofGrid({
    ...grid,
    mns: bil(grid.mnsFile),
    mnt: bil(grid.mntFile),
  });
  const roof = reconstructIGNRoof(element, sampled, undefined, undefined, {
    landmark: true,
  });
  assert.ok(roof);
  return {
    roof,
    element: {
      ...element,
      roofSurfaces: roof.surfaces,
      groundElevation: roof.groundElevation,
      roofSource: "IGN LiDAR HD · surface de toiture reconstruite",
      tags: {
        ...element.tags,
        height: String(roof.maxElevation - roof.groundElevation),
        "printmap:roof_reconstruction": "lidar",
        "printmap:roof_refinement": "landmark",
        "printmap:roof_resolution_m": "1",
        "printmap:roof_fit_tolerance_m": "0.47",
      },
    } satisfies OverpassElement,
  };
});
const projection = createProjectionForBbox(SAINT_ETIENNE_STADIUM_BBOX);
// This is the real area's IGN69 datum, used with a declared flat control DEM.
// It isolates the roof source and its small-scale clipping from city objects.
const datum = 473.57;
const sourcePoint = (
  point: { lon: number; lat: number; elevation: number },
  scale: number,
): Point => {
  const [x, y] = projection.project(point.lon, point.lat);
  return [
    (x * 1000) / scale,
    (y * 1000) / scale,
    DEFAULT_MODEL_SETTINGS.base.basePlateThicknessMm +
      ((point.elevation - datum) * 1000) / scale,
  ];
};
function panels(surfaces: RoofSurface[], scale: number): Triangle[] {
  return surfaces.flatMap((surface) => {
    const rings = [surface.outer, ...surface.holes].map((r) => r.slice(0, -1));
    const points = rings.flat().map((p) => sourcePoint(p, scale));
    let cursor = rings[0].length;
    const holes = rings.slice(1).map((r) => {
      const begin = cursor;
      cursor += r.length;
      return begin;
    });
    const origin = points[0];
    const indices = earcut(
      points.flatMap((p) => [p[0] - origin[0], p[1] - origin[1]]),
      holes,
    );
    const output: Triangle[] = [];
    for (let at = 0; at < indices.length; at += 3)
      output.push(
        indices.slice(at, at + 3).map((index) => points[index]) as Triangle,
      );
    return output;
  });
}
const area = ([a, b, c]: Triangle) =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
function tops(mesh: PrintMesh): Triangle[] {
  const output: Triangle[] = [];
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (PRINT_LAYERS[mesh.faceLayers[at / 3]] !== "buildings") continue;
    const triangle = Array.from(
      mesh.indices.subarray(at, at + 3),
      (index) =>
        Array.from(mesh.positions.subarray(index * 3, index * 3 + 3)) as Point,
    ) as Triangle;
    const [a, b, c] = triangle;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12)
      output.push(triangle);
  }
  return output;
}
function visibleHeight(triangles: Triangle[], x: number, y: number) {
  let z = -Infinity;
  for (const [a, b, c] of triangles) {
    const determinant =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(determinant) < 1e-12) continue;
    const u =
      ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v =
      ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
      z = Math.max(z, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return z;
}
for (const { roof, element } of entries)
  for (const layout of salonPrintLayouts(SAINT_ETIENNE_STADIUM_BBOX).filter(
    (layout) => layout.count === 2 || layout.count === 4,
  ))
    test(`real ${element.tags!.name} keeps its narrow tower and roof slopes on ${layout.count} salon plates`, async () => {
      const settings = salonLayoutSettings(DEFAULT_MODEL_SETTINGS, layout);
      const model = await buildPrintModel({
        bbox: SAINT_ETIENNE_STADIUM_BBOX,
        scale: layout.scale,
        settings,
        osmData: { elements: [element] },
        elevationGrid: {
          rows: 2,
          cols: 2,
          points: Array(4).fill(datum),
          minElev: datum,
          maxElev: datum,
          south: SAINT_ETIENNE_STADIUM_BBOX[0],
          west: SAINT_ETIENNE_STADIUM_BBOX[1],
          north: SAINT_ETIENNE_STADIUM_BBOX[2],
          east: SAINT_ETIENNE_STADIUM_BBOX[3],
          source:
            "IGN69 datum · declared synthetic flat control for monument print fidelity",
        },
      });
      assert.equal(
        model.stats.lidarRoofCount,
        1,
        "no block fallback loses the tower",
      );
      assert.equal(model.stats.buildingCount, 1);
      assert.equal(model.stats.components, 1);
      assert.equal(model.tiles.length, layout.count);
      assert.ok(
        !model.warnings.some((w) => /toiture LiDAR incompatibles/.test(w)),
      );
      const volume = assertClosedSolid(model);
      const tileVolume = model.tiles.reduce(
        (sum, tile) => sum + assertClosedSolid(tile),
        0,
      );
      assert.ok(Math.abs(tileVolume - volume) / volume < 0.0001);
      const source = panels(roof.surfaces, layout.scale);
      const faces = tops(model);
      const tiles = model.tiles.map((tile) => ({ tile, faces: tops(tile) }));
      const tolerance = (0.47 * 1000) / layout.scale;
      const expectedTop = sourcePoint(
        {
          lon: element.geometry![0].lon,
          lat: element.geometry![0].lat,
          elevation: roof.maxElevation,
        },
        layout.scale,
      )[2];
      const actualTop = Math.max(...faces.flatMap((t) => t.map((p) => p[2])));
      assert.ok(
        Math.abs(actualTop - expectedTop) <= tolerance,
        "the actual LiDAR tower height survives, rather than the old eave height",
      );
      let checked = 0;
      let minimum = Infinity,
        maximum = -Infinity;
      for (const triangle of source) {
        // Avoid source slivers where a 5-micron contact cut can move the probe
        // outside the printable face; all substantial native pans are sampled.
        if (area(triangle) < 0.0002) continue;
        const point = [0, 1, 2].map((axis) =>
          triangle.reduce((sum, p) => sum + p[axis] / 3, 0),
        ) as Point;
        const height = visibleHeight(faces, point[0], point[1]);
        assert.ok(
          Math.abs(height - point[2]) <= tolerance,
          `source pan ${checked}: print ${height}, original ${point[2]}`,
        );
        let containing = 0;
        for (const { tile, faces: tileFaces } of tiles) {
          const x0 = -layout.widthMm / 2 + tile.col * tile.widthMm;
          const y0 = -layout.heightMm / 2 + tile.row * tile.depthMm;
          if (
            point[0] < x0 ||
            point[0] > x0 + tile.widthMm ||
            point[1] < y0 ||
            point[1] > y0 + tile.depthMm
          )
            continue;
          const tileHeight = visibleHeight(
            tileFaces,
            point[0] - x0 - tile.widthMm / 2,
            point[1] - y0 - tile.depthMm / 2,
          );
          assert.ok(
            Math.abs(tileHeight - point[2]) <= tolerance,
            `source pan ${checked} remains visible in its tile`,
          );
          containing++;
        }
        assert.ok(containing > 0);
        minimum = Math.min(minimum, height);
        maximum = Math.max(maximum, height);
        checked++;
      }
      assert.ok(
        checked > 800,
        "hundreds of independently triangulated source pans are visible",
      );
      assert.ok(
        ((maximum - minimum) * layout.scale) / 1000 > 15,
        "the nave and tower retain their distinct heights",
      );
      const baseVolume =
        layout.widthMm * layout.heightMm * settings.base.basePlateThicknessMm;
      const sourceVolume = source.reduce(
        (sum, t) =>
          sum +
          area(t) *
            (t.reduce((height, p) => height + p[2] / 3, 0) -
              settings.base.basePlateThicknessMm),
        0,
      );
      const uncertainty =
        source.reduce((sum, t) => sum + area(t), 0) * tolerance;
      assert.ok(
        Math.abs(volume - baseVolume - sourceVolume) < uncertainty + 0.01,
        "printed building material agrees with source pans within the declared fit residual",
      );
    });
