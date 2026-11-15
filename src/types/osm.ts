export interface LatLon {
  lat: number;
  lon: number;
}

export interface OverpassResponse {
  elements: OverpassElement[];
  osm3s?: { timestamp_osm_base?: string };
  remark?: string;
}

export interface OverpassElement {
  type: "way" | "relation" | "node";
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: LatLon[];
  nodes?: number[];
  members?: Array<{
    type: string;
    ref?: number;
    role: string;
    geometry?: LatLon[];
  }>;
}

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
}

/** [south, west, north, east] in degrees. */
export type BBox = [number, number, number, number];

export interface ElevationGrid {
  rows: number;
  cols: number;
  /** Row-major, first row = south edge, first column = west edge. Metres. */
  points: number[];
  minElev: number;
  maxElev: number;
  south: number;
  west: number;
  north: number;
  east: number;
  source?: string;
  resolutionM?: number;
  warnings?: string[];
}

/** Everything the model builder needs; fetched once, rebuilt as often as wanted. */
export interface MapData {
  bbox: BBox;
  elements: OverpassElement[];
  elevation: ElevationGrid | null;
  sources: string[];
  warnings: string[];
  fetchedAt: string;
}
