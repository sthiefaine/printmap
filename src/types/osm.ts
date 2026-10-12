export interface LatLon {
  lat: number;
  lon: number;
}

/** Measured roof polygons: horizontal position in WGS84, altitude in metres IGN69. */
export interface RoofSurface {
  outer: Array<LatLon & { elevation: number }>;
  holes: Array<Array<LatLon & { elevation: number }>>;
}

/** Complete measured boundary; includes the underside of arches and overhangs. */
export interface MeasuredSurface extends RoofSurface {
  kind: "roof" | "wall" | "ground" | "outerCeiling" | "outerFloor" | "closure";
}

export interface MeasuredSolid {
  surfaces: MeasuredSurface[];
  source: string;
  year: number;
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
  /** Position of an OSM node; it does not imply a printable footprint. */
  lat?: number;
  lon?: number;
  geometry?: LatLon[];
  nodes?: number[];
  roofSurfaces?: RoofSurface[];
  groundElevation?: number;
  roofSource?: string;
  measuredSolid?: MeasuredSolid;
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
  /** Number of municipal buildings carrying measured roof surfaces. */
  lod2BuildingCount?: number;
  lod2RoofSurfaceCount?: number;
  lod2Year?: number;
  lod2SolidCount?: number;
  municipalStructureCount?: number;
  /** Located landmarks whose point data does not provide printable 3D geometry. */
  pointLandmarkCount?: number;
}

export interface MapDataResponse {
  osmData: OverpassResponse;
  elevationGrid: ElevationGrid | null;
  report: DataReport;
}
