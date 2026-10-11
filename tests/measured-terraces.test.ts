import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "manifold-3d";
import type { BBox, ElevationGrid, OverpassElement } from "../src/types/osm";
import { createProjectionForBbox } from "../src/lib/projection";
import { sampleElevation } from "../src/lib/elevation/sample-grid";
import { buildMeasuredTerraces } from "../src/lib/mesh/measured-terraces";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/montpellier-peyrou-terraces.json", import.meta.url),
    "utf8",
  ),
) as {
  bbox: BBox;
  elements: OverpassElement[];
  terrainGrid: ElevationGrid;
};
const projection = createProjectionForBbox(fixture.bbox);
const constraints = buildMeasuredTerraces(
  fixture.elements,
  fixture.terrainGrid,
  projection.project,
  1,
);

test("Peyrou keeps three locally estimated terrace levels and a gentle drainage slope", () => {
  assert.equal(constraints.length, 3);
  const [central, alleys, water] = constraints;
  assert.equal(central.sourceIds.includes("way/236821993"), true);
  for (const constraint of constraints) {
    assert.equal(constraint.mode, "estimated-from-dem");
    assert.equal(
      constraint.sourceUrl,
      "https://archives.montpellier.fr/peyrou",
    );
    assert.ok(constraint.sampleCount >= 12);
    assert.ok(constraint.fitRmsM < 0.1);
    assert.ok(constraint.slopePercent < 1);
  }
  assert.ok(central.slopePercent > 0.85 && central.slopePercent < 0.95);
  assert.ok(alleys.slopePercent > 0.8 && alleys.slopePercent < 0.95);
  assert.equal(water.slopePercent, 0);
  assert.ok(Math.abs(water.plane.elevationM - 54.17) < 1e-7);
  const west = projection.project(3.8699, 43.61135),
    east = projection.project(3.8715, 43.61135);
  assert.ok(central.elevationAt(...west) > central.elevationAt(...east));
  assert.ok(central.elevationAt(...west) - central.elevationAt(...east) < 1.5);
  // The parterre is a distinct mapped level rather than merged into the surrounding allées.
  const middle = projection.project(3.8705, 43.61135);
  assert.ok(
    alleys.elevationAt(...middle) - central.elevationAt(...middle) > 0.25,
  );
});

test("upper promenade walls stop becoming raster ramps and lower gardens remain untouched", () => {
  const northEdge = projection.project(3.8705, 43.61183);
  const matching = constraints.filter((c) => c.contains(...northEdge));
  assert.equal(matching.length, 1);
  assert.equal(matching[0].name, "Allées de la promenade haute du Peyrou");
  assert.ok(
    matching[0].elevationAt(...northEdge) -
      sampleElevation(fixture.terrainGrid, 43.61183, 3.8705) >
      1.4,
  );
  const lowerGarden = projection.project(3.8685, 43.6117);
  assert.equal(
    constraints.some((c) => c.contains(...lowerGarden)),
    false,
  );
  const outsidePromenade = projection.project(3.8705, 43.612);
  assert.equal(
    constraints.some((c) => c.contains(...outsidePromenade)),
    false,
  );
  const centralPoint = projection.project(3.8705, 43.61135);
  assert.deepEqual(
    constraints.filter((c) => c.contains(...centralPoint)).map((c) => c.name),
    ["Parterre central du Peyrou"],
  );
  const waterPoint = projection.project(3.8693, 43.61135);
  assert.deepEqual(
    constraints.filter((c) => c.contains(...waterPoint)).map((c) => c.name),
    ["Terrasse des eaux du Peyrou"],
  );
  const chateau = fixture.elements
    .find((e) => e.id === 3186605)!
    .members!.find((m) => m.ref === 25938154)!.geometry!;
  const chateauPoint = projection.project(
    chateau.reduce((sum, p) => sum + p.lon, 0) / chateau.length,
    chateau.reduce((sum, p) => sum + p.lat, 0) / chateau.length,
  );
  assert.equal(
    constraints.some((c) => c.contains(...chateauPoint)),
    false,
  );
});

