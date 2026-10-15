import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const executable = fileURLToPath(
  new URL("node_modules/@chenglou/freerange/dist/fr.js", root),
);
const result = spawnSync(
  process.execPath,
  [executable, "--audit", "src/lib/plate-math.ts"],
  { cwd: fileURLToPath(root), encoding: "utf8" },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
const coverage = result.stdout?.match(
  /\((\d+)\/(\d+) functions fully analyzed\)/,
);
if (
  result.error ||
  result.status !== 0 ||
  !coverage ||
  coverage[1] !== coverage[2] ||
  Number(coverage[1]) === 0
) {
  console.error(
    "L’analyse numérique des plaques doit être complète et sans erreur.",
  );
  process.exitCode = 1;
}
// --audit describes coverage/contracts but does not fail on numeric findings.
// The ordinary analysis must also succeed; full coverage alone is insufficient.
const findings = spawnSync(
  process.execPath,
  [executable, "src/lib/plate-math.ts"],
  {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  },
);
process.stdout.write(findings.stdout ?? "");
process.stderr.write(findings.stderr ?? "");
if (findings.error || findings.status !== 0) {
  console.error("Freerange a détecté une erreur dans les calculs des plaques.");
  process.exitCode = 1;
}
