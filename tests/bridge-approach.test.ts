import assert from "node:assert/strict";
import test from "node:test";
import Module, { type Manifold } from "manifold-3d";
import {
  makeMeasuredBridgeApproach,
  type BridgeApproachOptions,
} from "../src/lib/mesh/measured-bridge-approach";
import { makeSurveyedArch } from "../src/lib/mesh/bridge-solid";
import { assertClosedSolid } from "./helpers/solid";
import { readFileSync } from "node:fs";
import { parseElements } from "../src/lib/osm/parse-elements";
import { createProjectionForBbox } from "../src/lib/projection";
import { sampleElevation } from "../src/lib/elevation/sample-grid";
import type { BBox, ElevationGrid, OverpassResponse } from "../src/types/osm";
const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});
function arena() {
  const handles: { delete(): void }[] = [];
  return {
    keep<T extends { delete(): void }>(h: T) {
      handles.push(h);
      return h;
    },
    dispose() {
      for (let i = handles.length - 1; i >= 0; i--) handles[i].delete();
    },
  };
}
function closed(solid: Manifold) {
  const mesh = solid.getMesh();
  return assertClosedSolid({
    positions: mesh.vertProperties,
    indices: mesh.triVerts,
    faceLayers: new Uint8Array(mesh.triVerts.length / 3),
  });
}
function input(
  footprint: BridgeApproachOptions["footprint"],
  clip: BridgeApproachOptions["clip"],
): BridgeApproachOptions {
  const road = (
    id: number,
    polyline: [number, number][],
    underground: boolean,
  ) => ({
    polyline,
    roadType: "pedestrian",
    isBridge: false,
    isUnderground: underground,
    tags: {
      name: "Lower boulevard",
      ...(underground ? { tunnel: "yes", layer: "-1" } : {}),
    },
    sourceId: `way/${id}`,
  });
  return {
    footprint,
    clip,
    center: [0, 0],
    axis: [1, 0],
    spanMm: 14.5,
    resolutionMm: 5,
    terrainMaxZ: 10,
    foundationZ: 1,
    surfaceAt: (x, y) => 3 + y * 0.01 + (Math.abs(y) < 18 ? 4 : 0),
    roads: [
      road(
        1,
        [
          [0, -15],
          [0, 0],
        ],
        true,
      ),
      road(
        2,
        [
          [0, 0],
          [0, 15],
        ],
        true,
      ),
      road(
        3,
        [
          [0, -60],
          [0, -15],
        ],
        false,
      ),
      road(
        4,
        [
          [0, 15],
          [0, 60],
        ],
        false,
      ),
      {
        polyline: [
          [-20, 0],
          [0, 0],
          [20, 0],
        ],
        roadType: "service",
        isBridge: false,
        isUnderground: true,
        tags: { tunnel: "yes", name: "Parking tunnel" },
        sourceId: "way/5",
      },
    ],
  };
}

