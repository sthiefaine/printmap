import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, createInflateRaw } from "node:zlib";
import type { BBox, OverpassElement } from "@/types/osm";
import {
  elementPolygons,
  geographicPointInRing,
  type GeographicPolygon,
} from "@/lib/osm/relation-polygons";
import zoneIndex from "./montpellier-zones.json" with { type: "json" };
import { cityGMLBuildings, type Lod2Building } from "./citygml-parser";
import { toLambert93 } from "./lambert93";
import {
  entryDataStart,
  zipDirectory,
  type RemoteZip,
  type ZipEntry,
} from "./zip-range";
import { fetchWithTimeout } from "./request";

export const MONTPELLIER_LOD2_SOURCE =
  "Montpellier Méditerranée Métropole · CityGML LoD2.2 · 2020";
const URL =
  "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_Bat3D.zip";
const CACHE = path.join(process.cwd(), ".cache", "printmap");
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const inFlight = new Map<number, Promise<void>>();
let archiveIndex:
  { zip: RemoteZip; entries: ZipEntry[]; expires: number } | undefined;

const intersects = (a: BBox, b: BBox) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function pointInRing(x: number, y: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** Select actual delivery polygons, not their largely overlapping bounding rectangles. */
export function montpellierBatches(bbox: BBox): number[] {
  if (!intersects(bbox, [43.45, 3.6, 43.85, 4.1])) return [];
  const corners = [
    [bbox[1], bbox[0]],
    [bbox[3], bbox[0]],
    [bbox[3], bbox[2]],
    [bbox[1], bbox[2]],
  ].map(([lon, lat]) => toLambert93(lon, lat));
  const minX = Math.min(...corners.map((p) => p[0])) - 3,
    maxX = Math.max(...corners.map((p) => p[0])) + 3;
  const minY = Math.min(...corners.map((p) => p[1])) - 3,
    maxY = Math.max(...corners.map((p) => p[1])) + 3;
  return zoneIndex.zones
    .filter((zone) => {
      if (
        zone.bounds[0] > maxX ||
        zone.bounds[2] < minX ||
        zone.bounds[1] > maxY ||
        zone.bounds[3] < minY
      )
        return false;
      if (
        corners.some(
          ([x, y]) =>
            zone.rings.filter((ring) => pointInRing(x, y, ring)).length % 2,
        )
      )
        return true;
      // A connected delivery polygon crossing a rectangle either has a vertex
      // inside it or an edge crossing its boundary.
      for (const ring of zone.rings)
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i],
            q = ring[(i + 1) % ring.length];
          if (p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY)
            return true;
          for (const x of [minX, maxX])
            if (
              ((p[0] <= x && q[0] >= x) || (q[0] <= x && p[0] >= x)) &&
              p[0] !== q[0]
            ) {
              const y = p[1] + ((x - p[0]) / (q[0] - p[0])) * (q[1] - p[1]);
              if (y >= minY && y <= maxY) return true;
            }
          for (const y of [minY, maxY])
            if (
              ((p[1] <= y && q[1] >= y) || (q[1] <= y && p[1] >= y)) &&
              p[1] !== q[1]
            ) {
              const x = p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]);
              if (x >= minX && x <= maxX) return true;
            }
        }
      return false;
    })
    .map((zone) => ({
      batch: zone.batch,
      coverage: Array.from({ length: 49 }, (_, index) => {
        const x = minX + (((index % 7) + 0.5) / 7) * (maxX - minX),
          y = minY + ((Math.floor(index / 7) + 0.5) / 7) * (maxY - minY);
        return zone.rings.filter((ring) => pointInRing(x, y, ring)).length % 2;
      }).reduce((sum, value) => sum + value, 0),
    }))
    .sort((a, b) => b.coverage - a.coverage)
    .map((zone) => zone.batch);
}

async function getArchive(signal: AbortSignal) {
  if (archiveIndex && archiveIndex.expires > Date.now()) return archiveIndex;
  const response = await fetchWithTimeout(
    URL,
    { method: "HEAD" },
    signal,
    10000,
  );
  const size = Number(response.headers.get("content-length"));
  if (
    !response.ok ||
    !Number.isFinite(size) ||
    size < 1 ||
    size > 1024 * 1024 * 1024
  )
    throw new Error("Archive municipale 3D indisponible");
  const zip = { url: URL, start: 0, size };
  archiveIndex = {
    zip,
    entries: await zipDirectory(zip, signal),
    expires: Date.now() + TTL,
  };
  return archiveIndex;
}

const cachePath = (batch: number) =>
  path.join(CACHE, `montpellier-2020-v2-batch${batch}.jsonl.gz`);
async function pruneCache(keep: string) {
  const files = await readdir(CACHE);
  const info = await Promise.all(
    files
      .filter((name) =>
        /^montpellier-2020-v[12]-batch\d+\.jsonl\.gz$/.test(name),
      )
      .map(async (name) => {
        const file = path.join(CACHE, name),
          data = await stat(file);
        return { file, size: data.size, modified: data.mtimeMs };
      }),
  );
  info.sort((a, b) => b.modified - a.modified);
  let bytes = 0,
    count = 0;
  for (const file of info) {
    bytes += file.size;
    count++;
    if (
      file.file !== keep &&
      (Date.now() - file.modified > TTL || count > 3 || bytes > MAX_CACHE_BYTES)
    )
      await unlink(file.file).catch(() => {});
  }
}

