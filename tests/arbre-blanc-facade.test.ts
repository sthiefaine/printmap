import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Module from "manifold-3d";
import documented from "../src/lib/data/arbre-blanc-facade.json";
import observed from "../src/lib/data/arbre-blanc-lidar.json";
import { toLambert93 } from "../src/lib/data/lambert93";
import { geographicPointInRing } from "../src/lib/osm/relation-polygons";
import { makeArbreBlanc } from "../src/lib/mesh/arbre-blanc";
import { parseElements } from "../src/lib/osm/parse-elements";
import { createProjectionForBbox } from "../src/lib/projection";
import type { PrintInput, PrintMesh } from "../src/types/print";
import { assertClosedSolid } from "./helpers/solid";

// These two positions were fixed from the published plan comparison, before
// rebuilding any meshes. They lie in overhangs which OSM filled as facade.
const removedWitnesses = [
  { lon: 3.898008088223105, lat: 43.6059858459701 },
  { lon: 3.898006546332201, lat: 43.605744056633434 },
];

test("the documentary facade changes only two mapped overhang lobes and retains every other OSM vertex", async () => {
  assert.equal(documented.sourceId, "MMM/B102558");
  assert.equal(documented.interpretation.completeFacadeSurvey, false);
  assert.equal(documented.interpretation.arbitraryBalconyCopies, false);
  assert.equal(documented.interpretation.horizontalUncertaintyM, 1);
  assert.deepEqual(
    documented.sourcePlans.map((plan) => plan.level),
    ["R+9", "R+16"],
  );
  for (const index of documented.interpretation.baselineUnchangedVertexIndices)
    assert.ok(
      documented.facadeFootprint.outer.some(
        (point) =>
          point.lat === observed.coreFootprint.outer[index].lat &&
          point.lon === observed.coreFootprint.outer[index].lon,
      ),
    );
  for (const point of removedWitnesses) {
    assert.ok(geographicPointInRing(point, observed.coreFootprint.outer));
    assert.equal(
      geographicPointInRing(point, documented.facadeFootprint.outer),
      false,
    );
  }
  // A central occupied apartment/circulation point stays in both envelopes.
  const occupied = { lat: 43.6059, lon: 3.89815 };
  assert.ok(geographicPointInRing(occupied, documented.facadeFootprint.outer));
  const cad = await Module();
  cad.setup();
  const rings = [
    observed.referenceBoundariesLambert93.core.outer,
    documented.referenceBoundaryLambert93.outer,
  ];
  const origin = rings[0][0];
  const sections = rings.map(
    (ring) =>
      new cad.CrossSection(
        [
          ring.map(([x, y]): [number, number] => [
            x - origin[0],
            y - origin[1],
          ]),
        ],
        "EvenOdd",
      ),
  );
  const [original, facade] = sections;
  const outside = facade.subtract(original),
    removed = original.subtract(facade);
  const pieces = removed.decompose();
  try {
    assert.ok(
      outside.area() < 0.000001,
      "the interpretation adds no occupied facade outside OSM",
    );
    assert.equal(pieces.length, 2);
    assert.ok(pieces.every((piece) => piece.area() > 28 && piece.area() < 31));
    assert.ok(Math.abs(facade.area() - 759.175380427) < 0.001);
    assert.ok(Math.abs(original.area() - facade.area() - 58.901638139) < 0.001);
  } finally {
    for (const item of [...pieces, removed, outside, ...sections])
      item.delete();
  }
});

/** Independent upward ray winding of a closed boundary, with coplanar triangle
 * hits deduplicated. Test points come from the plan comparison, not the mesh. */
function materialAt(mesh: PrintMesh, x: number, y: number, z: number) {
  const hits: { z: number; direction: number }[] = [];
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), (v) => v * 3);
    const determinant =
      (p[b] - p[a]) * (p[c + 1] - p[a + 1]) -
      (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
    if (Math.abs(determinant) < 1e-12) continue;
    const u =
      ((x - p[a]) * (p[c + 1] - p[a + 1]) - (y - p[a + 1]) * (p[c] - p[a])) /
      determinant;
    const v =
      ((p[b] - p[a]) * (y - p[a + 1]) - (p[b + 1] - p[a + 1]) * (x - p[a])) /
      determinant;
    if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
    const height =
      p[a + 2] + u * (p[b + 2] - p[a + 2]) + v * (p[c + 2] - p[a + 2]);
    if (height > z + 0.00001)
      hits.push({ z: height, direction: Math.sign(determinant) });
  }
  hits.sort((a, b) => a.z - b.z);
  let winding = 0,
    previous: (typeof hits)[number] | undefined;
  for (const hit of hits) {
    if (
      !previous ||
      Math.abs(hit.z - previous.z) > 0.00001 ||
      hit.direction !== previous.direction
    )
      winding += hit.direction;
    previous = hit;
  }
  return winding > 0;
}

