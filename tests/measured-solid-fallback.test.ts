import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import earcut from "earcut";
import Module, { type ManifoldToplevel, type Vec3 } from "manifold-3d";
import {
  makeMeasuredRoofFallbackFootprint,
  makeMeasuredSolid,
} from "../src/lib/mesh/measured-solid";
import { makeMeasuredRoof } from "../src/lib/mesh/roof-solid";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import type { MeasuredSolid } from "../src/types/osm";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintMesh,
} from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/montpellier-polygone-roof-fallback.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Omit<PrintInput, "settings">;
const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});
const point = (lon: number, lat: number, elevation = 110) => ({
  lon,
  lat,
  elevation,
});
function owner() {
  const handles: { delete(): void }[] = [];
  return {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
    dispose() {
      for (const handle of handles.reverse()) handle.delete();
    },
  };
}

test("surveyed fallback footprints keep courtyards and the selection boundary", async () => {
  const cad = await runtime;
  const arena = owner();
  try {
    const outer = [point(-5, -5), point(5, -5), point(5, 5), point(-5, 5)];
    const hole = [point(-1, -1), point(1, -1), point(1, 1), point(-1, 1)];
    const data: MeasuredSolid = {
      source: "Surveyed rings",
      year: 2020,
      surfaces: [
        { kind: "roof", outer, holes: [hole] },
        {
          kind: "ground",
          outer: outer.map((p) => ({ ...p, elevation: 100 })),
          holes: [hole.map((p) => ({ ...p, elevation: 100 }))],
        },
      ],
    };
    const clip = arena.keep(cad.CrossSection.square([8, 8], true));
    const footprint = makeMeasuredRoofFallbackFootprint(cad, arena, data, {
      project: (lon, lat) => [lon, lat],
      scaleFactor: 1,
      clip,
    })!;
    assert.ok(footprint);
    assert.ok(Math.abs(footprint.area() - 60) < 0.000001);
    const courtyard = arena.keep(cad.CrossSection.square([1, 1], true));
    assert.equal(arena.keep(footprint.intersect(courtyard)).isEmpty(), true);
    const roof = makeMeasuredRoof(
      cad,
      arena,
      [data.surfaces[0]],
      100,
      (lon, lat) => [lon, lat],
      1,
      1,
      3,
      2.7,
      footprint,
      0.6,
    )!;
    assert.ok(roof);
    const voidProbe = arena.keep(
      arena.keep(cad.Manifold.cube([1, 1, 6])).translate([-0.5, -0.5, 3.5]),
    );
    assert.equal(arena.keep(roof.intersect(voidProbe)).isEmpty(), true);
    const invalid = structuredClone(data);
    invalid.surfaces[0].outer[0].lon = NaN;
    assert.equal(
      makeMeasuredRoofFallbackFootprint(cad, arena, invalid, {
        project: (lon, lat) => [lon, lat],
        scaleFactor: 1,
        clip,
      }),
      null,
    );
  } finally {
    arena.dispose();
  }
});

test("surveyed ground coverage still rejects a genuinely missing roof", async () => {
  const cad = await runtime;
  const arena = owner();
  try {
    const ground = {
      kind: "ground" as const,
      outer: [
        point(0, 0, 100),
        point(10, 0, 100),
        point(10, 10, 100),
        point(0, 10, 100),
      ],
      holes: [],
    };
    const roof = {
      kind: "roof" as const,
      outer: [point(0, 0), point(5, 0), point(5, 10), point(0, 10)],
      holes: [],
    };
    const clip = arena.keep(cad.CrossSection.square([40, 40], true));
    const footprint = makeMeasuredRoofFallbackFootprint(
      cad,
      arena,
      {
        surfaces: [ground, roof],
        source: "Incomplete surveyed roof",
        year: 2020,
      },
      { project: (lon, lat) => [lon, lat], scaleFactor: 1, clip },
    )!;
    assert.ok(footprint);
    assert.ok(Math.abs(footprint.area() - 100) < 0.000001);
    assert.equal(
      makeMeasuredRoof(
        cad,
        arena,
        [roof],
        100,
        (lon, lat) => [lon, lat],
        1,
        1,
        3,
        2.7,
        footprint,
        0.6,
      ),
      null,
      "the unchanged 98% coverage guard applies to actual ground contacts",
    );
  } finally {
    arena.dispose();
  }
});

function heightAt(triangles: Vec3[][], x: number, y: number) {
  let height = -Infinity;
  for (const [a, b, c] of triangles) {
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(det) < 1e-9) continue;
    const wb = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / det;
    const wc = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
    const wa = 1 - wb - wc;
    if (Math.min(wa, wb, wc) >= -1e-8)
      height = Math.max(height, wa * a[2] + wb * b[2] + wc * c[2]);
  }
  return height;
}
function buildingTriangles(mesh: PrintMesh): Vec3[][] {
  const triangles: Vec3[][] = [];
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (mesh.faceLayers[at / 3] !== PRINT_LAYERS.indexOf("buildings")) continue;
    triangles.push(
      Array.from(
        mesh.indices.subarray(at, at + 3),
        (index) =>
          [
            mesh.positions[index * 3],
            mesh.positions[index * 3 + 1],
            mesh.positions[index * 3 + 2],
          ] as Vec3,
      ),
    );
  }
  return triangles;
}
function sourceTriangles(element: PrintInput["osmData"]["elements"][number]) {
  const projection = createProjectionForBbox(fixture.bbox);
  const sf = 1000 / fixture.scale;
  const triangles: Vec3[][] = [];
  for (const surface of element.roofSurfaces!) {
    const rings = [surface.outer, ...surface.holes];
    const points = rings.flat().map((p) => {
      const [x, y] = projection.project(p.lon, p.lat);
      return [
        x * sf,
        y * sf,
        3 + (p.elevation - fixture.elevationGrid!.minElev) * sf,
      ] as Vec3;
    });
    const holes: number[] = [];
    let offset = rings[0].length;
    for (const ring of rings.slice(1)) {
      holes.push(offset);
      offset += ring.length;
    }
    const indices = earcut(
      points.flatMap(([x, y]) => [x, y]),
      holes,
      2,
    );
    for (let at = 0; at < indices.length; at += 3)
      triangles.push(indices.slice(at, at + 3).map((index) => points[index]));
  }
  return triangles;
}

