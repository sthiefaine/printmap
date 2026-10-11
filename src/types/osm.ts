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

export type BBox = [number, number, number, number]; // [south, west, north, east]

export interface ElevationGrid {
  rows: number;
  cols: number;
  points: number[]; // flat array row-major [e00, e01, ..., e0C, e10, ...]
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

export interface DataReport {
  sources: string[];
  warnings: string[];
  fetchedAt: string;
  areaKm2: number;
  elementCount: number;
  buildingCount: number;
  measuredBuildingCount: number;
  ignBuildingCount: number;
  elevationSource: string | null;
  elevationResolutionM: number | null;
  osmTimestamp?: string;
  seaCoverage: "available" | "unavailable";
}

export interface MapDataResponse {
  osmData: OverpassResponse;
  elevationGrid: ElevationGrid | null;
  report: DataReport;
}
