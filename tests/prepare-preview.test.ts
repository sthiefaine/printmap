import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createPreviewGeometry } from "../src/components/viewer/CityModel";
import {
  preparePreview,
  printModelTransferables,
} from "../src/lib/mesh/prepare-preview";
import { createSTLBuffer } from "../src/lib/export/stl-export";
import { create3MFModelXML } from "../src/lib/export/threemf-export";
import {
  PRINT_LAYERS,
  type PrintMesh,
  type PrintModel,
} from "../src/types/print";
import { legacyPreviewGeometry } from "./helpers/legacy-preview";

function mesh(): PrintMesh {
  return {
    // An asymmetric box with a sloping roof, plus an unused vertex to ensure
    // bounds agree with Three for every vertex, rather than only the triangles.
    positions: new Float32Array([
      -2, -3, 0, 7, -3, 0, 7, 6, 0, -2, 6, 0, -2, -3, 4, 7, -3, 7, 7, 6, 7, -2,
      6, 4, 10, 12, 2,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2,
      3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]),
    faceLayers: new Uint8Array([7, 1, 3, 2, 0, 4, 5, 6, 1, 3, 7, 255]),
  };
}
function model(): PrintModel {
  const value = mesh();
  return {
    ...value,
    colors: Object.fromEntries(
      PRINT_LAYERS.map((layer, index) => [
        layer,
        `#${(0x123456 + index * 100).toString(16)}`,
      ]),
    ) as PrintModel["colors"],
    dimensions: { widthMm: 12, depthMm: 15, heightMm: 7 },
    stats: {
      buildingCount: 1,
      roadCount: 0,
      waterCount: 0,
      parkCount: 0,
      sandCount: 0,
      pierCount: 0,
      discardedFeatures: 0,
      triangleCount: value.indices.length / 3,
      components: 1,
      volumeMm3: 445.5,
      estimatedHeights: 0,
      realRoofCount: 0,
      taggedRoofCount: 0,
      staircaseCount: 0,
      measuredStructureCount: 0,
      reconstructedBridgeCount: 0,
      basinRimCount: 0,
      reconstructedAqueductCount: 0,
      aqueductArchCount: 0,
    },
    warnings: [],
    sources: ["Declared synthetic preview/export control"],
    fetchedAt: "2026-10-15T00:00:00Z",
    // Reusing a buffer is deliberate: a transfer list must deduplicate aliases.
    tiles: [{ ...value, col: 0, row: 0, widthMm: 12, depthMm: 15 }],
  };
}

test("worker preview preserves every triangle, winding and material in X,Z,-Y orientation", () => {
  const original = mesh();
  const sourcePositions = original.positions.slice();
  const sourceIndices = original.indices.slice();
  const sourceLayers = original.faceLayers.slice();
  const preview = preparePreview(original);
  for (let at = 0; at < sourcePositions.length; at += 3)
    assert.deepEqual(Array.from(preview.positions.subarray(at, at + 3)), [
      sourcePositions[at],
      sourcePositions[at + 2],
      -sourcePositions[at + 1],
    ]);
  let offset = 0;
  for (let material = 0; material < PRINT_LAYERS.length; material++) {
    const expected: number[] = [];
    for (let face = 0; face < sourceLayers.length; face++)
      if (
        (sourceLayers[face] < PRINT_LAYERS.length ? sourceLayers[face] : 0) ===
        material
      )
        expected.push(...sourceIndices.subarray(face * 3, face * 3 + 3));
    assert.deepEqual(preview.groups[material], {
      start: offset,
      count: expected.length,
      materialIndex: material,
    });
    assert.deepEqual(
      Array.from(preview.indices.subarray(offset, offset + expected.length)),
      expected,
    );
    offset += expected.length;
  }
  assert.equal(offset, sourceIndices.length);
  assert.deepEqual(original.positions, sourcePositions);
  assert.deepEqual(original.indices, sourceIndices);
  assert.deepEqual(original.faceLayers, sourceLayers);
  assert.notEqual(preview.positions.buffer, original.positions.buffer);
  assert.notEqual(preview.indices.buffer, original.indices.buffer);
  assert.notEqual(preview.normals.buffer, preview.positions.buffer);
});

test("normals, render groups and culling bounds equal the previous Three preparation", () => {
  const source = mesh();
  const preview = preparePreview(source);
  const reference = legacyPreviewGeometry(source);
  reference.computeBoundingBox();
  try {
    assert.deepEqual(
      preview.positions,
      reference.getAttribute("position").array,
    );
    assert.deepEqual(preview.indices, reference.getIndex()!.array);
    assert.deepEqual(preview.normals, reference.getAttribute("normal").array);
    assert.deepEqual(preview.groups, reference.groups);
    assert.deepEqual(preview.bounds.min, reference.boundingBox!.min.toArray());
    assert.deepEqual(preview.bounds.max, reference.boundingBox!.max.toArray());
    assert.deepEqual(
      preview.sphere.center,
      reference.boundingSphere!.center.toArray(),
    );
    assert.equal(preview.sphere.radius, reference.boundingSphere!.radius);
    for (let at = 0; at < preview.normals.length - 3; at += 3)
      assert.ok(
        Math.abs(Math.hypot(...preview.normals.subarray(at, at + 3)) - 1) <
          1e-6,
      );
    assert.deepEqual(Array.from(preview.normals.subarray(-3)), [0, 0, 0]);
  } finally {
    reference.dispose();
  }
});