for (const id of ["B106856", "B106853"])
  test(`${id}: invalid municipal shell retains surveyed multilevel roofs and closed tiles`, async () => {
    const cad: ManifoldToplevel = await runtime;
    const arena = owner();
    try {
      const element = fixture.osmData.elements.find(
        (item) => item.tags?.["printmap:source_id"] === `MMM/${id}`,
      )!;
      assert.ok(element.measuredSolid && element.roofSurfaces);
      const projection = createProjectionForBbox(fixture.bbox);
      const sf = 1000 / fixture.scale;
      const clip = arena.keep(cad.CrossSection.square([220, 100], true));
      assert.equal(
        makeMeasuredSolid(cad, arena, element.measuredSolid!, {
          project: projection.project,
          groundElevation: element.groundElevation!,
          scaleFactor: sf,
          buildingScale: 1,
          surfaceZ:
            3 +
            (element.groundElevation! - fixture.elevationGrid!.minElev) * sf,
          foundationZ: 2.7,
          minimumHeight: 0.6,
          clip,
        }),
        null,
        "source closure guards still reject the actual invalid architectural shell",
      );
      const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
      settings.base.topographyEnabled = true;
      settings.base.grid = { rows: 2, cols: 2 };
      const model = await buildPrintModel({
        ...fixture,
        osmData: { elements: [element] },
        settings,
      });
      assert.equal(model.stats.buildingCount, 1);
      assert.equal(model.stats.realRoofCount, 1);
      assert.equal(model.stats.measuredStructureCount, 0);
      assert.equal(model.stats.components, 1);
      assert.equal(model.stats.discardedFeatures, 0);
      assert.match(
        model.warnings.join(" "),
        /ouvertures et dessous ne sont pas reproduits/,
      );
      assert.doesNotMatch(model.warnings.join(" "), /toiture.*incomplète/);
      assertClosedSolid(model);
      assert.equal(model.tiles.length, 4);
      const sum = model.tiles.reduce(
        (total, tile) => total + assertClosedSolid(tile),
        0,
      );
      assert.ok(
        Math.abs(sum - model.stats.volumeMm3) < model.stats.volumeMm3 * 0.0001,
      );

      const original = sourceTriangles(element);
      const printed = buildingTriangles(model);
      const probes = new Map<
        number,
        { area: number; x: number; y: number; z: number }
      >();
      for (const [a, b, c] of original) {
        const area =
          Math.abs(
            (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]),
          ) / 2;
        if (area < 0.01) continue;
        const x = (a[0] + b[0] + c[0]) / 3;
        const y = (a[1] + b[1] + c[1]) / 3;
        const z = (a[2] + b[2] + c[2]) / 3;
        if (Math.abs(heightAt(original, x, y) - z) > 0.00001) continue;
        const key = Math.round(z * 10);
        if (area > (probes.get(key)?.area ?? 0))
          probes.set(key, { area, x, y, z });
      }
      const levels = [...probes.values()].sort((a, b) => a.z - b.z);
      assert.ok(
        levels.length >= 4,
        "at least four genuine visible roof levels are tested",
      );
      assert.ok(
        levels.at(-1)!.z - levels[0].z > 0.5,
        "the result retains a multilevel silhouette",
      );
      let minX = Infinity,
        minY = Infinity;
      for (let at = 0; at < model.positions.length; at += 3) {
        minX = Math.min(minX, model.positions[at]);
        minY = Math.min(minY, model.positions[at + 1]);
      }
      const tileSurfaces = model.tiles.map((tile) => ({
        tile,
        triangles: buildingTriangles(tile),
      }));
      for (const probe of levels) {
        const z = heightAt(printed, probe.x, probe.y);
        assert.ok(
          Math.abs(z - probe.z) < 0.03,
          `surveyed roof ${probe.z.toFixed(5)} mm at (${probe.x},${probe.y}) stays at ${z.toFixed(5)} mm`,
        );
        for (const { tile, triangles } of tileSurfaces) {
          const x0 = minX + tile.col * tile.widthMm,
            y0 = minY + tile.row * tile.depthMm;
          if (
            probe.x < x0 ||
            probe.x > x0 + tile.widthMm ||
            probe.y < y0 ||
            probe.y > y0 + tile.depthMm
          )
            continue;
          const tileZ = heightAt(
            triangles,
            probe.x - x0 - tile.widthMm / 2,
            probe.y - y0 - tile.depthMm / 2,
          );
          assert.ok(
            Math.abs(tileZ - probe.z) < 0.03,
            `tile (${tile.col},${tile.row}) keeps surveyed roof ${probe.z.toFixed(5)} mm at ${tileZ.toFixed(5)} mm`,
          );
        }
      }
    } finally {
      arena.dispose();
    }
  });
