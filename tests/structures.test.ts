import assert from "node:assert/strict";
import test from "node:test";
import Module, { type Manifold, type Mesh } from "manifold-3d";
import { readFileSync } from "node:fs";
import { makeStairFlight } from "../src/lib/mesh/stair-solid";
import {
  makeMeasuredSolid,
  type MeasuredBuildingSolid,
} from "../src/lib/mesh/measured-solid";
import type { RoadData } from "../src/lib/osm/parse-elements";
import { assertClosedSolid } from "./helpers/solid";
import { makeSurveyedArch } from "../src/lib/mesh/bridge-solid";
import { parseCityGMLBuilding } from "../src/lib/data/citygml-parser";
import { createProjectionForBbox } from "../src/lib/projection";

const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});
function boundary(mesh: Mesh) {
  const positions = new Float32Array(
    (mesh.vertProperties.length / mesh.numProp) * 3,
  );
  for (let i = 0; i < positions.length / 3; i++)
    positions.set(
      mesh.vertProperties.subarray(i * mesh.numProp, i * mesh.numProp + 3),
      i * 3,
    );
  return {
    positions,
    indices: mesh.triVerts,
    faceLayers: new Uint8Array(mesh.triVerts.length / 3),
  };
}
function road(tags: Record<string, string> = {}): RoadData {
  return {
    polyline: [
      [-10, 0],
      [10, 0],
    ],
    halfWidth: 2,
    roadClass: "pedestrian",
    roadType: "steps",
    isUnderground: false,
    tags: {
      highway: "steps",
      step_count: "10",
      "step:height": "0.2",
      incline: "up",
      ...tags,
    },
    sourceId: "way/1",
  };
}
function tops(solid: Manifold) {
  const mesh = solid.getMesh(),
    result = new Set<number>();
  for (let at = 0; at < mesh.triVerts.length; at += 3) {
    const [a, b, c] = Array.from(mesh.triVerts.subarray(at, at + 3));
    const z = [a, b, c].map(
      (index) => mesh.vertProperties[index * mesh.numProp + 2],
    );
    if (z[0] > 2.71 && z.every((value) => Math.abs(value - z[0]) < 0.00001))
      result.add(Math.round(z[0] * 100000) / 100000);
  }
  return [...result].sort((a, b) => a - b);
}