test("native printable bodies remove the two local columns while keeping occupied facade, rooftop and foundation", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/montpellier-arbre-blanc-roof.json", import.meta.url),
      "utf8",
    ),
  ) as Pick<PrintInput, "osmData">;
  const bbox: PrintInput["bbox"] = [
    43.601407977642914, 3.893206659524327, 43.607928059285825,
    3.9022093950324357,
  ];
  const originLat = 43.594887896,
    sf = 0.2;
  const projection = createProjectionForBbox(bbox, originLat);
  const building = parseElements(
    fixture.osmData.elements,
    bbox,
    5000,
    originLat,
  ).buildings[0];
  const cad = await Module();
  cad.setup();
  const handles: { delete(): void }[] = [];
  const owner = {
    keep<T extends { delete(): void }>(item: T) {
      handles.push(item);
      return item;
    },
  };
  try {
    const footprint = owner.keep(
      new cad.CrossSection(
        [building.polygon.outer, ...building.polygon.holes],
        "EvenOdd",
      ),
    );
    const clip = owner.keep(cad.CrossSection.square([145, 145], true));
    const bodies = [false, true].map((documentedFacade) =>
      makeArbreBlanc(cad, owner, {
        surfaces: building.roofSurfaces!,
        groundElevation: building.groundElevation!,
        project: projection.project,
        scaleFactor: sf,
        buildingScale: 1,
        surfaceZ: 3 + building.groundElevation! * sf,
        foundationZ: 2.7,
        footprint,
        clip,
        minimumHeight: 0.35,
        minFeatureMm: 0.45,
        documentedFacade,
      }),
    );
    assert.ok(bodies[0]);
    assert.ok(bodies[1]);
    const meshes = bodies.map((result) => {
      assert.ok(result);
      assert.equal(result.estimatedBody, true);
      assert.equal(result.retainedLevelCount, 17);
      const native = result.solid.getMesh();
      const mesh = {
        positions: native.vertProperties,
        indices: native.triVerts,
        faceLayers: new Uint8Array(native.triVerts.length / 3),
      };
      const volume = assertClosedSolid(mesh);
      assert.ok(
        Math.abs(result.repairVolumeDeltaMm3) <= volume * 0.0001 + 0.00001,
      );
      assert.ok(Math.abs(result.solid.boundingBox().min[2] - 2.7) < 0.0001);
      assert.ok(
        Math.abs(result.solid.boundingBox().max[2] - (3 + 68.571 * sf)) < 0.001,
      );
      return mesh;
    });
    assert.equal(bodies[0].documentedBody, false);
    assert.equal(bodies[1].documentedBody, true);
    assert.ok(
      bodies[1].maximumInferredConnectionM < 4.7,
      "the two local corrections do not justify a general 7.5m connection allowance",
    );
    for (const point of removedWitnesses) {
      const [px, py] = projection.project(point.lon, point.lat);
      for (const elevationM of [
        15, 18.6, 21.5, 24.3, 27, 30, 40.5, 48.5, 60.5,
      ]) {
        const z = 3 + elevationM * sf;
        assert.equal(
          materialAt(meshes[0], px * sf, py * sf, z),
          true,
          "original proxy occupied the overhang as a column",
        );
        assert.equal(
          materialAt(meshes[1], px * sf, py * sf, z),
          false,
          "documented setback keeps air between real terrace levels",
        );
      }
    }
    const [px, py] = projection.project(3.89815, 43.6059);
    for (const elevationM of [15, 25, 40, 60])
      assert.ok(
        meshes.every((mesh) =>
          materialAt(mesh, px * sf, py * sf, 3 + elevationM * sf),
        ),
        "the occupied central facade is retained at all tested heights",
      );
  } finally {
    for (const handle of handles.reverse()) handle.delete();
  }
});

test("both published floor plans constrain the southwest facade bend within the declared documentary uncertainty", () => {
  const registration = documented.interpretation.registration;
  const north = registration.northLambert93,
    south = registration.southLambert93;
  function bendFromPlan(
    northPixel: number[],
    southPixel: number[],
    bendPixel: number[],
  ) {
    const dx = south[0] - north[0],
      dy = -(south[1] - north[1]);
    const px = southPixel[0] - northPixel[0],
      py = southPixel[1] - northPixel[1];
    // Independent inverse similarity; drawing Y points down, Lambert north up.
    const denominator = px * px + py * py;
    const real = (dx * px + dy * py) / denominator;
    const imaginary = (dy * px - dx * py) / denominator;
    const bx = bendPixel[0] - northPixel[0],
      by = bendPixel[1] - northPixel[1];
    return [
      north[0] + real * bx - imaginary * by,
      north[1] - imaginary * bx - real * by,
    ];
  }
  const r9 = bendFromPlan(
    registration.northPixel,
    registration.southPixel,
    registration.southWestFacadeBendPixel,
  );
  const r16 = bendFromPlan(
    documented.interpretation.crossCheckR16.northPixel,
    documented.interpretation.crossCheckR16.southPixel,
    documented.interpretation.crossCheckR16.southWestFacadeBendPixel,
  );
  const actual = documented.facadeFootprint.outer.at(-2)!;
  const target = toLambert93(actual.lon, actual.lat);
  assert.ok(Math.hypot(target[0] - r9[0], target[1] - r9[1]) < 0.001);
  assert.ok(Math.hypot(target[0] - r16[0], target[1] - r16[1]) < 0.15);
  assert.ok(
    Math.hypot(r9[0] - r16[0], r9[1] - r16[1]) <
      documented.interpretation.horizontalUncertaintyM,
  );
});
