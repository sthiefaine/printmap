import type { BBox, LatLon, OverpassElement } from "@/types/osm";
import { elementPolygons } from "@/lib/osm/relation-polygons";
import {
  buildingHeight,
  parseLengthMeters,
  roofFromTags,
  type Roof,
} from "@/lib/osm/building-height";
import type { RoadLevel } from "./settings";

export type Point = [number, number];
export type Ring = Point[];
export interface Poly {
  outer: Ring;
  holes: Ring[];
}
export interface Line {
  points: Ring;
  /** Real width in metres. */
  widthM: number;
}
export interface Building {
  poly: Poly;
  heightM: number;
  estimated: boolean;
  /** `heightM` reaches the roof top rather than the top of the walls. */
  includesRoof: boolean;
  /** Measured wall height (IGN gutter height), when known. */
  eaveM: number | null;
  roof: Roof | null;
  part: boolean;
}
export interface Features {
  buildings: Building[];
  roads: Array<Line & { level: RoadLevel }>;
  roadAreas: Poly[];
  waterAreas: Poly[];
  waterLines: Line[];
  green: Poly[];
}

const ROADS: Record<string, [RoadLevel, number]> = {
  motorway: ["major", 14],
  motorway_link: ["major", 8],
  trunk: ["major", 12],
  trunk_link: ["major", 8],
  primary: ["major", 10],
  primary_link: ["major", 7],
  secondary: ["major", 9],
  secondary_link: ["major", 7],
  tertiary: ["major", 8],
  tertiary_link: ["major", 6],
  residential: ["streets", 6],
  unclassified: ["streets", 6],
  living_street: ["streets", 5],
  pedestrian: ["streets", 5],
  road: ["streets", 6],
  busway: ["streets", 6],
  service: ["all", 3.5],
  track: ["all", 3],
  footway: ["all", 2],
  path: ["all", 2],
  cycleway: ["all", 2],
  steps: ["all", 2],
  bridleway: ["all", 2],
};
const WATERWAYS: Record<string, number> = { river: 12, canal: 8, stream: 3 };
const GREEN = {
  leisure: [
    "park",
    "garden",
    "golf_course",
    "recreation_ground",
    "nature_reserve",
  ],
  landuse: [
    "grass",
    "meadow",
    "forest",
    "orchard",
    "vineyard",
    "recreation_ground",
    "village_green",
    "cemetery",
  ],
  natural: ["wood", "grassland", "scrub", "heath", "wetland"],
};

type Tags = Record<string, string>;
const isBuilding = (t: Tags) =>
  (!!t.building && t.building !== "no") ||
  (!!t["building:part"] && t["building:part"] !== "no");
const isWater = (t: Tags) =>
  t.natural === "water" ||
  t.natural === "sea" ||
  t.waterway === "riverbank" ||
  (!!t.water && t.water !== "no");
const isGreen = (t: Tags) =>
  GREEN.leisure.includes(t.leisure) ||
  GREEN.landuse.includes(t.landuse) ||
  GREEN.natural.includes(t.natural);
const isRoadArea = (t: Tags) =>
  !!t["area:highway"] || (!!t.highway && t.area === "yes");
const isUnderground = (t: Tags) =>
  (!!t.tunnel && t.tunnel !== "no") ||
  t.location === "underground" ||
  Number(t.layer) < 0;

function category(t: Tags) {
  if (isBuilding(t)) return "building";
  if (isRoadArea(t)) return "roadArea";
  if (isWater(t)) return "water";
  if (isGreen(t)) return "green";
  return null;
}

/** Turn raw OSM elements into plain 2D shapes in model millimetres:
 * origin at the south-west corner, +X east, +Y north. */
