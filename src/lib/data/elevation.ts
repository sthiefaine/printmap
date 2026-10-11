import type { BBox, ElevationGrid } from "@/types/osm";
import { bboxDimensions, isMetropolitanFrance } from "./bbox";
import { abortableDelay, fetchWithTimeout } from "./request";

function validElevations(value: unknown, count: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === count &&
    value.every(
      (z) =>
        typeof z === "number" && Number.isFinite(z) && z > -12000 && z < 9000,
    )
  );
}

function makeGrid(bbox: BBox, spacingM: number, maxResolution: number) {
  const { widthM, heightM } = bboxDimensions(bbox);
  const rows = Math.max(
    5,
    Math.min(maxResolution, Math.ceil(heightM / spacingM) + 1),
  );
  const cols = Math.max(
    5,
    Math.min(maxResolution, Math.ceil(widthM / spacingM) + 1),
  );
  const lat: number[] = [],
    lon: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      lat.push(bbox[0] + (r / (rows - 1)) * (bbox[2] - bbox[0]));
      lon.push(bbox[1] + (c / (cols - 1)) * (bbox[3] - bbox[1]));
    }
  return {
    rows,
    cols,
    lat,
    lon,
    sampleSpacingM: Math.max(widthM / (cols - 1), heightM / (rows - 1)),
  };
}

export async function fetchElevation(
  bbox: BBox,
  signal: AbortSignal,
): Promise<ElevationGrid> {
  if (isMetropolitanFrance(bbox)) {
    const grid = makeGrid(bbox, 20, 65);
    try {
      const response = await fetchWithTimeout(
        "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lon: grid.lon.map((v) => v.toFixed(7)).join("|"),
            lat: grid.lat.map((v) => v.toFixed(7)).join("|"),
            resource: "ign_rge_alti_wld",
            delimiter: "|",
            zonly: "true",
          }),
        },
        signal,
        18000,
      );
      if (!response.ok) throw new Error("IGN indisponible");
      const data = await response.json();
      if (
        !Array.isArray(data.elevations) ||
        data.elevations.length !== grid.lat.length
      )
        throw new Error("Couverture IGN incomplète");
      // Near missing raster cells IGN can interpolate its -99999 sentinel into
      // negative outliers. Never turn these into deep spikes in the printed model.
      const invalid: number[] = data.elevations.flatMap(
        (z: unknown, index: number) =>
          typeof z !== "number" || !Number.isFinite(z) || z < -500 || z > 9000
            ? [index]
            : [],
      );
      if (invalid.length / grid.lat.length > 0.05)
        throw new Error("Couverture IGN incomplète");
      if (invalid.length) {
        const fallback = await fetchGlobalPoints(
          invalid.map((index) => grid.lat[index]),
          invalid.map((index) => grid.lon[index]),
          signal,
        );
        invalid.forEach((index, i) => {
          data.elevations[index] = fallback[i];
        });
      }
      const result = finishGrid(
        bbox,
        grid,
        data.elevations,
        invalid.length
          ? "IGN · RGE ALTI + Copernicus DEM (points manquants)"
          : "IGN · RGE ALTI",
        Math.max(1, grid.sampleSpacingM),
      );
      if (invalid.length)
        result.warnings = [
          `${invalid.length} points de relief IGN manquants ont été remplacés par le DEM Copernicus à 90 m ; le reste de la grille conserve les altitudes IGN.`,
        ];
      return result;
    } catch {
      signal.throwIfAborted();
    }
  }

  const grid = makeGrid(bbox, 90, 32);
  const points = await fetchGlobalPoints(grid.lat, grid.lon, signal);
  return finishGrid(
    bbox,
    grid,
    points,
    "Open-Meteo · Copernicus DEM GLO-90",
    Math.max(90, grid.sampleSpacingM),
  );
}

async function fetchGlobalPoints(
  latitudes: number[],
  longitudes: number[],
  signal: AbortSignal,
) {
  const points: number[] = [];
  for (let i = 0; i < latitudes.length; i += 100) {
    if (i > 0) await abortableDelay(1100, signal);
    const lat = latitudes.slice(i, i + 100),
      lon = longitudes.slice(i, i + 100);
    const url = new URL(
      process.env.OPEN_METEO_ELEVATION_URL ??
        (process.env.OPEN_METEO_API_KEY
          ? "https://customer-api.open-meteo.com/v1/elevation"
          : "https://api.open-meteo.com/v1/elevation"),
    );
    if (process.env.OPEN_METEO_API_KEY)
      url.searchParams.set("apikey", process.env.OPEN_METEO_API_KEY);
    url.searchParams.set("latitude", lat.map((v) => v.toFixed(6)).join(","));
    url.searchParams.set("longitude", lon.map((v) => v.toFixed(6)).join(","));
    const response = await fetchWithTimeout(url.toString(), {}, signal, 10000);
    if (!response.ok) throw new Error("Relief mondial indisponible");
    const data = await response.json();
    if (!validElevations(data.elevation, lat.length))
      throw new Error("Données de relief incomplètes");
    points.push(...data.elevation);
  }
  return points;
}

function finishGrid(
  bbox: BBox,
  grid: { rows: number; cols: number },
  points: number[],
  source: string,
  resolutionM: number,
): ElevationGrid {
  return {
    rows: grid.rows,
    cols: grid.cols,
    points,
    minElev: Math.min(...points),
    maxElev: Math.max(...points),
    south: bbox[0],
    west: bbox[1],
    north: bbox[2],
    east: bbox[3],
    source,
    resolutionM,
  };
}
