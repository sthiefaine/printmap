import type {
  BBox,
  LatLon,
  MeasuredSolid,
  MeasuredSurface,
  RoofSurface,
} from "@/types/osm";
import type { GeographicPolygon } from "@/lib/osm/relation-polygons";
import { fromLambert93 } from "./lambert93";

export interface Lod2Building {
  id: string;
  footprints: GeographicPolygon[];
  roofSurfaces: RoofSurface[];
  groundElevation: number;
  height: number;
  bounds: BBox;
  measuredSolid?: MeasuredSolid;
  /** Search envelope only; the measured shell and its GroundSurface define the volume. */
  envelope?: GeographicPolygon;
}

function rings(xml: string, role: "exterior" | "interior") {
  return [
    ...xml.matchAll(
      new RegExp(`<gml:${role}\\b[^>]*>([\\s\\S]*?)<\\/gml:${role}>`, "g"),
    ),
  ].flatMap((match) => {
    const text = match[1].match(
      /<gml:posList\b[^>]*>([^<]+)<\/gml:posList>/,
    )?.[1];
    if (!text) return [];
    const values = text.trim().split(/\s+/).map(Number);
    if (
      values.length < 12 ||
      values.length % 3 ||
      values.length > 60000 ||
      values.some((v) => !Number.isFinite(v))
    )
      return [];
    const ring = [];
    for (let i = 0; i < values.length; i += 3) {
      if (
        values[i] < 600000 ||
        values[i] > 900000 ||
        values[i + 1] < 6200000 ||
        values[i + 1] > 6400000 ||
        values[i + 2] < -100 ||
        values[i + 2] > 1000
      )
        return [];
      const geo = fromLambert93(values[i], values[i + 1]);
      ring.push({
        lon: Math.round(geo.lon * 1e8) / 1e8,
        lat: Math.round(geo.lat * 1e8) / 1e8,
        elevation: Math.round(values[i + 2] * 1000) / 1000,
      });
    }
    const first = ring[0],
      last = ring.at(-1)!;
    if (
      Math.abs(first.lon - last.lon) > 1e-7 ||
      Math.abs(first.lat - last.lat) > 1e-7 ||
      Math.abs(first.elevation - last.elevation) > 0.01
    )
      return [];
    return [ring];
  });
}

const SURFACE_KINDS: Record<string, MeasuredSurface["kind"]> = {
  RoofSurface: "roof",
  WallSurface: "wall",
  GroundSurface: "ground",
  OuterCeilingSurface: "outerCeiling",
  OuterFloorSurface: "outerFloor",
  ClosureSurface: "closure",
};

/** Resolve the original solid's polygon references; never substitute an incomplete shell. */
function completeSolid(xml: string): MeasuredSolid | undefined {
  const refs = [
    ...xml.matchAll(/<bldg:lod2Solid\b[^>]*>([\s\S]*?)<\/bldg:lod2Solid>/g),
  ].flatMap((solid) =>
    [...solid[1].matchAll(/xlink:href="#([^"]+)"/g)].map((ref) => ref[1]),
  );
  if (!refs.length || refs.length > 5000) return;
  const polygons = new Map<string, MeasuredSurface>();
  const types = Object.keys(SURFACE_KINDS).join("|");
  for (const surface of xml.matchAll(
    new RegExp(`<bldg:(${types})\\b[^>]*>([\\s\\S]*?)<\\/bldg:\\1>`, "g"),
  )) {
    for (const polygon of surface[2].matchAll(
      /<gml:Polygon\b[^>]*gml:id="([^"]+)"[^>]*>([\s\S]*?)<\/gml:Polygon>/g,
    )) {
      const outer = rings(polygon[2], "exterior")[0];
      if (!outer) continue;
      const holes = rings(polygon[2], "interior");
      if (holes.length !== [...polygon[2].matchAll(/<gml:interior\b/g)].length)
        continue;
      polygons.set(polygon[1], {
        kind: SURFACE_KINDS[surface[1]],
        outer,
        holes,
      });
    }
  }
  const surfaces = [...new Set(refs)].map((ref) => polygons.get(ref));
  if (surfaces.some((surface) => !surface)) return;
  return {
    surfaces: surfaces as MeasuredSurface[],
    source: "Montpellier Méditerranée Métropole · CityGML LoD2.2 · 2020",
    year: 2020,
  };
}