async function cacheBatch(batch: number, signal: AbortSignal): Promise<void> {
  const target = cachePath(batch);
  try {
    const data = await stat(target);
    if (Date.now() - data.mtimeMs < TTL && data.size < MAX_CACHE_BYTES) return;
  } catch {
    /* First acquisition. */
  }
  const archive = await getArchive(signal),
    entry = archive.entries.find(
      (file) => file.name === `Batch${batch}_bati_2020.zip`,
    );
  if (!entry || entry.method !== 0 || entry.size > 80 * 1024 * 1024)
    throw new Error("Lot municipal 3D invalide");
  const inner: RemoteZip = {
    url: URL,
    start: await entryDataStart(archive.zip, entry, signal),
    size: entry.size,
  };
  const file = (await zipDirectory(inner, signal)).find((file) =>
    /\.gml$/i.test(file.name),
  );
  if (!file || file.method !== 8 || file.size > 800 * 1024 * 1024)
    throw new Error("Document CityGML invalide");
  const start = await entryDataStart(inner, file, signal);
  const response = await fetchWithTimeout(
    URL,
    {
      headers: {
        Range: `bytes=${inner.start + start}-${inner.start + start + file.compressedSize - 1}`,
      },
    },
    signal,
    65000,
  );
  if (response.status !== 206 || !response.body)
    throw new Error("Lecture sélective CityGML indisponible");
  await mkdir(CACHE, { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  const gzip = createGzip({ level: 3 }),
    output = createWriteStream(temporary);
  const writing = pipeline(gzip, output, { signal });
  // Observe immediately so an I/O failure is not an unhandled rejection while
  // the independent network stream is still producing a member.
  void writing.catch(() => {});
  const source = Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  const inflate = createInflateRaw();
  source.on("error", (error) => inflate.destroy(error));
  const stream = source.pipe(inflate);
  let totalBytes = 0,
    compactBytes = 0,
    written = 0;
  async function* checkedChunks() {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      totalBytes += chunk.length;
      if (totalBytes > file!.size + 1024)
        throw new Error("Document CityGML dépasse sa taille annoncée");
      yield chunk as Uint8Array;
    }
  }
  try {
    for await (const building of cityGMLBuildings(checkedChunks())) {
      const line = JSON.stringify(building) + "\n";
      compactBytes += Buffer.byteLength(line);
      if (compactBytes > 180 * 1024 * 1024)
        throw new Error("Cache municipal 3D dépasse sa limite");
      if (!gzip.write(line)) await once(gzip, "drain", { signal });
      written++;
    }
    if (totalBytes !== file.size || !written)
      throw new Error("Lot CityGML incomplet");
    gzip.end();
    await writing;
    await rename(temporary, target);
    await pruneCache(target);
  } catch (error) {
    source.destroy();
    inflate.destroy();
    gzip.destroy();
    output.destroy();
    await writing.catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export interface MunicipalRoofs {
  buildings: Lod2Building[];
  warnings: string[];
  covered: boolean;
}
export async function fetchMontpellierRoofs(
  bbox: BBox,
  signal: AbortSignal,
): Promise<MunicipalRoofs> {
  const batches = montpellierBatches(bbox);
  if (!batches.length) return { buildings: [], warnings: [], covered: false };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(72000)]);
  const buildings: Lod2Building[] = [],
    warnings: string[] = [];
  let vertexCount = 0;
  if (batches.length > 3)
    warnings.push(
      "Toitures municipales limitées à trois lots pour cette collecte ; réduisez la sélection pour compléter les zones voisines.",
    );
  for (const batch of batches.slice(0, 3)) {
    try {
      let pending = inFlight.get(batch);
      if (!pending) {
        pending = cacheBatch(batch, deadline);
        inFlight.set(batch, pending);
        void pending.finally(() => inFlight.delete(batch)).catch(() => {});
      }
      await pending;
      deadline.throwIfAborted();
      const file = createReadStream(cachePath(batch)),
        gunzip = createGunzip();
      file.on("error", (error) => gunzip.destroy(error));
      const stream = file.pipe(gunzip);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          deadline.throwIfAborted();
          const building = JSON.parse(line) as Lod2Building;
          if (!intersects(bbox, building.bounds)) continue;
          const count =
            building.roofSurfaces.reduce(
              (sum, roof) =>
                sum +
                roof.outer.length +
                roof.holes.reduce((n, ring) => n + ring.length, 0),
              0,
            ) +
            (building.measuredSolid?.surfaces.reduce(
              (sum, surface) =>
                sum +
                surface.outer.length +
                surface.holes.reduce((n, ring) => n + ring.length, 0),
              0,
            ) ?? 0);
          vertexCount += count;
          if (vertexCount > 400000 || buildings.length >= 15000) {
            warnings.push(
              "Certaines toitures dépassent la limite de détails de cette collecte ; réduisez la zone.",
            );
            break;
          }
          buildings.push(building);
        }
      } finally {
        lines.close();
        file.destroy();
        gunzip.destroy();
      }
    } catch {
      signal.throwIfAborted();
      warnings.push(
        "Les toitures 3D municipales ne sont pas encore disponibles pour une partie de la zone ; réessayez la collecte ou utilisez une sélection plus petite.",
      );
    }
  }
  return {
    buildings: [
      ...new Map(buildings.map((building) => [building.id, building])).values(),
    ],
    warnings,
    covered: true,
  };
}