test("viewer attaches the exact transferred arrays and all layer colours without recomputing", () => {
  const value = model();
  const preview = preparePreview(value);
  const computeNormals = THREE.BufferGeometry.prototype.computeVertexNormals;
  const computeBox = THREE.BufferGeometry.prototype.computeBoundingBox;
  const computeSphere = THREE.BufferGeometry.prototype.computeBoundingSphere;
  THREE.BufferGeometry.prototype.computeVertexNormals =
    THREE.BufferGeometry.prototype.computeBoundingBox =
    THREE.BufferGeometry.prototype.computeBoundingSphere =
      () => {
        throw new Error("Geometry work must stay in the worker");
      };
  try {
    const geometry = createPreviewGeometry(preview);
    assert.equal(geometry.getAttribute("position").array, preview.positions);
    assert.equal(geometry.getAttribute("normal").array, preview.normals);
    assert.equal(geometry.getIndex()!.array, preview.indices);
    assert.deepEqual(geometry.groups, preview.groups);
    const materials = PRINT_LAYERS.map(
      (layer) => new THREE.MeshStandardMaterial({ color: value.colors[layer] }),
    );
    try {
      for (const group of geometry.groups)
        assert.equal(
          `#${materials[group.materialIndex!].color.getHexString()}`,
          value.colors[PRINT_LAYERS[group.materialIndex!]],
        );
    } finally {
      materials.forEach((material) => material.dispose());
    }
    geometry.dispose();
    assert.ok(
      value.positions.byteLength > 0,
      "GPU disposal does not detach export geometry",
    );
  } finally {
    THREE.BufferGeometry.prototype.computeVertexNormals = computeNormals;
    THREE.BufferGeometry.prototype.computeBoundingBox = computeBox;
    THREE.BufferGeometry.prototype.computeBoundingSphere = computeSphere;
  }
});

test("worker transfer delivers both independent preview and original mm/Z export buffers exactly once", () => {
  const value = model();
  const original = structuredClone(value);
  const stl = createSTLBuffer(value);
  const xml = create3MFModelXML(value, value.colors);
  value.preview = preparePreview(value);
  assert.deepEqual(createSTLBuffer(value), stl);
  assert.equal(create3MFModelXML(value, value.colors), xml);
  const transfer = printModelTransferables(value);
  assert.equal(
    transfer.length,
    6,
    "three shared export buffers plus three display buffers",
  );
  assert.equal(new Set(transfer).size, transfer.length);
  const response = structuredClone(
    { type: "success", id: 9, model: value },
    { transfer },
  );
  assert.equal(
    value.positions.byteLength,
    0,
    "the worker relinquishes ownership only when posting success",
  );
  const received = response.model;
  assert.deepEqual(received.positions, original.positions);
  assert.deepEqual(received.indices, original.indices);
  assert.deepEqual(received.faceLayers, original.faceLayers);
  assert.deepEqual(received.tiles, original.tiles);
  assert.equal(received.tiles[0].positions.buffer, received.positions.buffer);
  assert.deepEqual(createSTLBuffer(received), stl);
  assert.equal(create3MFModelXML(received, received.colors), xml);
  // Display buffers can move independently; there is no alias that could
  // detach the printable data already received by the main thread.
  const preview = received.preview!;
  const renderCopy = structuredClone(preview, {
    transfer: [
      preview.positions.buffer,
      preview.indices.buffer,
      preview.normals.buffer,
    ] as ArrayBuffer[],
  });
  assert.ok(renderCopy.positions.byteLength > 0);
  assert.deepEqual(received.positions, original.positions);
  assert.deepEqual(createSTLBuffer(received), stl);
});

test("empty preview is finite, and incomplete index/layer buffers are rejected", () => {
  const value = preparePreview({
    positions: new Float32Array(),
    indices: new Uint32Array(),
    faceLayers: new Uint8Array(),
  });
  assert.deepEqual(value.bounds, { min: [0, 0, 0], max: [0, 0, 0] });
  assert.deepEqual(value.sphere, { center: [0, 0, 0], radius: 0 });
  assert.equal(value.groups.length, PRINT_LAYERS.length);
  assert.throws(
    () => preparePreview({ ...mesh(), faceLayers: new Uint8Array(1) }),
    /incomplets/,
  );
});