export function convexEnvelope(
  points: LatLon[],
): GeographicPolygon | undefined {
  const sorted = [
    ...new Map(points.map((p) => [`${p.lon}/${p.lat}`, p])).values(),
  ].sort((a, b) => a.lon - b.lon || a.lat - b.lat);
  if (sorted.length < 3) return;
  const cross = (a: LatLon, b: LatLon, c: LatLon) =>
    (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
  const half = (values: LatLon[]) => {
    const out: LatLon[] = [];
    for (const point of values) {
      while (out.length >= 2 && cross(out.at(-2)!, out.at(-1)!, point) <= 0)
        out.pop();
      out.push({ lat: point.lat, lon: point.lon });
    }
    return out;
  };
  const lower = half(sorted),
    upper = half(sorted.toReversed());
  const outer = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  outer.push({ ...outer[0] });
  return { outer, holes: [] };
}

function surfaces(
  xml: string,
  type: "RoofSurface" | "GroundSurface",
): RoofSurface[] {
  return [
    ...xml.matchAll(
      new RegExp(`<bldg:${type}\\b[^>]*>([\\s\\S]*?)<\\/bldg:${type}>`, "g"),
    ),
  ].flatMap((surface) =>
    [
      ...surface[1].matchAll(/<gml:Polygon\b[^>]*>([\s\S]*?)<\/gml:Polygon>/g),
    ].flatMap((polygon) => {
      const outer = rings(polygon[1], "exterior")[0];
      return outer ? [{ outer, holes: rings(polygon[1], "interior") }] : [];
    }),
  );
}

/** Parse only one bounded CityGML member, never the half-gigabyte batch document. */
export function parseCityGMLBuilding(xml: string): Lod2Building | null {
  const id = xml.match(/<bldg:Building\b[^>]*gml:id="([^"]+)"/)?.[1];
  if (!id) return null;
  const roofSurfaces = surfaces(xml, "RoofSurface"),
    ground = surfaces(xml, "GroundSurface");
  if (!roofSurfaces.length || !ground.length || roofSurfaces.length > 5000)
    return null;
  const attr = xml.match(
    /<gen:doubleAttribute\b[^>]*name="ZMIN"[^>]*>\s*<gen:value>([^<]+)<\/gen:value>/,
  )?.[1];
  const groundPoints = ground.flatMap((surface) => surface.outer),
    elevations = groundPoints.map((p) => p.elevation);
  const groundElevation =
    attr == null
      ? elevations.reduce((a, b) => Math.min(a, b), Infinity)
      : Number(attr);
  const roofElevations = roofSurfaces.flatMap((surface) =>
    surface.outer.map((p) => p.elevation),
  );
  const height =
    roofElevations.reduce((a, b) => Math.max(a, b), -Infinity) -
    groundElevation;
  if (!Number.isFinite(groundElevation) || height <= 0 || height > 300)
    return null;
  const footprints = ground.map((surface) => ({
    outer: surface.outer.map(({ lon, lat }) => ({ lon, lat })),
    holes: surface.holes.map((ring) =>
      ring.map(({ lon, lat }) => ({ lon, lat })),
    ),
  }));
  // Ordinary buildings retain compact roof data. Only structures with measured
  // underpasses, overhangs or openings need their complete 3D boundary.
  const complex =
    ground.length > 1 ||
    /<bldg:Outer(?:Ceiling|Floor)Surface\b/.test(xml) ||
    [
      ...xml.matchAll(
        /<bldg:WallSurface\b[^>]*>([\s\S]*?)<\/bldg:WallSurface>/g,
      ),
    ].some((wall) => /<gml:interior\b/.test(wall[1]));
  const measuredSolid = complex ? completeSolid(xml) : undefined;
  const envelope = measuredSolid
    ? convexEnvelope(measuredSolid.surfaces.flatMap((s) => s.outer))
    : undefined;
  const searchPoints = envelope?.outer ?? groundPoints;
  const bounds: BBox = [
    Math.min(...searchPoints.map((p) => p.lat)),
    Math.min(...searchPoints.map((p) => p.lon)),
    Math.max(...searchPoints.map((p) => p.lat)),
    Math.max(...searchPoints.map((p) => p.lon)),
  ];
  return {
    id,
    footprints,
    roofSurfaces,
    groundElevation,
    height,
    bounds,
    measuredSolid,
    envelope,
  };
}

/** Both namespace styles occur in the official delivery; bound one member at a time. */
export async function* cityGMLBuildings(
  chunks: AsyncIterable<Uint8Array>,
  maxMemberBytes = 16 * 1024 * 1024,
): AsyncGenerator<Lod2Building> {
  const decoder = new TextDecoder();
  let buffer = "",
    skipping = false;
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const close = /<\/(?:core:)?cityObjectMember>/.exec(buffer);
      if (skipping) {
        if (!close) {
          buffer = buffer.slice(-64);
          break;
        }
        buffer = buffer.slice(close.index + close[0].length);
        skipping = false;
        continue;
      }
      const begin = /<(?:core:)?cityObjectMember>/.exec(buffer);
      if (!begin) {
        buffer = buffer.slice(-64);
        break;
      }
      if (begin.index) buffer = buffer.slice(begin.index);
      const end = /<\/(?:core:)?cityObjectMember>/.exec(buffer);
      if (!end) {
        if (buffer.length > maxMemberBytes) {
          skipping = true;
          buffer = buffer.slice(-64);
        }
        break;
      }
      if (end.index <= maxMemberBytes) {
        const building = parseCityGMLBuilding(
          buffer.slice(0, end.index + end[0].length),
        );
        if (building) yield building;
      }
      buffer = buffer.slice(end.index + end[0].length);
    }
  }
}