const contains = (polygon: GeographicPolygon, lat: number, lon: number) =>
  geographicPointInRing({ lat, lon }, polygon.outer) &&
  !polygon.holes.some((hole) => geographicPointInRing({ lat, lon }, hole));
const boundsOf = (polygon: GeographicPolygon): BBox => [
  Math.min(...polygon.outer.map((p) => p.lat)),
  Math.min(...polygon.outer.map((p) => p.lon)),
  Math.max(...polygon.outer.map((p) => p.lat)),
  Math.max(...polygon.outer.map((p) => p.lon)),
];
const bucketKeys = (bbox: BBox) => {
  const keys: string[] = [];
  for (
    let lat = Math.floor(bbox[0] * 1000);
    lat <= Math.floor(bbox[2] * 1000);
    lat++
  )
    for (
      let lon = Math.floor(bbox[1] * 1000);
      lon <= Math.floor(bbox[3] * 1000);
      lon++
    )
      keys.push(`${lat}/${lon}`);
  return keys;
};

/** Replace covered old envelopes and their 3D parts; retain unmatched newer OSM buildings. */
export function enrichWithMunicipalRoofs(
  elements: OverpassElement[],
  buildings: Lod2Building[],
  provenance = {
    source: MONTPELLIER_LOD2_SOURCE,
    prefix: "MMM",
    heightSource: "Montpellier · géométrie LoD2 mesurée",
    year: 2020,
  },
) {
  if (!buildings.length) return { elements, replaced: 0, added: 0 };
  const buckets = new Map<string, Lod2Building[]>();
  for (const building of buildings)
    for (const key of bucketKeys(building.bounds))
      buckets.set(key, [...(buckets.get(key) ?? []), building]);
  const ways = new Map(
    elements
      .filter((element) => element.type === "way")
      .map((element) => [element.id, element]),
  );
  const replaced = new Set<string>();
  for (const element of elements) {
    if (!element.tags?.building && !element.tags?.["building:part"]) continue;
    const polygons = elementPolygons(element, ways);
    if (!polygons.length) continue;
    const covered = polygons.every((polygon) => {
      const bounds = boundsOf(polygon),
        candidates = [
          ...new Set(
            bucketKeys(bounds).flatMap((key) => buckets.get(key) ?? []),
          ),
        ].filter((building) => intersects(building.bounds, bounds));
      if (!candidates.length) return false;
      let tested = 0,
        matched = 0;
      for (let row = 0; row < 7; row++)
        for (let col = 0; col < 7; col++) {
          const lat = bounds[0] + ((row + 0.5) / 7) * (bounds[2] - bounds[0]),
            lon = bounds[1] + ((col + 0.5) / 7) * (bounds[3] - bounds[1]);
          if (!contains(polygon, lat, lon)) continue;
          tested++;
          if (
            candidates.some((building) =>
              [
                ...building.footprints,
                ...(building.measuredSolid?.surfaces ?? []),
              ].some((footprint) => contains(footprint, lat, lon)),
            )
          )
            matched++;
        }
      return tested >= 4 && matched / tested >= 0.75;
    });
    if (covered) {
      replaced.add(`${element.type}/${element.id}`);
      if (element.type === "relation")
        for (const member of element.members ?? [])
          if (
            member.ref != null &&
            (ways.get(member.ref)?.tags?.building ||
              ways.get(member.ref)?.tags?.["building:part"])
          )
            replaced.add(`way/${member.ref}`);
    }
  }
  let id = -3000000000000;
  const added = buildings.flatMap((building) =>
    (building.measuredSolid && building.envelope
      ? [building.envelope]
      : building.footprints
    ).map((footprint) => ({
      type: "relation" as const,
      id: id--,
      roofSurfaces: building.roofSurfaces,
      groundElevation: building.groundElevation,
      roofSource: provenance.source,
      measuredSolid: building.measuredSolid,
      tags: {
        building: "yes",
        height: String(building.height),
        "printmap:source": provenance.source,
        "printmap:source_id": `${provenance.prefix}/${building.id}`,
        "printmap:height_source": provenance.heightSource,
        "printmap:roof_year": String(provenance.year),
      },
      members: [
        { type: "way", role: "outer", geometry: footprint.outer },
        ...footprint.holes.map((geometry) => ({
          type: "way",
          role: "inner",
          geometry,
        })),
      ],
    })),
  );
  return {
    elements: [
      ...elements.filter(
        (element) => !replaced.has(`${element.type}/${element.id}`),
      ),
      ...added,
    ],
    replaced: replaced.size,
    added: added.length,
  };
}
