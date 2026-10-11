import assert from "node:assert/strict";
import test from "node:test";
import Module, { type Manifold } from "manifold-3d";
import {
  makeAqueduct,
  type AqueductOptions,
} from "../src/lib/mesh/aqueduct-solid";
import { assertClosedSolid } from "./helpers/solid";
import { createProjectionForBbox } from "../src/lib/projection";
import { getBboxDimensions } from "../src/lib/mesh/base-plate-mesh";
import type { BBox } from "../src/types/osm";

const runtime = Module().then((cad) => {
  cad.setup();
  return cad;
});
function arena() {
  const handles: { delete(): void }[] = [];
  return {
    keep<T extends { delete(): void }>(handle: T): T {
      handles.push(handle);
      return handle;
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
function options(clip: AqueductOptions["clip"]): AqueductOptions {
  return {
    axisPolylineMm: [
      [0, 0],
      [111.75, 0],
    ],
    sections: [
      { fromMm: 0, toMm: 60.75, kind: "pitot-double" },
      { fromMm: 60.75, toMm: 111.75, kind: "giral-terminal", spanCount: 3 },
    ],
    clip,
    surfaceAt: (x) => 3 + 0.03 * x,
    terrainMaxZ: 7,
    foundationZ: 1,
    deckZMm: 30,
    scaleFactor: 1,
    minFeatureMm: 0.8,
  };
}

test("documented double arcades and the three terminal spans have true through openings and a constant deck", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const clip = owner.keep(
      owner.keep(cad.CrossSection.square([115, 12])).translate([-1, -6]),
    );
    const aqueduct = makeAqueduct(cad, owner, options(clip));
    assert.ok(aqueduct);
    assert.equal(aqueduct.largeSpanCount, 8);
    assert.equal(aqueduct.smallSpanCount, 15);
    assert.equal(aqueduct.spanCount, 23);
    assert.equal(aqueduct.boundarySupportCount, 0);
    assert.equal(aqueduct.approximateGeometry, true);
    closed(aqueduct.solid);
    closed(aqueduct.cutter);
    assert.ok(Math.abs(aqueduct.solid.boundingBox().max[2] - 30) < 1e-5);
    assert.ok(aqueduct.cutter.boundingBox().min[2] >= 1);
    const probe = (x: number, z: number) =>
      owner.keep(
        owner
          .keep(cad.Manifold.cube([0.15, 5, 0.15]))
          .translate([x - 0.075, -2.5, z]),
      );
    for (const [x, z] of [
      [6.075, 12],
      [6.075, 26],
      [69.25, 25],
    ]) {
      assert.equal(
        owner.keep(aqueduct.solid.intersect(probe(x, z))).volume(),
        0,
        "a full transverse passage remains empty",
      );
      assert.ok(
        owner.keep(aqueduct.cutter.intersect(probe(x, z))).volume() > 0,
      );
    }
    const terrain = owner.keep(
      owner.keep(cad.Manifold.cube([115, 12, 3])).translate([-1, -6, 0]),
    );
    const merged = owner.keep(
      owner.keep(terrain.subtract(aqueduct.cutter)).add(aqueduct.solid),
    );
    closed(merged);
    const pieces = merged.decompose();
    assert.equal(pieces.filter((p) => p.volume() > 0).length, 1);
    pieces.forEach((p) => p.delete());
  } finally {
    owner.dispose();
  }
});

test("a cropped arch receives a declared boundary support without filling its passage", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const clip = owner.keep(
      owner.keep(cad.CrossSection.square([6, 8])).translate([3, -4]),
    );
    const aqueduct = makeAqueduct(cad, owner, options(clip));
    assert.ok(aqueduct);
    assert.ok(aqueduct.boundarySupportCount >= 1);
    assert.equal(aqueduct.modifiedForPrinting, true);
    assert.ok(
      aqueduct.assumptions.some((a) => /bord.*coupe|coupe.*sélection/i.test(a)),
    );
    closed(aqueduct.solid);
    closed(aqueduct.cutter);
    const bounds = aqueduct.solid.boundingBox();
    assert.ok(bounds.min[0] >= 3 - 1e-5 && bounds.max[0] <= 9 + 1e-5);
    const center = owner.keep(
      owner.keep(cad.Manifold.cube([0.2, 1, 0.2])).translate([5.9, -0.5, 12]),
    );
    assert.equal(
      owner.keep(aqueduct.solid.intersect(center)).volume(),
      0,
      "support stays at the crop boundary",
    );
    const terrain = owner.keep(
      owner.keep(cad.Manifold.cube([6, 8, 3])).translate([3, -4, 0]),
    );
    const merged = owner.keep(
      owner.keep(terrain.subtract(aqueduct.cutter)).add(aqueduct.solid),
    );
    closed(merged);
    const pieces = merged.decompose();
    assert.equal(pieces.filter((p) => p.volume() > 0).length, 1);
    pieces.forEach((p) => p.delete());
  } finally {
    owner.dispose();
  }
});

