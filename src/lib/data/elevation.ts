import type { BBox, ElevationGrid } from "@/types/osm";
import { bboxDimensions, isMetropolitanFrance } from "./bbox";
import { abortableDelay, fetchWithTimeout } from "./request";
import { fetchTerrainTiles } from "./terrain-tiles";

const IGN_ELEVATION_URL =
  "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json";

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

function makeGrid(
  bbox: BBox,
  spacingM: number,
  maxResolution: number,
  maxSamples = 4900,
) {
  const { widthM, heightM } = bboxDimensions(bbox);
  let rows = Math.max(
    5,
    Math.min(maxResolution, Math.ceil(heightM / spacingM) + 1),
  );
  let cols = Math.max(
    5,
    Math.min(maxResolution, Math.ceil(widthM / spacingM) + 1),
  );
  if (rows * cols > maxSamples) {
    const ratio = Math.sqrt(maxSamples / (rows * cols));
    rows = Math.max(5, Math.floor(rows * ratio));
    cols = Math.max(5, Math.floor(cols * ratio));
  }
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
  signal.throwIfAborted();
  if (isMetropolitanFrance(bbox)) {
    const dimensions = bboxDimensions(bbox);
    // Sample small sites more densely so terraces and approaches survive.
    // This remains a bare-earth height field, not a scan of stairs or arches.
    // IGN accepts at most 5,000 coordinates in a request.
    const smallSite = Math.max(dimensions.widthM, dimensions.heightM) <= 800;
    const grid = makeGrid(bbox, smallSite ? 5 : 20, smallSite ? 128 : 65);
    try {
      // This resource is listed by IGN's /altimetrie/resources catalogue.
      // Its advertised bbox is stale: live Montpellier points are covered.
      // Use the actual response, never assume coverage from the catalogue bbox.
      const response = await fetchWithTimeout(
        IGN_ELEVATION_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lon: grid.lon.map((v) => v.toFixed(7)).join("|"),
            lat: grid.lat.map((v) => v.toFixed(7)).join("|"),
            resource: "ign_lidar_hd_mnt_mono_wld",
            delimiter: "|",
            zonly: "true",
          }),
        },
        signal,
        12000,
      );
      if (!response.ok) throw new Error("LiDAR IGN indisponible");
      const data = await response.json();
      // Reprojection can interpolate the -99999 no-data sentinel. A single
      // missing/outlying cell rejects the whole LiDAR grid rather than mixing
      // this fine terrain with a 90 m DEM without telling the user.
      if (
        !validElevations(data.elevations, grid.lat.length) ||
        data.elevations.some((z: number) => z < -500)
      )
        throw new Error("Couverture LiDAR IGN incomplète");
      return finishGrid(
        bbox,
        grid,
        data.elevations,
        `IGN · LiDAR HD MNT (source 0,5 m, ${bbox[0] < 43.2 && bbox[3] > 8.3 ? "IGN78C" : "IGN69"}) · Licence Ouverte 2.0 · https://data.geopf.fr/altimetrie/resources/ign_lidar_hd_mnt_mono_wld`,
        Math.max(0.5, grid.sampleSpacingM),
      );
    } catch {
      signal.throwIfAborted();
    }
    try {
      const response = await fetchWithTimeout(
        IGN_ELEVATION_URL,
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
      result.warnings = [
        "Le MNT LiDAR HD IGN est indisponible ou incomplet sur cette zone ; le relief se replie sur RGE ALTI.",
      ];
      if (invalid.length)
        result.warnings.push(
          `${invalid.length} points de relief IGN manquants ont été remplacés par le DEM Copernicus à 90 m ; le reste de la grille conserve les altitudes IGN.`,
        );
      return result;
    } catch {
      signal.throwIfAborted();
    }
  }

  // Outside France use a complete DEM mosaic instead of depending on a long
  // series of point-API requests. Keep an operator's configured API primary.
  if (
    !isMetropolitanFrance(bbox) &&
    !process.env.OPEN_METEO_ELEVATION_URL &&
    !process.env.OPEN_METEO_API_KEY
  ) {
    try {
      return await fetchTerrainTiles(bbox, signal);
    } catch {
      signal.throwIfAborted();
    }
  }
  const grid = makeGrid(bbox, 90, 32);
  const points = await fetchGlobalPoints(grid.lat, grid.lon, signal);
  const result = finishGrid(
    bbox,
    grid,
    points,
    "Open-Meteo · Copernicus DEM GLO-90",
    Math.max(90, grid.sampleSpacingM),
  );
  if (isMetropolitanFrance(bbox))
    result.warnings = [
      "Le MNT LiDAR HD IGN et RGE ALTI sont indisponibles ou incomplets sur cette zone ; le relief utilise le DEM Copernicus à 90 m.",
    ];
  else if (
    !process.env.OPEN_METEO_ELEVATION_URL &&
    !process.env.OPEN_METEO_API_KEY
  )
    result.warnings = [
      "Les tuiles de relief mondial sont indisponibles ; le relief utilise le DEM Copernicus à 90 m.",
    ];
  return result;
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
