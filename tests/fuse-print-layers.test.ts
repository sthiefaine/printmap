import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module, { type Manifold } from "manifold-3d";
import {
  fusePrintLayers,
  preparePrintLayers,
} from "../src/lib/mesh/fuse-print-layers";
import { removeNumericalShells } from "../src/lib/mesh/retain-shells";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createProjectionForBbox } from "../src/lib/projection";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import {
  PRINT_LAYERS,
  type PrintInput,
  type PrintLayer,
  type PrintMesh,
} from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

function topAt(mesh: PrintMesh, x: number, y: number, layer?: number): number {
  let highest = -Infinity;
  for (let at = 0; at < mesh.indices.length; at += 3) {
    if (layer != null && mesh.faceLayers[at / 3] !== layer) continue;
    const p = [0, 1, 2].map((k) =>
      Array.from(
        mesh.positions.subarray(
          mesh.indices[at + k] * 3,
          mesh.indices[at + k] * 3 + 3,
        ),
      ),
    );
    const [a, b, c] = p;
    const determinant =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(determinant) < 1e-12) continue;
    const u =
      ((x - a[0]) * (c[1] - a[1]) - (y - a[1]) * (c[0] - a[0])) / determinant;
    const v =
      ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / determinant;
    if (u > -1e-8 && v > -1e-8 && u + v < 1 + 1e-8)
      highest = Math.max(highest, a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]));
  }
  return highest;
}

