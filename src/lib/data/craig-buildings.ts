import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type { BBox } from "@/types/osm";
import type { Lod2Building } from "./citygml-parser";
import type { MunicipalRoofs } from "./montpellier-lod2";
import { parseCityJSONBuildings } from "./cityjson-parser";
import { fetchWithTimeout } from "./request";

export const CRAIG_BUILDINGS_SOURCE =
  "CRAIG - FEDER Auvergne-Rhône-Alpes - 2021 · Bâti3D LoD2.2";
export const CRAIG_BUILDINGS_REFERENCE =
  "https://www.data.gouv.fr/datasets/maquette-3d-batiments-auvergne-rhone-alpes-2021";
export const CRAIG_BUILDINGS_URL =
  "https://drive.opendata.craig.fr/public.php/webdav/3d/2021_aura_3d/02_Bati3D/CityJSON/Secteur_08_Saint-Etienne/Secteur_8_StEtienne_Textured_L93_v2.json";
export const CRAIG_ST_ETIENNE_COVERAGE: BBox = [
  45.4308647, 4.3814778, 45.4378836, 4.3944547,
];
const cachePath = path.join(
  process.cwd(),
  ".cache",
  "printmap",
  "craig-st-etienne-2021-v1.json.gz",
);
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;
const compress = promisify(gzip),
  decompress = promisify(gunzip);
let inFlight: Promise<ReturnType<typeof parseCityJSONBuildings>> | undefined;
const intersects = (a: BBox, b: BBox) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

async function acquire(signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    const info = await stat(cachePath);
    if (Date.now() - info.mtimeMs < TTL && info.size <= MAX_BYTES) {
      const raw = await decompress(await readFile(cachePath), {
        maxOutputLength: MAX_BYTES,
      });
      return parseCityJSONBuildings(JSON.parse(raw.toString()), {
        source: CRAIG_BUILDINGS_SOURCE,
        year: 2021,
      });
    }
  } catch {
    signal.throwIfAborted();
  }
  const response = await fetchWithTimeout(
    CRAIG_BUILDINGS_URL,
    {
      // Official public WebDAV account: user "opendata", empty password.
      // https://ids.craig.fr/home/services/opendata/
      headers: { Authorization: "Basic b3BlbmRhdGE6" },
    },
    signal,
    35000,
  );
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length")) > MAX_BYTES
  )
    throw new Error("Bâti3D CRAIG indisponible ou trop volumineux.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES)
        throw new Error("Le Bâti3D CRAIG dépasse sa limite.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const raw = Buffer.concat(chunks);
  const parsed = parseCityJSONBuildings(JSON.parse(raw.toString()), {
    source: CRAIG_BUILDINGS_SOURCE,
    year: 2021,
  });
  if (!parsed.buildings.length)
    throw new Error("Aucune toiture CRAIG exploitable.");
  // Keep the small official document, including its transform and metadata;
  // re-validate on each read rather than trusting a compact derived cache.
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, await compress(raw, { level: 3 }));
    signal.throwIfAborted();
    await rename(temporary, cachePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return parsed;
}

/** Add only the genuinely covered Saint-Étienne district, with bounded acquisition. */
export async function fetchCRAIGBuildings(
  bbox: BBox,
  signal: AbortSignal,
): Promise<MunicipalRoofs> {
  signal.throwIfAborted();
  if (!intersects(bbox, CRAIG_ST_ETIENNE_COVERAGE))
    return { buildings: [], warnings: [], covered: false };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  try {
    if (!inFlight) {
      inFlight = acquire(deadline);
      void inFlight
        .finally(() => {
          inFlight = undefined;
        })
        .catch(() => {});
    }
    const parsed = await inFlight;
    deadline.throwIfAborted();
    const buildings: Lod2Building[] = parsed.buildings.filter((building) =>
      intersects(bbox, building.bounds),
    );
    return {
      buildings,
      covered: true,
      warnings: [
        "Toitures CRAIG mesurées en 2021 : couverture limitée au quartier Badouillière–Chavanelle. Hors de ce secteur, les bâtiments OSM/IGN sont conservés.",
        ...(parsed.skippedBuildingCount
          ? [
              `${parsed.skippedBuildingCount} objets du relevé CRAIG n’ont pas de toiture et fondation exploitables ; leurs empreintes OSM/IGN sont conservées lorsqu’elles existent.`,
            ]
          : []),
      ],
    };
  } catch {
    signal.throwIfAborted();
    return {
      buildings: [],
      covered: true,
      warnings: [
        "Bâti3D CRAIG momentanément indisponible : les empreintes et hauteurs OSM/IGN sont conservées. Réessayez la collecte pour récupérer les toitures de Badouillière–Chavanelle.",
      ],
    };
  }
}