test("a gently bent mapped axis keeps the tapered aqueduct closed", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const clip = owner.keep(
      owner.keep(cad.CrossSection.square([105, 15])).translate([-2, -6]),
    );
    const input = options(clip);
    input.axisPolylineMm = [
      [0, 0],
      [30, 0],
      [60, 2],
      [100, 2],
    ];
    const length = 30 + Math.hypot(30, 2) + 40;
    input.sections = [{ fromMm: 0, toMm: length, kind: "pitot-double" }];
    const aqueduct = makeAqueduct(cad, owner, input);
    assert.ok(aqueduct);
    closed(aqueduct.solid);
    closed(aqueduct.cutter);
    assert.ok(aqueduct.largeSpanCount >= 8);
    assert.ok(Math.abs(aqueduct.solid.boundingBox().max[2] - 30) < 1e-5);
  } finally {
    owner.dispose();
  }
});

test("the mapped Arceaux axis stays closed at a 300 mm Peyrou selection", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    // OpenStreetMap way 380742761, acquired on 2026-10-11 (ODbL).
    // The relief below is a test plane, not a substitute for the IGN dataset.
    const bbox: BBox = [43.6096, 3.8665, 43.6137, 3.8754];
    const geography = getBboxDimensions(bbox, 1000);
    const sf = 300 / Math.max(geography.widthMm, geography.heightMm);
    const projection = createProjectionForBbox(bbox);
    const axis = [
      [43.6107902, 3.8582841],
      [43.610902, 3.8586318],
      [43.6109932, 3.8587359],
      [43.6111246, 3.8592729],
      [43.611136, 3.8592813],
      [43.6119051, 3.8620898],
      [43.6113981, 3.8688846],
    ].map(
      ([lat, lon]) =>
        projection.project(lon, lat).map((value) => value * sf) as [
          number,
          number,
        ],
    );
    const length = axis
      .slice(1)
      .reduce(
        (sum, point, i) =>
          sum + Math.hypot(point[0] - axis[i][0], point[1] - axis[i][1]),
        0,
      );
    const width = geography.widthMm * sf,
      height = geography.heightMm * sf;
    const clip = owner.keep(
      owner
        .keep(cad.CrossSection.square([width, height]))
        .translate([-width / 2, -height / 2]),
    );
    const input: AqueductOptions = {
      axisPolylineMm: axis,
      sections: [
        { fromMm: 0, toMm: length - 51 * sf, kind: "pitot-double" },
        {
          fromMm: length - 51 * sf,
          toMm: length,
          kind: "giral-terminal",
          spanCount: 3,
        },
      ],
      clip,
      surfaceAt: (x) => Math.max(3, 11 + 0.005 * x),
      terrainMaxZ: 14.3,
      foundationZ: 2.7,
      deckZMm: 3 + (57.774 - 27.5) * sf,
      scaleFactor: sf,
      minFeatureMm: 0.8,
    };
    const aqueduct = makeAqueduct(cad, owner, input);
    assert.ok(aqueduct);
    closed(aqueduct.solid);
    closed(aqueduct.cutter);
    assert.equal(
      aqueduct.largeSpanCount,
      16,
      "only the visible opening portions are counted",
    );
    assert.equal(aqueduct.smallSpanCount, 36);
    assert.equal(aqueduct.modifiedForPrinting, true);
    assert.ok(aqueduct.solid.boundingBox().min[0] >= -width / 2 - 1e-5);
    assert.ok(
      Math.abs(
        aqueduct.solid.boundingBox().max[2] - (3 + (57.774 - 27.5) * sf),
      ) < 1e-5,
    );
    // This bbox contains ~193 m of axis. A separate 96 m terminal crop checks
    // the shorter view independently, including material in the actual piers.
    const end = axis.at(-1)!,
      before = axis.at(-2)!;
    const segmentLength = Math.hypot(end[0] - before[0], end[1] - before[1]);
    const direction = [
      (end[0] - before[0]) / segmentLength,
      (end[1] - before[1]) / segmentLength,
    ];
    const normal = [-direction[1], direction[0]];
    const pointAt = (distance: number): [number, number] => [
      end[0] + (distance - length) * direction[0],
      end[1] + (distance - length) * direction[1],
    ];
    const narrowStart = pointAt(length - 96 * sf);
    const narrowClip = owner.keep(
      new cad.CrossSection(
        [
          [
            [
              narrowStart[0] - normal[0] * 4 * sf,
              narrowStart[1] - normal[1] * 4 * sf,
            ],
            [end[0] - normal[0] * 4 * sf, end[1] - normal[1] * 4 * sf],
            [end[0] + normal[0] * 4 * sf, end[1] + normal[1] * 4 * sf],
            [
              narrowStart[0] + normal[0] * 4 * sf,
              narrowStart[1] + normal[1] * 4 * sf,
            ],
          ],
        ],
        "NonZero",
      ),
    );
    const narrow = makeAqueduct(cad, owner, { ...input, clip: narrowClip });
    assert.ok(narrow);
    closed(narrow.solid);
    closed(narrow.cutter);
    assert.equal(narrow.largeSpanCount, 8);
    assert.equal(narrow.smallSpanCount, 12);
    const angle = (Math.atan2(direction[1], direction[0]) * 180) / Math.PI;
    const probe = (distance: number, z: number, through: boolean) => {
      const xy = pointAt(distance);
      return owner.keep(
        owner
          .keep(
            owner
              .keep(
                cad.Manifold.cube(
                  [0.1, through ? 4 * sf + 0.2 : 0.1, 0.1],
                  true,
                ),
              )
              .rotate([0, 0, angle]),
          )
          .translate([xy[0], xy[1], z]),
      );
    };
    const voidAt = (distance: number, z: number) => {
      const box = probe(distance, z, true);
      assert.equal(
        owner.keep(narrow.solid.intersect(box)).volume(),
        0,
        "an opening is empty across the entire aqueduct width",
      );
      assert.ok(owner.keep(narrow.cutter.intersect(box)).volume() > 0);
    };
    const pierAt = (distance: number, z: number) => {
      assert.ok(
        owner.keep(narrow.solid.intersect(probe(distance, z, false))).volume() >
          0.0009,
        "the intervening pier is actual masonry",
      );
    };
    const upperCrown = input.deckZMm - 0.4;
    for (let span = 0; span < 3; span++)
      voidAt(length - 51 * sf + (span + 0.5) * 17 * sf, upperCrown - 0.4);
    for (let pier = 1; pier < 3; pier++)
      pierAt(length - 51 * sf + pier * 17 * sf, upperCrown - 0.4);
    const pitch = 12.15 * sf;
    const moduleIndex = Math.floor((length - 75 * sf) / pitch);
    const lowerCrown = upperCrown - 5.25 * sf - 0.4;
    voidAt((moduleIndex + 0.5) * pitch, lowerCrown - 0.2);
    pierAt((moduleIndex + 1) * pitch, lowerCrown - 0.2);
    const upperMiddle = upperCrown - (5.25 * sf) / 2;
    voidAt((moduleIndex + 0.5) * pitch, upperMiddle);
    pierAt((moduleIndex + 1 / 3) * pitch, upperMiddle);
  } finally {
    owner.dispose();
  }
});

test("unprovided terminal counts and dimensions too fine to print refuse a fabricated aqueduct", async () => {
  const cad = await runtime,
    owner = arena();
  try {
    const clip = owner.keep(cad.CrossSection.square([200, 200], true));
    const input = options(clip);
    input.sections = [{ fromMm: 0, toMm: 50, kind: "giral-terminal" }];
    assert.equal(makeAqueduct(cad, owner, input), null);
    input.sections = [{ fromMm: 0, toMm: 50, kind: "pitot-double" }];
    input.scaleFactor = 0.05;
    assert.equal(makeAqueduct(cad, owner, input), null);
  } finally {
    owner.dispose();
  }
});
