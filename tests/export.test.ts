import test, { before } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { createSTLBuffer } from "../src/lib/export/stl-export";
import { create3MFBuffer } from "../src/lib/export/threemf-export";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import { createDemoData, DEMO_BBOX } from "../src/lib/demo";
import type { PrintMesh, PrintModel } from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

let model: PrintModel;
before(async () => {
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.grid = { cols: 2, rows: 1 };
  settings.features.water.color = "#123abc";
  model = await buildPrintModel({
    ...createDemoData(),
    bbox: DEMO_BBOX,
    scale: 4500,
    settings,
  });
});

function readSTL(buffer: ArrayBuffer): PrintMesh {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  assert.equal(buffer.byteLength, 84 + count * 50);
  const positions = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) {
    const offset = 84 + i * 50;
    for (let j = 0; j < 3; j++)
      assert.ok(Number.isFinite(view.getFloat32(offset + j * 4, true)));
    for (let j = 0; j < 9; j++)
      positions[i * 9 + j] = view.getFloat32(offset + 12 + j * 4, true);
  }
  return {
    positions,
    indices: Uint32Array.from({ length: count * 3 }, (_, i) => i),
    faceLayers: new Uint8Array(count),
  };
}

test("binary STL contains the closed printed solid in millimetres with vertical Z", () => {
  const decoded = readSTL(createSTLBuffer(model));
  const volume = assertClosedSolid(decoded);
  assert.ok(Math.abs(volume - model.stats.volumeMm3) / volume < 1e-5);
  const axes = [0, 1, 2].map((axis) =>
    Array.from(decoded.positions).filter((_, i) => i % 3 === axis),
  );
  assert.ok(
    Math.abs(
      Math.max(...axes[0]) - Math.min(...axes[0]) - model.dimensions.widthMm,
    ) < 1e-4,
  );
  assert.ok(
    Math.abs(
      Math.max(...axes[1]) - Math.min(...axes[1]) - model.dimensions.depthMm,
    ) < 1e-4,
  );
  assert.equal(Math.min(...axes[2]), 0);
  assert.ok(Math.abs(Math.max(...axes[2]) - model.dimensions.heightMm) < 1e-4);
});

test("3MF archive preserves custom palette and manifold mesh indices", async () => {
  const archive = await JSZip.loadAsync(
    await create3MFBuffer(model, model.colors),
  );
  for (const name of ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"])
    assert.ok(archive.file(name));
  const xml = await archive.file("3D/3dmodel.model")!.async("string");
  assert.match(xml, /unit="millimeter"/);
  assert.match(xml, /name="water" displaycolor="#123ABCFF"/);
  const positions: number[] = [],
    indices: number[] = [],
    faceLayers: number[] = [];
  for (const vertex of xml.matchAll(
    /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g,
  ))
    positions.push(...vertex.slice(1).map(Number));
  for (const triangle of xml.matchAll(
    /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" pid="1" p1="(\d+)"\/>/g,
  )) {
    indices.push(...triangle.slice(1, 4).map(Number));
    faceLayers.push(Number(triangle[4]));
  }
  assert.deepEqual(indices, Array.from(model.indices));
  assert.deepEqual(faceLayers, Array.from(model.faceLayers));
  assert.ok(
    new Set(faceLayers).size >= 4,
    "layer assignments survive solid union",
  );
  assertClosedSolid({
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    faceLayers: new Uint8Array(faceLayers),
  });
});

test("tile STL files are distinct closed intersections and reconstruct the original volume", () => {
  assert.equal(model.tiles.length, 2);
  const decoded = model.tiles.map((tile) => readSTL(createSTLBuffer(tile)));
  const volumes = decoded.map(assertClosedSolid);
  const sum = volumes.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - model.stats.volumeMm3) / sum < 1e-5);
  assert.notDeepEqual(
    decoded[0].positions,
    decoded[1].positions,
    "each tile has its own geometry",
  );
  for (let i = 0; i < decoded.length; i++) {
    const x = Array.from(decoded[i].positions).filter(
      (_, index) => index % 3 === 0,
    );
    assert.ok(
      Math.abs(Math.max(...x) - Math.min(...x) - model.dimensions.widthMm / 2) <
        1e-4,
    );
  }
});

test("3MF preserves source credits and acquisition dates in the whole model and every tile", async () => {
  const provenance = {
    sources: [...model.sources, "© Source test & <terrain>"],
    fetchedAt: "2026-10-11T10:30:00Z",
    osmTimestamp: "2026-10-11T09:00:00Z",
  };
  for (const mesh of [model, ...model.tiles]) {
    const archive = await JSZip.loadAsync(
      await create3MFBuffer(mesh, model.colors, provenance),
    );
    const xml = await archive.file("3D/3dmodel.model")!.async("string");
    assert.match(
      xml,
      /<metadata name="Copyright">Démonstration synthétique locale ; © Source test &amp; &lt;terrain&gt;<\/metadata>/,
    );
    assert.match(
      xml,
      /<metadata name="CreationDate">2026-10-11T10:30:00Z<\/metadata>/,
    );
    assert.match(xml, /Données OpenStreetMap du 2026-10-11T09:00:00Z/);
    assert.equal([...xml.matchAll(/<metadata name="Description">/g)].length, 1);
  }
  const automatic = await JSZip.loadAsync(
    await create3MFBuffer(model, model.colors),
  );
  const automaticXML = await automatic
    .file("3D/3dmodel.model")!
    .async("string");
  assert.match(
    automaticXML,
    /<metadata name="Copyright">Démonstration synthétique locale<\/metadata>/,
  );
  assert.ok(
    automaticXML.includes(
      `<metadata name="CreationDate">${model.fetchedAt}</metadata>`,
    ),
  );
});
