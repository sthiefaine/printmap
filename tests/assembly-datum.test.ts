import test from "node:test";
import assert from "node:assert/strict";
import { initialAssemblyDatum } from "../src/lib/assembly-project";

test("an inland assembly reserves local relief headroom rather than filling down to sea level", () => {
  const datum = initialAssemblyDatum(540);
  const printedGroundMm = 3 + ((540 - datum) * 1000) / 5000;
  assert.ok(printedGroundMm >= 13 && printedGroundMm <= 23);
  assert.ok(datum < 540 && 540 - datum >= 50);
  assert.equal(
    initialAssemblyDatum(25),
    0,
    "Montpellier keeps a reference that permits extensions towards the sea",
  );
  assert.ok(
    initialAssemblyDatum(-430) < -430,
    "below-sea-level terrain still has a lower foundation",
  );
  for (const invalid of [NaN, Infinity, -Infinity, -12000, 9000])
    assert.throws(() => initialAssemblyDatum(invalid));
});