test("mapped five-step flights retain the gap between actual higher and lower landing masks", () => {
  const high = constraints.find(
    (c) => c.name === "Terrasse des eaux du Peyrou",
  )!;
  const low = constraints.find(
    (c) => c.name === "Allées de la promenade haute du Peyrou",
  )!;
  for (const id of [471381363, 471740020, 471740023]) {
    const stair = fixture.elements.find((e) => e.id === id)!.geometry!;
    const a = projection.project(stair[0].lon, stair[0].lat);
    const b = projection.project(stair.at(-1)!.lon, stair.at(-1)!.lat);
    assert.equal(high.contains(...a), true);
    assert.equal(low.contains(...b), true);
    const middle: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    assert.equal(high.contains(...middle), false);
    assert.equal(low.contains(...middle), false);
    assert.ok(high.elevationAt(...a) > low.elevationAt(...b));
  }
});

test("masks form closed planar solids at print scale and preserve their structural exclusions", async () => {
  const cad = await Module();
  cad.setup();
  const handles: Array<{ delete(): void }> = [];
  const keep = <T extends { delete(): void }>(handle: T): T => {
    handles.push(handle);
    return handle;
  };
  const sf = 0.548;
  const scaled = buildMeasuredTerraces(
    fixture.elements,
    fixture.terrainGrid,
    (lon, lat) => {
      const [x, y] = projection.project(lon, lat);
      return [x * sf, y * sf];
    },
    sf,
  );
  try {
    for (let i = 0; i < scaled.length; i++) {
      const constraint = scaled[i];
      assert.ok(
        Math.abs(constraint.slopePercent - constraints[i].slopePercent) < 1e-6,
      );
      let section = keep(
        cad.CrossSection.union(
          constraint.polygons.map((p) =>
            keep(new cad.CrossSection([p.outer], "NonZero")),
          ),
        ),
      );
      for (const exclusion of constraint.exclusions)
        section = keep(
          section.subtract(
            keep(new cad.CrossSection([exclusion.outer], "EvenOdd")),
          ),
        );
      const solid = keep(
        keep(section.extrude(1)).warp((vertex) => {
          if (vertex[2] > 0)
            vertex[2] =
              3 +
              (constraint.elevationAt(vertex[0], vertex[1]) -
                fixture.terrainGrid.minElev) *
                sf;
        }),
      );
      assert.equal(solid.status(), "NoError");
      assert.ok(solid.volume() > 0);
      const equivalentAreaM2 = section.area() / sf ** 2;
      assert.ok(equivalentAreaM2 > 100 && equivalentAreaM2 < 20000);
    }
  } finally {
    for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
  }
});

test("unidentified parks, missing mapped boundaries and coarse or unusable grids are never flattened", () => {
  const altered = fixture.elements.map((e) =>
    e.id === 3186605 ? { ...e, id: 999 } : e,
  );
  assert.deepEqual(
    buildMeasuredTerraces(altered, fixture.terrainGrid, projection.project, 1),
    [],
  );
  assert.deepEqual(
    buildMeasuredTerraces(
      fixture.elements.filter((e) => e.id !== 471740020),
      fixture.terrainGrid,
      projection.project,
      1,
    ),
    [],
  );
  assert.deepEqual(
    buildMeasuredTerraces(
      fixture.elements,
      { ...fixture.terrainGrid, source: "Copernicus DEM", resolutionM: 90 },
      projection.project,
      1,
    ),
    [],
  );
  assert.deepEqual(
    buildMeasuredTerraces(
      fixture.elements,
      { ...fixture.terrainGrid, resolutionM: 30 },
      projection.project,
      1,
    ),
    [],
  );
  assert.deepEqual(
    buildMeasuredTerraces(
      fixture.elements,
      {
        ...fixture.terrainGrid,
        points: fixture.terrainGrid.points.map(() => NaN),
      },
      projection.project,
      1,
    ),
    [],
  );
  assert.deepEqual(
    buildMeasuredTerraces(fixture.elements, null, projection.project, 1),
    [],
  );
});
