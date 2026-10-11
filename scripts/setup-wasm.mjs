import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Keep the browser's WASM binary in sync with the locked npm dependency.
const source = fileURLToPath(import.meta.resolve("manifold-3d/manifold.wasm"));
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await copyFile(source, new URL("../public/manifold.wasm", import.meta.url));

// MapLibre 6 resolves its worker at runtime relative to import.meta.url. Serving
// its native module worker avoids a bundler-dependent URL in dev and production.
const maplibre = import.meta.resolve("maplibre-gl");
await mkdir(new URL("../public/maplibre/", import.meta.url), {
  recursive: true,
});
for (const name of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  await copyFile(
    new URL(name, maplibre),
    new URL(`../public/maplibre/${name}`, import.meta.url),
  );
}