export function extractFeatures(
  elements: OverpassElement[],
  bbox: BBox,
  mmPerM: number,
): Features {
  const [south, west, north] = bbox;
  const kx =
    111195 * Math.cos((((south + north) / 2) * Math.PI) / 180) * mmPerM;
  const ky = 111195 * mmPerM;
  const toRing = (geometry: LatLon[], closed: boolean): Ring => {
    const ring: Ring = [];
    for (const p of geometry) {
      const x = (p.lon - west) * kx,
        y = (p.lat - south) * ky;
      const last = ring[ring.length - 1];
      if (!last || Math.hypot(x - last[0], y - last[1]) > 1e-4)
        ring.push([x, y]);
    }
    if (
      closed &&
      ring.length > 1 &&
      Math.hypot(
        ring[0][0] - ring[ring.length - 1][0],
        ring[0][1] - ring[ring.length - 1][1],
      ) < 1e-4
    )
      ring.pop();
    return ring;
  };

  const unique = [
    ...new Map(elements.map((el) => [`${el.type}/${el.id}`, el])).values(),
  ];
  const ways = new Map(
    unique.filter((el) => el.type === "way").map((el) => [el.id, el]),
  );
  // An outer way tagged like its multipolygon would be drawn twice, without holes.
  const duplicates = new Set<number>();
  for (const el of unique) {
    if (el.type !== "relation" || !el.tags) continue;
    const kind = category(el.tags);
    if (!kind) continue;
    for (const member of el.members ?? []) {
      const tags = member.ref == null ? undefined : ways.get(member.ref)?.tags;
      if (member.type === "way" && tags && category(tags) === kind)
        duplicates.add(member.ref!);
    }
  }
  const polys = (el: OverpassElement): Poly[] =>
    elementPolygons(el, ways).flatMap((polygon) => {
      const outer = toRing(polygon.outer, true);
      if (outer.length < 3) return [];
      return [
        {
          outer,
          holes: polygon.holes
            .map((hole) => toRing(hole, true))
            .filter((hole) => hole.length >= 3),
        },
      ];
    });

  const out: Features = {
    buildings: [],
    roads: [],
    roadAreas: [],
    waterAreas: [],
    waterLines: [],
    green: [],
  };
  for (const el of unique) {
    const t = el.tags;
    if (!t || el.type === "node") continue;
    if (el.type === "way" && duplicates.has(el.id)) continue;

    if (isBuilding(t)) {
      if (isUnderground(t) || t.building === "underground") continue;
      const { height, estimated, includesRoof } = buildingHeight(t);
      const roof = roofFromTags(t);
      const eaveM = parseLengthMeters(t["printmap:eave_height"]);
      for (const poly of polys(el))
        out.buildings.push({
          poly,
          heightM: height,
          estimated,
          includesRoof,
          eaveM,
          roof,
          part: !t.building || t.building === "no",
        });
      continue;
    }
    if (isRoadArea(t)) {
      const kind = t["area:highway"] ?? t.highway;
      if (!isUnderground(t) && ROADS[kind]) out.roadAreas.push(...polys(el));
      continue;
    }
    if (el.type === "way" && el.geometry && (t.highway || t.railway)) {
      if (isUnderground(t)) continue;
      const road = t.railway ? (["streets", 4] as const) : ROADS[t.highway];
      if (!road) continue;
      if (t.footway === "sidewalk" || t.footway === "crossing") continue;
      const lanes = parseFloat(t.lanes ?? "");
      const widthM =
        parseLengthMeters(t.width) ??
        (lanes > 0 && road[0] !== "all" ? lanes * 3.2 : road[1]);
      const points = toRing(el.geometry, false);
      if (points.length >= 2)
        out.roads.push({
          points,
          widthM: Math.min(40, Math.max(1.5, widthM)),
          level: road[0],
        });
      continue;
    }
    if (isWater(t)) {
      if (!isUnderground(t)) out.waterAreas.push(...polys(el));
      continue;
    }
    if (el.type === "way" && el.geometry && WATERWAYS[t.waterway]) {
      if (isUnderground(t)) continue;
      const points = toRing(el.geometry, false);
      if (points.length >= 2)
        out.waterLines.push({
          points,
          widthM: Math.min(
            200,
            parseLengthMeters(t.width) ?? WATERWAYS[t.waterway],
          ),
        });
      continue;
    }
    if (isGreen(t)) out.green.push(...polys(el));
  }
  return out;
}