test("Vialleton uses the actual lower boulevard and an IGN grade independent of printer thickness", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/montpellier-vialleton-approaches.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      bbox: BBox;
      scale: number;
      osmData: OverpassResponse;
      elevationGrid: ElevationGrid;
    };
    const sf = 1000 / fixture.scale,
      projection = createProjectionForBbox(fixture.bbox);
    const parsed = parseElements(
      fixture.osmData.elements,
      fixture.bbox,
      fixture.scale,
    );
    const polygon = parsed.bridges.find(
      (bridge) => bridge.tags.name === "Pont Vialleton",
    )!.polygon;
    const footprint = owner.keep(
      new cad.CrossSection([polygon.outer, ...polygon.holes], "EvenOdd"),
    );
    const clip = owner.keep(cad.CrossSection.square([300, 300], true));
    const carried = parsed.roads.find(
      (road) => road.sourceId === "way/83835240",
    )!.polyline;
    const center: [number, number] = [
      (carried[0][0] + carried[1][0]) / 2,
      (carried[0][1] + carried[1][1]) / 2,
    ];
    const axis: [number, number] = [
      carried[1][0] - carried[0][0],
      carried[1][1] - carried[0][1],
    ];
    const surfaceAt = (x: number, y: number) => {
      const [lon, lat] = projection.unproject(x / sf, y / sf);
      return (
        3 +
        (sampleElevation(fixture.elevationGrid, lat, lon) -
          fixture.elevationGrid.minElev) *
          sf
      );
    };
    const approach = makeMeasuredBridgeApproach(cad, owner, {
      footprint,
      clip,
      center,
      axis,
      roads: parsed.roads,
      spanMm: 14.5 * sf,
      resolutionMm: fixture.elevationGrid.resolutionM! * sf,
      terrainMaxZ:
        3 +
        (fixture.elevationGrid.maxElev - fixture.elevationGrid.minElev) * sf,
      foundationZ: 2.7,
      surfaceAt,
    });
    assert.ok(approach);
    const elevation =
      (approach.groundZ - 3) / sf + fixture.elevationGrid.minElev;
    assert.ok(
      elevation > 44.1 && elevation < 44.9,
      `outside road grade ${elevation} m follows the lower boulevard`,
    );
    assert.deepEqual(
      new Set(approach.sourceIds),
      new Set([
        "way/1280882724",
        "way/1305300159",
        "way/436716257",
        "way/36884475",
      ]),
    );
    const [lon, lat] = projection.unproject(
      approach.center[0] / sf,
      approach.center[1] / sf,
    );
    assert.ok(
      Math.abs(lon - 3.872245) < 0.00001 && Math.abs(lat - 43.611147) < 0.00001,
      "center lies on the actual crossing, not on the parking tunnel",
    );
    closed(approach.floorSolid);
    closed(approach.cutter);
    const deckZ = 3 + (51.2 - fixture.elevationGrid.minElev) * sf;
    for (const minThicknessMm of [0.4, 0.45, 0.8]) {
      const arch = makeSurveyedArch(cad, owner, {
        footprint,
        clip,
        center: approach.center,
        axis: approach.axis,
        spanMm: 14.5 * sf,
        clearanceMm: 5 * sf,
        groundZ: approach.groundZ,
        deckZ,
        foundationZ: 2.7,
        minThicknessMm,
        profile: "basket-handle",
      });
      assert.ok(arch);
      closed(arch.solid);
      closed(arch.cutter);
      const probe: Manifold = owner.keep(
        owner
          .keep(cad.Manifold.cube([0.2, 0.2, 0.2], true))
          .translate([
            approach.center[0],
            approach.center[1],
            approach.groundZ + sf,
          ]),
      );
      assert.equal(owner.keep(arch.solid.intersect(probe)).volume(), 0);
    }
  } finally {
    owner.dispose();
  }
});
test("a documented underpass grade comes from connected outside road samples and stays bounded", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const footprint = owner.keep(cad.CrossSection.square([18.9, 30], true));
    const clip = owner.keep(cad.CrossSection.square([100, 100], true));
    const approach = makeMeasuredBridgeApproach(
      cad,
      owner,
      input(footprint, clip),
    );
    assert.ok(approach);
    assert.deepEqual(approach.center, [0, 0]);
    assert.equal(approach.mode, "estimated-from-dem");
    assert.ok(Math.abs(approach.groundZ - 3) < 1e-6);
    assert.ok(Math.abs(approach.slopePercent - 1) < 1e-6);
    assert.equal(approach.sampleCount, 18);
    assert.equal(approach.correctionLengthMm, 50);
    assert.equal(approach.sourceIds.length, 4);
    assert.ok(!approach.sourceIds.includes("way/5"));
    closed(approach.floorSolid);
    closed(approach.cutter);
    assert.deepEqual(approach.section.bounds(), {
      min: [-7.25, -25],
      max: [7.25, 25],
    });
    assert.ok(approach.floorSolid.boundingBox().min[2] > 0.99);
    const terrain = owner.keep(
      owner.keep(cad.Manifold.cube([100, 100, 8])).translate([-50, -50, 0]),
    );
    const corrected = owner.keep(
      owner.keep(terrain.subtract(approach.cutter)).add(approach.floorSolid),
    );
    const bridge = makeSurveyedArch(cad, owner, {
      footprint,
      clip,
      center: approach.center,
      axis: approach.axis,
      spanMm: 14.5,
      clearanceMm: 5,
      groundZ: approach.groundZ,
      deckZ: 8.4,
      foundationZ: 1,
      minThicknessMm: 0.4,
      profile: "basket-handle",
    });
    assert.ok(bridge);
    const full = owner.keep(
      owner.keep(corrected.subtract(bridge.cutter)).add(bridge.solid),
    );
    closed(full);
    const passage = owner.keep(
      owner.keep(cad.Manifold.cube([0.2, 46, 0.2])).translate([-0.1, -23, 4]),
    );
    assert.equal(
      owner.keep(full.intersect(passage)).volume(),
      0,
      "the arch and both road accesses are open",
    );
    const exterior = owner.keep(
      owner.keep(cad.Manifold.cube([0.2, 0.2, 0.2])).translate([10, 20, 5]),
    );
    assert.ok(
      owner.keep(full.intersect(exterior)).volume() > 0.00799,
      "terrain outside the documented passage band remains intact",
    );
    const bedplate = owner.keep(
      owner.keep(cad.Manifold.cube([1, 1, 0.5])).translate([-0.5, -0.5, 0]),
    );
    assert.equal(owner.keep(full.intersect(bedplate)).volume(), 0.5);
  } finally {
    owner.dispose();
  }
});
test("deep tunnels, missing connections and steep unsupported grades cannot flatten an access", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const footprint = owner.keep(cad.CrossSection.square([18.9, 30], true)),
      clip = owner.keep(cad.CrossSection.square([100, 100], true)),
      options = input(footprint, clip);
    assert.equal(
      makeMeasuredBridgeApproach(cad, owner, {
        ...options,
        roads: options.roads.filter((r) => r.sourceId === "way/5"),
      }),
      null,
    );
    assert.equal(
      makeMeasuredBridgeApproach(cad, owner, {
        ...options,
        roads: options.roads.filter((r) => r.isUnderground),
      }),
      null,
    );
    assert.equal(
      makeMeasuredBridgeApproach(cad, owner, {
        ...options,
        surfaceAt: (_x, y) => 10 + y * 0.1,
      }),
      null,
    );
  } finally {
    owner.dispose();
  }
});