test("tagged stairs produce true horizontal treads and carve a sloping terrain", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const clip = owner.keep(cad.CrossSection.square([80, 80], true));
    const flight = makeStairFlight(cad, owner, road(), {
      scaleFactor: 1,
      halfWidth: 2,
      minTreadMm: 0.8,
      foundationZ: 2.7,
      terrainMaxZ: 5,
      surfaceAt: (x) => 3 + (x + 10) / 10,
      hasElevation: true,
      clip,
    })!;
    assert.ok(flight);
    assert.equal(flight.estimatedRise, false);
    assert.equal(flight.printedSteps, 10);
    assert.deepEqual(
      tops(flight.solid),
      [3.2, 3.4, 3.6, 3.8, 4, 4.2, 4.4, 4.6, 4.8, 5],
    );
    const slope = owner.keep(
      cad.Manifold.cube([40, 40, 3])
        .translate([-20, -20, 0])
        .warp((vertex) => {
          if (vertex[2] > 0) vertex[2] = 4 + vertex[0] / 10;
        }),
    );
    const full = owner.keep(
      owner.keep(slope.subtract(flight.cutter)).add(flight.solid),
    );
    assertClosedSolid(boundary(full.getMesh()));
    assert.ok(full.volume() > 0);
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("subresolution stair risers group without changing the mapped total rise", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const clip = owner.keep(cad.CrossSection.square([80, 80], true));
    const flight = makeStairFlight(
      cad,
      owner,
      road({ step_count: "40", "step:height": "0.15" }),
      {
        scaleFactor: 0.1,
        halfWidth: 2,
        minTreadMm: 0.8,
        minRiserMm: 0.12,
        foundationZ: 2.7,
        terrainMaxZ: 3,
        surfaceAt: () => 3,
        hasElevation: false,
        clip,
      },
    )!;
    assert.equal(flight.sourceSteps, 40);
    assert.equal(flight.printedSteps, 5);
    assert.equal(flight.grouped, true);
    assert.equal(flight.estimatedRise, false);
    assert.ok(Math.abs(flight.riseMm - 0.6) < 1e-10);
    assert.ok(Math.abs(flight.solid.boundingBox().max[2] - 3.6) < 0.00001);
    assertClosedSolid(boundary(flight.solid.getMesh()));
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("stair direction, numeric incline and an absent elevation source remain explicit", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const clip = owner.keep(cad.CrossSection.square([80, 80], true));
    const options = {
      scaleFactor: 1,
      halfWidth: 2,
      minTreadMm: 0.8,
      foundationZ: 2.7,
      terrainMaxZ: 3,
      surfaceAt: () => 3,
      hasElevation: false,
      clip,
    };
    const descending = makeStairFlight(
      cad,
      owner,
      road({ incline: "-10%", "step:height": "" }),
      options,
    )!;
    assert.equal(descending.estimatedRise, false);
    assert.equal(descending.riseMm, 2);
    assertClosedSolid(boundary(descending.solid.getMesh()));
    const unmeasured = makeStairFlight(
      cad,
      owner,
      road({ "step:height": "" }),
      options,
    );
    assert.equal(
      unmeasured,
      null,
      "flat mode must not invent a raised landing",
    );
    assert.equal(
      makeStairFlight(
        cad,
        owner,
        road({ step_count: "1", "step:height": "0.08" }),
        options,
      ),
      null,
      "a total rise below print resolution must not be enlarged",
    );
    assert.equal(
      makeStairFlight(cad, owner, road({ "step:height": "" }), {
        ...options,
        hasElevation: true,
      }),
      null,
      "a flat DEM cannot supply a conventional invented rise",
    );
    assert.equal(
      makeStairFlight(
        cad,
        owner,
        road({ "step:height": "", incline: "down" }),
        {
          ...options,
          hasElevation: true,
          surfaceAt: (x: number) => 3 + (x + 10) / 10,
        },
      ),
      null,
      "contradictory direction must not shift the upper landing",
    );
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("curved flights share closed mitered treads and selection caps", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const clip = owner.keep(cad.CrossSection.square([16, 16], true));
    const curved = {
      ...road(),
      polyline: [
        [-10, 0],
        [0, 0],
        [0, 10],
      ] as RoadData["polyline"],
    };
    const flight = makeStairFlight(cad, owner, curved, {
      scaleFactor: 1,
      halfWidth: 2,
      minTreadMm: 0.8,
      foundationZ: 2.7,
      terrainMaxZ: 3,
      surfaceAt: () => 3,
      hasElevation: false,
      clip,
    })!;
    assertClosedSolid(boundary(flight.solid.getMesh()));
    assert.ok(flight.solid.boundingBox().max[1] <= 8.00001);
    assert.ok(flight.solid.boundingBox().min[0] >= -8.00001);
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

function measuredBoundary(solid: Manifold): MeasuredBuildingSolid {
  const mesh = solid.getMesh();
  const surfaces: MeasuredBuildingSolid["surfaces"] = [];
  for (let at = 0; at < mesh.triVerts.length; at += 3) {
    const points = Array.from(mesh.triVerts.subarray(at, at + 3)).map(
      (index) => ({
        lon: mesh.vertProperties[index * mesh.numProp],
        lat: mesh.vertProperties[index * mesh.numProp + 1],
        elevation: 100 + mesh.vertProperties[index * mesh.numProp + 2],
      }),
    );
    const kind = points.every((point) => point.elevation === 100)
      ? "ground"
      : points.every((point) => point.elevation === 110)
        ? "roof"
        : "wall";
    // Boundary orientation in source data is immaterial: repair it by adjacency.
    if (at % 2 === 0) points.reverse();
    surfaces.push({ outer: [...points, points[0]], holes: [], kind });
  }
  return { surfaces, source: "Measured test shell", year: 2020 };
}

test("measured closed shells preserve a real arch passage with foundations only under its feet", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const block = owner.keep(
      owner.keep(cad.Manifold.cube([20, 4, 10])).translate([-10, -2, 0]),
    );
    const profile: [number, number][] = [
      [-3, -1],
      [3, -1],
      [3, 4],
    ];
    for (let i = 1; i <= 16; i++)
      profile.push([
        3 * Math.cos((i * Math.PI) / 16),
        4 + 3 * Math.sin((i * Math.PI) / 16),
      ]);
    const opening = owner.keep(
      owner
        .keep(owner.keep(new cad.CrossSection([profile])).extrude(6))
        .rotate([90, 0, 0])
        .translate([0, 3, 0]),
    );
    const original = owner.keep(block.subtract(opening));
    const data = measuredBoundary(original);
    const clip = owner.keep(cad.CrossSection.square([80, 80], true));
    const printed = makeMeasuredSolid(cad, owner, data, {
      groundElevation: 100,
      project: (lon, lat) => [lon, lat],
      scaleFactor: 1,
      buildingScale: 1,
      surfaceZ: 3,
      foundationZ: 2.7,
      minimumHeight: 0.6,
      clip,
    })!;
    assert.ok(printed, "the supplied closed shell is usable");
    assertClosedSolid(boundary(printed.getMesh()));
    const passageProbe = owner.keep(
      owner.keep(cad.Manifold.cube([2, 8, 4])).translate([-1, -4, 3.2]),
    );
    const voidInside = owner.keep(printed.intersect(passageProbe));
    assert.ok(
      voidInside.isEmpty(),
      "the measured passage stays empty above the socle",
    );
    assert.ok(Math.abs(printed.boundingBox().max[2] - 13) < 0.00001);
    assert.ok(
      printed.volume() < 20 * 4 * 10,
      "roof projection must not fill the arch",
    );
    assert.ok(
      printed.volume() > original.volume(),
      "only the ground feet gain foundations",
    );
    for (const surfaceZ of [2, -1]) {
      const buried = makeMeasuredSolid(cad, owner, data, {
        groundElevation: 100,
        project: (lon, lat) => [lon, lat],
        scaleFactor: 1,
        buildingScale: 1,
        surfaceZ,
        foundationZ: 2.7,
        minimumHeight: 0.6,
        clip,
      });
      assert.ok(
        buried,
        "a buried source datum must retain the measured architecture",
      );
      assert.ok(
        Math.abs(buried.boundingBox().max[2] - (surfaceZ + 10)) < 0.00001,
        "the absolute source roof must not be lifted to the DEM",
      );
      assertClosedSolid(boundary(buried.getMesh()));
      const probe = owner.keep(
        owner
          .keep(cad.Manifold.cube([2, 8, 3]))
          .translate([-1, -4, Math.max(2.8, surfaceZ + 0.2)]),
      );
      assert.ok(
        owner.keep(buried.intersect(probe)).isEmpty(),
        "the buried datum must not fill the passage",
      );
    }
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("incomplete measured shells are rejected instead of silently filling missing walls", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const original = owner.keep(cad.Manifold.cube([4, 4, 10]));
    const data = measuredBoundary(original);
    data.surfaces.pop();
    const clip = owner.keep(cad.CrossSection.square([80, 80], true));
    assert.equal(
      makeMeasuredSolid(cad, owner, data, {
        groundElevation: 100,
        project: (lon, lat) => [lon, lat],
        scaleFactor: 1,
        buildingScale: 1,
        surfaceZ: 3,
        foundationZ: 2.7,
        minimumHeight: 0.6,
        clip,
      }),
      null,
    );
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("vertical measured wall holes remain true openings when source winding is mixed", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const point = (lon: number, lat: number, elevation: number) => ({
      lon,
      lat,
      elevation: 100 + elevation,
    });
    const front = [
      point(-4, -2, 0),
      point(4, -2, 0),
      point(4, -2, 10),
      point(-4, -2, 10),
    ];
    const back = front.map((p) => ({ ...p, lat: 2 }));
    const frontHole = [
      point(-1, -2, 2),
      point(1, -2, 2),
      point(1, -2, 6),
      point(-1, -2, 6),
    ];
    const backHole = frontHole.map((p) => ({ ...p, lat: 2 }));
    const surfaces: MeasuredBuildingSolid["surfaces"] = [
      { outer: front, holes: [frontHole], kind: "wall" },
      { outer: back.toReversed(), holes: [backHole], kind: "wall" },
    ];
    for (let i = 0; i < 4; i++)
      surfaces.push({
        outer: [front[i], front[(i + 1) % 4], back[(i + 1) % 4], back[i]],
        holes: [],
        kind: i === 0 ? "ground" : i === 2 ? "roof" : "wall",
      });
    for (let i = 0; i < 4; i++)
      surfaces.push({
        outer: [
          frontHole[i],
          frontHole[(i + 1) % 4],
          backHole[(i + 1) % 4],
          backHole[i],
        ],
        holes: [],
        kind: i === 2 ? "outerCeiling" : "wall",
      });
    const clip = owner.keep(cad.CrossSection.square([80, 80], true));
    const printed = makeMeasuredSolid(
      cad,
      owner,
      { surfaces, source: "Measured vertical hole", year: 2020 },
      {
        groundElevation: 100,
        project: (lon, lat) => [lon, lat],
        scaleFactor: 1,
        buildingScale: 1,
        surfaceZ: 3,
        foundationZ: 2.7,
        minimumHeight: 0.6,
        clip,
      },
    )!;
    assert.ok(printed);
    assertClosedSolid(boundary(printed.getMesh()));
    const probe = owner.keep(
      owner.keep(cad.Manifold.cube([1, 8, 2])).translate([-0.5, -4, 5.5]),
    );
    assert.equal(
      owner.keep(printed.intersect(probe)).isEmpty(),
      true,
      "the vertical hole crosses both walls",
    );
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("the official Peyrou gate keeps its passage and repairs only the surveyed coplanar roof joint", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const source = parseCityGMLBuilding(
      readFileSync(
        new URL("./fixtures/montpellier-lod2-arc-b137169.xml", import.meta.url),
        "utf8",
      ),
    )!;
    assert.ok(source.measuredSolid);
    const projection = createProjectionForBbox(source.bounds);
    const clip = owner.keep(cad.CrossSection.square([100, 100], true));
    let repairs = 0;
    const printed = makeMeasuredSolid(cad, owner, source.measuredSolid!, {
      groundElevation: source.groundElevation,
      project: projection.project,
      scaleFactor: 0.3,
      buildingScale: 1,
      surfaceZ: 3,
      foundationZ: 2.7,
      minimumHeight: 0.6,
      clip,
      onRepair: (count) => {
        repairs += count;
      },
    })!;
    assert.ok(printed);
    assert.equal(repairs, 1, "only the cylinder-to-floor joint is repaired");
    assertClosedSolid(boundary(printed.getMesh()));
    const probe = owner.keep(
      owner
        .keep(cad.Manifold.cube([0.2, 0.2, 0.2]))
        .translate([-0.1, -0.1, 3.3]),
    );
    assert.equal(
      owner.keep(printed.intersect(probe)).isEmpty(),
      true,
      "the real central passage stays open",
    );
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("documented arch dimensions produce a closed bridge and a real terrain passage", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const footprint = owner.keep(cad.CrossSection.square([18.9, 8], true));
    const clip = owner.keep(cad.CrossSection.square([80, 80], true));
    const bridge = makeSurveyedArch(cad, owner, {
      footprint,
      clip,
      center: [0, 0],
      axis: [1, 0],
      spanMm: 14.5,
      clearanceMm: 5,
      groundZ: 3,
      deckZ: 8.6,
      foundationZ: 2.7,
      minThicknessMm: 0.4,
      profile: "basket-handle",
    })!;
    assert.ok(bridge);
    assert.equal(bridge.approximateProfile, true);
    assertClosedSolid(boundary(bridge.solid.getMesh()));
    const probe = owner.keep(
      owner.keep(cad.Manifold.cube([1, 12, 3])).translate([-0.5, -6, 3.2]),
    );
    assert.equal(owner.keep(bridge.solid.intersect(probe)).isEmpty(), true);
    const terrain = owner.keep(
      owner.keep(cad.Manifold.cube([30, 30, 8])).translate([-15, -15, 0]),
    );
    const full = owner.keep(
      owner.keep(terrain.subtract(bridge.cutter)).add(bridge.solid),
    );
    assertClosedSolid(boundary(full.getMesh()));
    assert.ok(full.boundingBox().min[2] === 0, "the socle remains intact");
    assert.ok(
      owner.keep(full.intersect(probe)).volume() > 0,
      "probe extends outside the bounded bridge cut",
    );
    const centerProbe = owner.keep(
      owner.keep(cad.Manifold.cube([1, 4, 3])).translate([-0.5, -2, 3.2]),
    );
    assert.equal(
      owner.keep(full.intersect(centerProbe)).isEmpty(),
      true,
      "terrain inside the opening has been removed",
    );
    const floorProbe = owner.keep(
      owner.keep(cad.Manifold.cube([1, 4, 0.15])).translate([-0.5, -2, 2.8]),
    );
    assert.ok(
      owner.keep(full.intersect(floorProbe)).volume() > 0.59999,
      "the measured ground level remains under the passage",
    );
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("bridge reconstruction refuses missing dimensions, wrong axes and unsupported crown height", async () => {
  const cad = await runtime,
    handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(value: T) {
      handles.push(value);
      return value;
    },
  };
  try {
    const footprint = owner.keep(cad.CrossSection.square([18.9, 8], true));
    const clip = owner.keep(cad.CrossSection.square([80, 80], true));
    const options = {
      footprint,
      clip,
      center: [0, 0] as [number, number],
      axis: [1, 0] as [number, number],
      spanMm: 14.5,
      clearanceMm: 5,
      groundZ: 3,
      deckZ: 8.6,
      foundationZ: 2.7,
      minThicknessMm: 0.4,
      profile: "basket-handle" as const,
    };
    assert.equal(
      makeSurveyedArch(cad, owner, { ...options, spanMm: NaN }),
      null,
    );
    assert.equal(
      makeSurveyedArch(cad, owner, { ...options, deckZ: 8.1 }),
      null,
    );
    assert.equal(
      makeSurveyedArch(cad, owner, { ...options, axis: [0, 1] }),
      null,
      "the short axis cannot hold the documented span",
    );
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});
