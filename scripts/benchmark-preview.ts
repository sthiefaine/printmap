import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus } from "node:os";
import JSZip from "jszip";
import { createPreviewGeometry } from "../src/components/viewer/CityModel";
import { preparePreview } from "../src/lib/mesh/prepare-preview";
import type { PrintMesh } from "../src/types/print";
import { legacyPreviewGeometry } from "../tests/helpers/legacy-preview";

// Replays an existing, generated 3MF; no city reconstruction, downloads or GPU.
// npx tsx scripts/benchmark-preview.ts [model.3mf] [iterations]
const filename = resolve(
  process.argv[2] ||
    "artifacts/saint-etienne-toitures-corrigees/saint-etienne-toitures-corrigees.3mf",
);
const iterations = Number(process.argv[3] || 30);
assert.ok(Number.isInteger(iterations) && iterations >= 5 && iterations <= 200);
const zip = await JSZip.loadAsync(await readFile(filename));
const xml = await zip.file("3D/3dmodel.model")!.async("string");
const vertices = Array.from(
  xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\s*\/>/g),
);
const triangles = Array.from(
  xml.matchAll(
    /<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" pid="1" p1="(\d+)"\s*\/>/g,
  ),
);
assert.ok(
  vertices.length > 0 && triangles.length > 0,
  "a PrintMap indexed 3MF is required",
);
const mesh: PrintMesh = {
  positions: Float32Array.from(
    vertices.flatMap((v) => [Number(v[1]), Number(v[2]), Number(v[3])]),
  ),
  indices: Uint32Array.from(
    triangles.flatMap((t) => [Number(t[1]), Number(t[2]), Number(t[3])]),
  ),
  faceLayers: Uint8Array.from(triangles, (t) => Number(t[4])),
};
const prepared = preparePreview(mesh);
const expected = legacyPreviewGeometry(mesh);
const attached = createPreviewGeometry(prepared);
assert.deepEqual(
  attached.getAttribute("position").array,
  expected.getAttribute("position").array,
);
assert.deepEqual(
  attached.getAttribute("normal").array,
  expected.getAttribute("normal").array,
);
assert.deepEqual(attached.getIndex()!.array, expected.getIndex()!.array);
assert.deepEqual(attached.groups, expected.groups);
assert.deepEqual(attached.boundingSphere, expected.boundingSphere);
assert.equal(attached.getAttribute("position").array, prepared.positions);
assert.equal(attached.getAttribute("normal").array, prepared.normals);
assert.equal(attached.getIndex()!.array, prepared.indices);
expected.dispose();
attached.dispose();
const before: number[] = [],
  after: number[] = [],
  workerPreparation: number[] = [];
for (let repeat = -5; repeat < iterations; repeat++) {
  let start = performance.now();
  const legacy = legacyPreviewGeometry(mesh);
  const oldMs = performance.now() - start;
  legacy.dispose();
  start = performance.now();
  const derived = preparePreview(mesh);
  const prepareMs = performance.now() - start;
  start = performance.now();
  const view = createPreviewGeometry(derived);
  const attachMs = performance.now() - start;
  view.dispose();
  if (repeat >= 0) {
    before.push(oldMs);
    after.push(attachMs);
    workerPreparation.push(prepareMs);
  }
}
const timing = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
};
const old = timing(before),
  current = timing(after);
console.log(
  JSON.stringify(
    {
      filename,
      environment: {
        node: process.version,
        cpu: cpus()[0]?.model,
        platform: process.platform,
      },
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
      iterations,
      oldUiPreparationAndAttach: old,
      newUiAttach: current,
      previewPreparationOutsideUi: timing(workerPreparation),
      medianAttachSpeedup: old.medianMs / current.medianMs,
      additionalTransferBytes:
        prepared.positions.byteLength +
        prepared.indices.byteLength +
        prepared.normals.byteLength,
      equivalence:
        "Positions, indices, normals, material groups and sphere equal the previous viewer; attached arrays retain buffer identity.",
      limits:
        "Node CPU measurements, not browser frame rate. Disk/unzip, worker startup, message transfer and GPU upload excluded. Five warmup runs excluded.",
    },
    null,
    2,
  ),
);
