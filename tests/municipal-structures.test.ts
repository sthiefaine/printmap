import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  structureElements,
  enrichWithMunicipalStructures,
} from "../src/lib/data/montpellier-structures";
import { parseElements } from "../src/lib/osm/parse-elements";
import type { BBox, OverpassElement } from "../src/types/osm";
import vialletonElevation from "../src/lib/data/vialleton-ign-elevation.json";
const bbox: BBox = [43.6096, 3.8665, 43.6137, 3.8754];
const fixture = async () =>
  JSON.parse(
    await readFile(
      new URL("./fixtures/montpellier-peyrou-structures.json", import.meta.url),
      "utf8",
    ),
  );

test("real municipal bridge dimensions survive but buffered locations never become physical bridge footprints", async () => {
  const inventory = structureElements((await fixture()).features, bbox);
  const bridge = inventory.find(
    (element) => element.tags?.name === "(Av.Foch/Vialleton)",
  )!;
  assert.equal(bridge.tags?.["printmap:bridge_clearance"], "5");
  assert.equal(bridge.tags?.["printmap:bridge_span"], "14.5");
  assert.equal(bridge.tags?.["printmap:bridge_width"], "8");
  assert.equal(bridge.tags?.["printmap:source_year"], "2025");
  assert.equal(bridge.tags?.["printmap:location_only"], "yes");
  assert.equal(bridge.tags?.man_made, undefined);
  assert.equal(bridge.tags?.height, undefined);
  const parsed = parseElements(inventory, bbox, 5000);
  assert.equal(parsed.piers.length, 0);
  assert.equal(parsed.buildings.length, 0);
});

test("municipal inventory enriches real OSM bridge without replacing its geometry by a circular buffer", async () => {
  const inventory = structureElements((await fixture()).features, bbox);
  const { element: bridge }: { element: OverpassElement } = JSON.parse(
    await readFile(
      new URL("./fixtures/peyrou-osm-vialleton.json", import.meta.url),
      "utf8",
    ),
  );
  const geometry = bridge.geometry;
  const output = enrichWithMunicipalStructures(
    [bridge],
    inventory,
  ).elements.find((e) => e.id === 436682851)!;
  assert.deepEqual(output.geometry, geometry);
  assert.equal(output.tags?.["printmap:bridge_span"], "14.5");
  assert.equal(output.tags?.["printmap:location_only"], undefined);
  assert.equal(output.tags?.height, undefined);
  assert.equal(output.tags?.["printmap:bridge_deck_elevation"], "51.2");
  assert.equal(output.tags?.["printmap:bridge_deck_uncertainty"], "1.5");
  assert.match(
    output.tags?.["printmap:bridge_deck_source"] ?? "",
    /CONSLINE0000000044468440/,
  );
  assert.equal(
    output.tags?.["printmap:bridge_deck_source_modified"],
    "2017-02-09",
  );
  assert.equal(output.tags?.["printmap:bridge_deck_vertical_datum"], "IGN69");
  const otherId = { ...bridge, id: 436682852 };
  const otherOutput = enrichWithMunicipalStructures(
    [otherId],
    inventory,
  ).elements.find((e) => e.id === otherId.id)!;
  assert.equal(otherOutput.tags?.["printmap:bridge_deck_elevation"], undefined);
});

test("the verified IGN Vialleton fixture provides three roadway altitudes and declared uncertainty", () => {
  const feature = vialletonElevation.feature;
  assert.equal(feature.properties.cleabs, "CONSLINE0000000044468440");
  assert.equal(feature.properties.nature, "Pont");
  assert.deepEqual(
    feature.geometry.coordinates.map((point) => point[2]),
    [51.3, 51, 51.4],
  );
  assert.equal(feature.properties.precision_altimetrique, 1.5);
  assert.ok(
    Math.abs(
      feature.geometry.coordinates.reduce((sum, point) => sum + point[2], 0) /
        3 -
        vialletonElevation.adjacentArcGroundElevation2020,
    ) < 0.1,
  );
  assert.match(
    vialletonElevation.source,
    /RESOURCEID=construction_lineaire\.588486/,
  );
});

test("unlocated aqueduct clearance list cannot fabricate a sequence of arches", async () => {
  const inventory = structureElements((await fixture()).features, bbox);
  const aqueduct = inventory.find(
    (e) => e.tags?.["printmap:structure_type"] === "aqueduct",
  )!;
  assert.ok(aqueduct);
  assert.equal(aqueduct.tags?.["printmap:bridge_clearance"], undefined);
  assert.equal(aqueduct.tags?.["printmap:bridge_span"], undefined);
  assert.equal(aqueduct.tags?.height, undefined);
  assert.deepEqual(
    structureElements((await fixture()).features, [48.85, 2.34, 48.86, 2.35]),
    [],
  );
});
