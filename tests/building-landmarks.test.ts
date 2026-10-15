import assert from "node:assert/strict";
import test from "node:test";
import { buildingLandmark } from "../src/lib/data/building-landmarks";
import { buildPrintModel } from "../src/lib/mesh/build-print-model";
import { DEFAULT_MODEL_SETTINGS } from "../src/store/use-scene-store";
import type { OverpassElement } from "../src/types/osm";
import { assertClosedSolid } from "./helpers/solid";

test("named civic geometry can be explored in every city without generating a landmark shape", async () => {
  const square = (
    id: number,
    west: number,
    tags: Record<string, string>,
  ): OverpassElement => ({
    type: "way",
    id,
    tags: { building: "yes", height: "12", ...tags },
    geometry: [
      { lat: 43.61, lon: west },
      { lat: 43.61, lon: west + 0.0002 },
      { lat: 43.6102, lon: west + 0.0002 },
      { lat: 43.6102, lon: west },
      { lat: 43.61, lon: west },
    ],
  });
  const elements = [
    square(1, 3.87, {
      building: "church",
      name: "Église relevée",
      "printmap:osm_id": "relation/42",
    }),
    square(2, 3.8703, {
      building: "church",
      name: "Église relevée",
      "printmap:osm_id": "relation/42",
    }),
    square(3, 3.8706, { name: "Commerce ordinaire" }),
  ];
  const settings = structuredClone(DEFAULT_MODEL_SETTINGS);
  settings.base.topographyEnabled = false;
  const model = await buildPrintModel({
    bbox: [43.6098, 3.8698, 43.6105, 3.871],
    scale: 1000,
    osmData: { elements },
    elevationGrid: null,
    settings,
  });
  assertClosedSolid(model);
  assert.equal(model.stats.buildingCount, 3);
  assert.equal(model.landmarks?.length, 1);
  const landmark = model.landmarks![0];
  assert.equal(landmark.name, "Église relevée");
  assert.equal(landmark.id, "relation/42");
  assert.equal(landmark.representation, "footprint");
  assert.ok(
    landmark.max[0] - landmark.min[0] > 35,
    "both wings enter the focus bounds",
  );
  assert.equal(
    model.stats.realRoofCount,
    0,
    "a name cannot supply architectural detail",
  );
});

test("landmark names preserve existing catalogue identities and reject anonymous or oversized labels", () => {
  assert.equal(
    buildingLandmark({ sourceId: "way/63322493", tags: {} })?.name,
    "Cathédrale Saint-Charles",
  );
  assert.equal(
    buildingLandmark({ sourceId: "MMM/B102558", tags: {} })?.name,
    "L’Arbre Blanc",
  );
  assert.equal(
    buildingLandmark({ sourceId: "way/1", tags: { building: "church" } }),
    undefined,
  );
  assert.equal(
    buildingLandmark({
      sourceId: "way/1",
      tags: { building: "church", name: "x".repeat(161) },
    }),
    undefined,
  );
});