test("dense layer fusion bounds source ancestry without changing roof heights, palette or a negative cavity", async () => {
  const cad = await Module();
  cad.setup();
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
    },
  };
  const materials = new Map<number, PrintLayer>();
  const tag = (solid: Manifold, layer: PrintLayer) => {
    const original = owner.keep(solid.asOriginal());
    materials.set(original.originalID(), layer);
    return original;
  };
  try {
    const base = tag(owner.keep(cad.Manifold.cube([40, 32, 3])), "basePlate");
    const buildings = Array.from({ length: 256 }, (_, index) =>
      tag(
        owner.keep(
          owner
            .keep(cad.Manifold.cube([1.5, 1.5, 3 + (index % 4) / 8]))
            .translate([(index % 16) * 2, Math.floor(index / 16) * 2, 2.5]),
        ),
        "buildings",
      ),
    );
    const outer = owner.keep(
      owner.keep(cad.Manifold.cube([4, 4, 6])).translate([34, 0, 2.5]),
    );
    const inner = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 1])).translate([35, 1, 4]),
    );
    const hollow = tag(owner.keep(outer.subtract(inner)), "buildings");
    const road = tag(
      owner.keep(
        owner
          .keep(cad.Manifold.cube([40, 0.25, 0.2]))
          .translate([0, 31.5, 2.8]),
      ),
      "roads",
    );
    const detail = [...buildings, hollow, road];
    const untouchedPalette = new Map(materials);
    assert.equal(
      preparePrintLayers(
        cad,
        {
          keep: () => {
            throw new Error("A small site must allocate no new native handle");
          },
        },
        detail,
        materials,
      ),
      detail,
      "small scenes keep their exact input array, source handles and boolean order",
    );
    assert.deepEqual(materials, untouchedPalette);
    const expected = owner.keep(cad.Manifold.union([base, ...detail]));
    const fused = fusePrintLayers(cad, owner, detail, materials);
    assert.equal(fused.length, 2);
    assert.ok(
      fused.every((solid) => new Set(solid.getMesh().runOriginalID).size === 1),
      "each layer has one native source regardless of its building count",
    );
    const result = owner.keep(cad.Manifold.union([base, ...fused]));
    assert.equal(result.status(), "NoError");
    assert.ok(Math.abs(result.volume() - expected.volume()) < 1e-7);
    assert.deepEqual(result.boundingBox(), expected.boundingBox());
    assert.deepEqual(
      new Set(
        Array.from(result.getMesh().runOriginalID, (id) => materials.get(id)),
      ),
      new Set(["basePlate", "buildings", "roads"]),
    );
    assert.equal(
      owner.keep(result.intersect(inner)).volume(),
      0,
      "re-tagging the layer cannot fill its enclosed cavity",
    );
    for (const index of [0, 1, 2, 3, 255]) {
      const probe = owner.keep(
        owner
          .keep(cad.Manifold.cube([0.1, 0.1, 0.1]))
          .translate([
            (index % 16) * 2 + 0.5,
            Math.floor(index / 16) * 2 + 0.5,
            5.55 + (index % 4) / 8,
          ]),
      );
      assert.equal(
        owner.keep(result.intersect(probe)).volume(),
        0,
        "native grouping keeps the exact building tops",
      );
    }
    const sheets = Array.from({ length: 64 }, (_, i) =>
      owner.keep(
        owner
          .keep(cad.Manifold.cube([1, 1, 0.000001]))
          .translate([50 + (i % 8) * 2, Math.floor(i / 8) * 2, 0]),
      ),
    );
    const withSheets = owner.keep(cad.Manifold.union([result, ...sheets]));
    const cleaned = removeNumericalShells(
      cad,
      owner,
      withSheets,
      (shell) => Math.abs(shell.volume()) > 0.00001,
    );
    assert.ok(Math.abs(cleaned.volume() - result.volume()) < 1e-6);
    assert.equal(owner.keep(cleaned.intersect(inner)).volume(), 0);
    const components = cleaned.decompose();
    assert.equal(
      components.filter((component) => component.volume() < 0).length,
      1,
    );
    for (const component of components) component.delete();
    const mesh = cleaned.getMesh();
    assertClosedSolid({
      positions: mesh.vertProperties,
      indices: mesh.triVerts,
      faceLayers: new Uint8Array(mesh.triVerts.length / 3),
    });
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("real Saint-Étienne Expo halls retain IGN heights, colour layers and four closed tiles", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/saint-etienne-expo-lidar-layers.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Omit<PrintInput, "settings">;
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.grid = { cols: 2, rows: 2 };
  settings.base.topographyEnabled = false;
  const model = await buildPrintModel({ ...fixture, settings });
  const volume = assertClosedSolid(model);
  assert.equal(model.stats.buildingCount, 2);
  assert.equal(model.stats.estimatedHeights, 0);
  assert.equal(model.stats.components, 1);
  assert.ok(model.faceLayers.includes(PRINT_LAYERS.indexOf("roads")));
  const projection = createProjectionForBbox(fixture.bbox);
  const center = projection.project(
    (fixture.bbox[1] + fixture.bbox[3]) / 2,
    (fixture.bbox[0] + fixture.bbox[2]) / 2,
  );
  for (const element of fixture.osmData.elements.filter(
    (element) =>
      element.tags?.name === "Hall A" || element.tags?.name === "Hall B",
  )) {
    const points = element.geometry!.slice(0, -1);
    const x =
      points.reduce(
        (total, point) => total + projection.project(point.lon, point.lat)[0],
        0,
      ) / points.length;
    const y =
      points.reduce(
        (total, point) => total + projection.project(point.lon, point.lat)[1],
        0,
      ) / points.length;
    const expected =
      settings.base.basePlateThicknessMm +
      (Number(element.tags!.height) * 1000) / fixture.scale;
    assert.ok(
      Math.abs(
        topAt(
          model,
          ((x - center[0]) * 1000) / fixture.scale,
          ((y - center[1]) * 1000) / fixture.scale,
          PRINT_LAYERS.indexOf("buildings"),
        ) - expected,
      ) < 0.002,
      `${element.tags!.name} keeps the measured eave height`,
    );
  }
  assert.ok(
    Math.abs(
      model.tiles.reduce((sum, tile) => sum + assertClosedSolid(tile), 0) -
        volume,
    ) /
      volume <
      1e-4,
  );
  settings.base.topographyEnabled = true;
  const reliefModel = await buildPrintModel({ ...fixture, settings });
  const reliefVolume = assertClosedSolid(reliefModel);
  assert.equal(reliefModel.stats.buildingCount, 2);
  assert.equal(reliefModel.stats.components, 1);
  assert.ok(
    reliefModel.dimensions.heightMm > model.dimensions.heightMm,
    "the LiDAR datum and relief survive layer fusion",
  );
  assert.ok(
    Math.abs(
      reliefModel.tiles.reduce(
        (sum, tile) => sum + assertClosedSolid(tile),
        0,
      ) - reliefVolume,
    ) /
      reliefVolume <
      1e-4,
  );
});
