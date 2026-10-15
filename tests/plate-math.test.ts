import test from "node:test";
import assert from "node:assert/strict";
import { plateFitFactor, physicalPlateDimensions } from "../src/lib/plate-math";

test("plate numeric boundaries reject nonfinite, degenerate and overflowing projects before planning", () => {
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => plateFitFactor(invalid, 2000, 2, 2, 145));
    assert.throws(() => plateFitFactor(2000, invalid, 2, 2, 145));
    assert.throws(() => physicalPlateDimensions(2000, 2000, invalid, 95));
    assert.throws(() => physicalPlateDimensions(invalid, 2000, 3000, 95));
  }
  for (const invalid of [0, -1, 1.5, 26, NaN, Infinity])
    assert.throws(() => plateFitFactor(2000, 2000, invalid, 2, 145));
  assert.throws(() =>
    plateFitFactor(Number.MIN_VALUE, Number.MIN_VALUE, 2, 2, 145),
  );
  assert.throws(() =>
    physicalPlateDimensions(Number.MAX_VALUE, 2000, Number.MIN_VALUE, 95),
  );
  const factor = plateFitFactor(1000, 2000, 1, 2, 145);
  const result = physicalPlateDimensions(1000, 2000, 1000 / factor, 145);
  assert.deepEqual(result, { widthMm: 145, depthMm: 290, cols: 1, rows: 2 });
});
