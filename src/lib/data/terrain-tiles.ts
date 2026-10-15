import sharp from "sharp";
import type { BBox, ElevationGrid } from "@/types/osm";
import { bboxDimensions } from "./bbox";
import { fetchWithTimeout } from "./request";

// https://github.com/tilezen/joerd/blob/master/docs/formats.md
const ZOOM = 13;
const WORLD_PIXELS = 256 * 2 ** ZOOM;
export const TERRAIN_TILES_SOURCE =
  "Mapzen Terrain Tiles · AWS Open Data · USGS (SRTM/GMTED2010), NOAA (ETOPO1) et producteurs régionaux · https://github.com/tilezen/joerd/blob/master/docs/attribution.md";

const pixelX = (lon: number) => ((lon + 180) / 360) * WORLD_PIXELS - 0.5;
const pixelY = (lat: number) =>
  ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) *
    WORLD_PIXELS -
  0.5;

/** A complete, independent DEM: never patch missing cells with zero elevations
 * or combine providers/datum inside this grid. PNG RGB values are height data. */
export async function fetchTerrainTiles(
  bbox: BBox,
  signal: AbortSignal,
): Promise<ElevationGrid> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(18000)]);
  deadline.throwIfAborted();
  const minX = Math.floor(Math.floor(pixelX(bbox[1])) / 256);
  const maxX = Math.floor((Math.floor(pixelX(bbox[3])) + 1) / 256);
  const minY = Math.floor(Math.floor(pixelY(bbox[2])) / 256);
  const maxY = Math.floor((Math.floor(pixelY(bbox[0])) + 1) / 256);
  const tiles: { x: number; y: number }[] = [];
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) tiles.push({ x, y });
  if (tiles.length > 24)
    throw new Error("Zone trop étendue pour le relief mondial détaillé.");
  const decoded = new Map<string, Buffer>();
  for (let i = 0; i < tiles.length; i += 4) {
    await Promise.all(
      tiles.slice(i, i + 4).map(async ({ x, y }) => {
        const response = await fetchWithTimeout(
          `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${((x % 2 ** ZOOM) + 2 ** ZOOM) % 2 ** ZOOM}/${y}.png`,
          {},
          deadline,
          8000,
        );
        if (!response.ok)
          throw new Error("Tuile de relief mondial indisponible.");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 1_000_000)
          throw new Error("Tuile de relief trop volumineuse.");
        const image = await sharp(bytes, { limitInputPixels: 256 * 256 })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (
          image.info.width !== 256 ||
          image.info.height !== 256 ||
          image.info.channels !== 4
        )
          throw new Error("Format de tuile de relief invalide.");
        decoded.set(`${x}/${y}`, image.data);
      }),
    );
  }
  deadline.throwIfAborted();
  const elevationAt = (x: number, y: number) => {
    const tileX = Math.floor(x / 256),
      tileY = Math.floor(y / 256);
    const data = decoded.get(`${tileX}/${tileY}`);
    if (!data) throw new Error("Couverture du relief incomplète.");
    const index = ((y - tileY * 256) * 256 + x - tileX * 256) * 4;
    const height =
      data[index] * 256 + data[index + 1] + data[index + 2] / 256 - 32768;
    if (
      data[index + 3] !== 255 ||
      !Number.isFinite(height) ||
      height <= -12000 ||
      height >= 9000
    )
      throw new Error("Altitude du relief manquante ou invalide.");
    return height;
  };
  const { widthM, heightM } = bboxDimensions(bbox);
  const cols = Math.max(5, Math.min(128, Math.ceil(widthM / 30) + 1));
  const rows = Math.max(5, Math.min(128, Math.ceil(heightM / 30) + 1));
  const points: number[] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const x = pixelX(bbox[1] + (col / (cols - 1)) * (bbox[3] - bbox[1]));
      const y = pixelY(bbox[0] + (row / (rows - 1)) * (bbox[2] - bbox[0]));
      const ix = Math.floor(x),
        iy = Math.floor(y),
        fx = x - ix,
        fy = y - iy;
      const bottom =
        elevationAt(ix, iy) * (1 - fx) + elevationAt(ix + 1, iy) * fx;
      const top =
        elevationAt(ix, iy + 1) * (1 - fx) + elevationAt(ix + 1, iy + 1) * fx;
      points.push(bottom * (1 - fy) + top * fy);
    }
  return {
    south: bbox[0],
    west: bbox[1],
    north: bbox[2],
    east: bbox[3],
    rows,
    cols,
    points,
    minElev: Math.min(...points),
    maxElev: Math.max(...points),
    source: TERRAIN_TILES_SOURCE,
    resolutionM: Math.max(30, widthM / (cols - 1), heightM / (rows - 1)),
    warnings: [
      "Relief mondial : la résolution indiquée est celle de la grille utilisée (au moins 30 m). La précision des données d’origine varie selon la couverture ; ce relief ne relève pas les bâtiments ni les petits ouvrages.",
    ],
  };
}
