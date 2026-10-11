import type { OverpassElement, BBox } from "@/types/osm";
import type { Point2D, Polygon2D } from "@/types/geometry";
import type { RoofShape } from "../constants";
import { ROAD_WIDTHS, WATERWAY_WIDTHS } from "../constants";
import { createProjectionForBbox } from "../projection";
import { cleanPolygon } from "../polygon/clean";
import { signedArea } from "../polygon/area";
import { ensureCCW, ensureCW } from "../polygon/winding";
import { elementPolygons, isClosedGeometry } from "./relation-polygons";
import { pointInPolygon } from "../polygon/point-in-polygon";
import {
  getBuildingHeight,
  getRoofShape,
  getRoofHeight,
  computeFootprintAreaM2,
  parseLengthMeters,
} from "./building-height";
import { classifyFootprint } from "../polygon/footprint-classify";
import type { FootprintClassification } from "../polygon/footprint-classify";

export interface BuildingData {
  polygon: Polygon2D;
  tags: Record<string, string>;
  wallHeight: number;
  roofShape: RoofShape;
  roofHeight: number;
  classification: FootprintClassification;
  heightSource?: string;
  sourceId?: string;
  minHeight?: number;
}

export type RoadClass = "major" | "minor" | "pedestrian" | "railway";

const ROAD_CLASS_MAP: Record<string, RoadClass> = {
  motorway: "major",
  motorway_link: "major",
  trunk: "major",
  trunk_link: "major",
  primary: "major",
  primary_link: "major",
  secondary: "major",
  secondary_link: "major",
  tertiary: "minor",
  tertiary_link: "minor",
  residential: "minor",
  unclassified: "minor",
  service: "pedestrian",
  footway: "pedestrian",
  path: "pedestrian",
  cycleway: "pedestrian",
  pedestrian: "pedestrian",
  track: "pedestrian",
  steps: "pedestrian",
  living_street: "minor",
};

export interface RoadData {
  polyline: Point2D[];
  halfWidth: number;
  roadClass: RoadClass;
  roadType: string;
  isUnderground: boolean;
  isBridge?: boolean;
}

export interface WaterwayData {
  polyline: Point2D[];
  halfWidth: number;
}

export interface WaterPolygonData {
  polygon: Polygon2D;
  isOcean: boolean;
}

export interface PierLineData {
  polyline: Point2D[];
  halfWidth: number;
}

export interface ParsedOSMData {
  buildings: BuildingData[];
  roads: RoadData[];
  waterAreas: WaterPolygonData[];
  waterways: WaterwayData[];
  parks: Polygon2D[];
  sandAreas: Polygon2D[];
  piers: Polygon2D[];
  pierLines: PierLineData[];
}

function projectAndScale(
  geom: Array<{ lat: number; lon: number }>,
  project: (lng: number, lat: number) => [number, number],
  sf: number,
): Point2D[] {
  return geom.map((p) => {
    const [x, y] = project(p.lon, p.lat);
    return [x * sf, y * sf] as Point2D;
  });
}

function toValidPolygon(points: Point2D[], minArea = 0.001): Point2D[] | null {
  const cleaned = cleanPolygon(points);
  if (cleaned.length < 3) return null;
  if (Math.abs(signedArea(cleaned)) < minArea) return null;
  return ensureCCW(cleaned);
}

function processWayBuilding(
  el: OverpassElement,
  project: (lng: number, lat: number) => [number, number],
  sf: number,
  innerGeometries?: Array<Array<{ lat: number; lon: number }>>,
): BuildingData | null {
  if (!isClosedGeometry(el.geometry)) return null;

  const points = projectAndScale(el.geometry, project, sf);
  const outer = toValidPolygon(points);
  if (!outer) return null;

  const holes: Point2D[][] = [];
  if (innerGeometries) {
    for (const innerGeom of innerGeometries) {
      if (innerGeom.length < 4) continue;
      const holePoints = projectAndScale(innerGeom, project, sf);
      const cleaned = cleanPolygon(holePoints);
      if (cleaned.length < 3) continue;
      if (Math.abs(signedArea(cleaned)) < 0.001) continue;
      holes.push(ensureCW(cleaned));
    }
  }

  const tags = el.tags ?? { building: "yes" };
  const hasHoles = holes.length > 0;
  const classification = classifyFootprint(outer);
  const footprintAreaM2 = computeFootprintAreaM2(outer, sf);
  const totalHeightM = getBuildingHeight(tags, footprintAreaM2);
  const roofShape = getRoofShape(tags, hasHoles, classification);
  const roofHeightM = getRoofHeight(tags, totalHeightM, roofShape);

  return {
    polygon: { outer, holes },
    tags,
    wallHeight:
      (parseLengthMeters(tags["printmap:eave_height"]) ??
        totalHeightM - roofHeightM) * sf,
    roofShape,
    roofHeight: roofHeightM * sf,
    classification,
    minHeight: Math.max(0, parseLengthMeters(tags["min_height"]) ?? 0) * sf,
    sourceId: tags["printmap:source_id"] ?? `${el.type}/${el.id}`,
    heightSource:
      tags["printmap:height_source"] ??
      (parseLengthMeters(tags.height) != null ||
      parseLengthMeters(tags["building:height"]) != null
        ? "OSM · hauteur renseignée"
        : parseFloat(tags["building:levels"]) > 0
          ? "OSM · étages"
          : "Estimation"),
  };
}

function isWaterTag(tags?: Record<string, string>): boolean {
  return (
    tags?.natural === "water" ||
    tags?.natural === "bay" ||
    tags?.natural === "sea" ||
    tags?.leisure === "swimming_pool" ||
    tags?.waterway === "riverbank" ||
    !!tags?.water
  );
}

/** Check if water is ocean/sea (large bodies of water) */
function isOcean(tags?: Record<string, string>): boolean {
  return tags?.natural === "sea" || tags?.natural === "bay" || false;
}

/** True for linear waterway features only (not riverbank which is an area) */
function isWaterwayTag(tags?: Record<string, string>): boolean {
  return (
    !!tags?.waterway &&
    ["river", "stream", "canal", "drain", "ditch"].includes(tags.waterway)
  );
}

function isParkTag(tags?: Record<string, string>): boolean {
  return (
    !!tags &&
    ([
      "park",
      "garden",
      "golf_course",
      "pitch",
      "recreation_ground",
      "nature_reserve",
    ].includes(tags.leisure) ||
      [
        "grass",
        "meadow",
        "forest",
        "farmland",
        "orchard",
        "vineyard",
        "recreation_ground",
        "village_green",
      ].includes(tags.landuse) ||
      ["wood", "grassland", "scrub", "heath", "wetland"].includes(tags.natural))
  );
}

function isSandTag(tags?: Record<string, string>): boolean {
  return tags?.natural === "beach" || tags?.natural === "sand" || false;
}

function isPierTag(tags?: Record<string, string>): boolean {
  return (
    tags?.man_made === "pier" ||
    tags?.man_made === "dock" ||
    tags?.man_made === "bridge" ||
    false
  );
}

function processPolygonWay(
  el: OverpassElement,
  project: (lng: number, lat: number) => [number, number],
  sf: number,
): Polygon2D | null {
  if (!isClosedGeometry(el.geometry)) return null;
  const points = projectAndScale(el.geometry, project, sf);
  const outer = toValidPolygon(points);
  if (!outer) return null;
  return { outer, holes: [] };
}

function processRelationPolygons(
  el: OverpassElement,
  project: (lng: number, lat: number) => [number, number],
  sf: number,
  ways: Map<number, OverpassElement>,
): Polygon2D[] {
  return elementPolygons(el, ways).flatMap((poly) => {
    const outer = toValidPolygon(projectAndScale(poly.outer, project, sf));
    if (!outer) return [];
    const holes = poly.holes.flatMap((hole) => {
      const valid = toValidPolygon(projectAndScale(hole, project, sf));
      return valid ? [ensureCW(valid)] : [];
    });
    return [{ outer, holes }];
  });
}

function featureCategory(tags?: Record<string, string>): string | null {
  if (tags?.building || tags?.["building:part"]) return "building";
  if (isWaterTag(tags)) return "water";
  if (isParkTag(tags)) return "park";
  if (isSandTag(tags)) return "sand";
  if (isPierTag(tags)) return "pier";
  return null;
}

function removeCoveredBuildingOutlines(
  buildings: BuildingData[],
): BuildingData[] {
  const parts = buildings.filter(
    (building) =>
      building.tags["building:part"] && building.tags["building:part"] !== "no",
  );
  if (!parts.length) return buildings;
  const bounds = (building: BuildingData) => {
    const xs = building.polygon.outer.map((p) => p[0]),
      ys = building.polygon.outer.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const buckets = new Map<string, BuildingData[]>();
  const keys = (box: number[]) => {
    const output: string[] = [];
    for (let x = Math.floor(box[0] / 10); x <= Math.floor(box[2] / 10); x++)
      for (let y = Math.floor(box[1] / 10); y <= Math.floor(box[3] / 10); y++)
        output.push(`${x}/${y}`);
    return output;
  };
  for (const part of parts)
    for (const key of keys(bounds(part)))
      buckets.set(key, [...(buckets.get(key) ?? []), part]);
  const contains = (building: BuildingData, x: number, y: number) =>
    pointInPolygon(x, y, building.polygon.outer) &&
    !building.polygon.holes.some((hole) => pointInPolygon(x, y, hole));
  return buildings.filter((building) => {
    if (
      building.tags["building:part"] &&
      building.tags["building:part"] !== "no"
    )
      return true;
    const box = bounds(building),
      candidates = [
        ...new Set(keys(box).flatMap((key) => buckets.get(key) ?? [])),
      ];
    if (!candidates.length) return true;
    let samples = 0,
      covered = 0;
    for (let x = 0; x < 9; x++)
      for (let y = 0; y < 9; y++) {
        const px = box[0] + ((x + 0.5) / 9) * (box[2] - box[0]);
        const py = box[1] + ((y + 0.5) / 9) * (box[3] - box[1]);
        if (!contains(building, px, py)) continue;
        samples++;
        if (candidates.some((part) => contains(part, px, py))) covered++;
      }
    // Full 3D parts supersede an envelope, whose global height would mask low wings.
    return samples < 12 || covered / samples < 0.9;
  });
}

export function parseElements(
  elements: OverpassElement[],
  bbox: BBox,
  scale: number,
): ParsedOSMData {
  const { project } = createProjectionForBbox(bbox);
  const sf = 1000 / scale;

  const result: ParsedOSMData = {
    buildings: [],
    roads: [],
    waterAreas: [],
    waterways: [],
    parks: [],
    sandAreas: [],
    piers: [],
    pierLines: [],
  };

  const unique = [
    ...new Map(elements.map((el) => [`${el.type}/${el.id}`, el])).values(),
  ];
  const ways = new Map(
    unique.filter((el) => el.type === "way").map((el) => [el.id, el]),
  );
  const memberFeatures = new Set<string>();
  // A tagged outer way can also be returned separately. Prefer the complete relation.
  for (const el of unique) {
    if (el.type !== "relation" || !elementPolygons(el, ways).length) continue;
    const category = featureCategory(el.tags);
    if (!category) continue;
    for (const member of el.members ?? []) {
      if (
        member.type === "way" &&
        member.ref != null &&
        featureCategory(ways.get(member.ref)?.tags) === category
      )
        memberFeatures.add(`way/${member.ref}`);
    }
  }

  for (const el of unique) {
    if (memberFeatures.has(`${el.type}/${el.id}`)) continue;
    const isBuilding =
      (el.tags?.building && el.tags.building !== "no") ||
      (el.tags?.["building:part"] && el.tags["building:part"] !== "no");
    if (isBuilding) {
      for (const polygon of elementPolygons(el, ways)) {
        const building = processWayBuilding(
          { ...el, geometry: polygon.outer },
          project,
          sf,
          polygon.holes,
        );
        if (building) result.buildings.push(building);
      }
    }

    // ── Roads ──
    if (
      el.type === "way" &&
      el.tags?.highway &&
      !["construction", "proposed", "platform"].includes(el.tags.highway) &&
      el.tags.area !== "yes" &&
      el.geometry
    ) {
      const roadType = el.tags.highway;
      const widthMeters =
        parseLengthMeters(el.tags.width) ??
        (parseFloat(el.tags.lanes ?? "") > 0 &&
        !["path", "footway", "cycleway"].includes(roadType)
          ? Math.min(40, parseFloat(el.tags.lanes) * 3)
          : (ROAD_WIDTHS[roadType] ?? 4));
      const roadClass = ROAD_CLASS_MAP[roadType] ?? "pedestrian";
      const polyline = projectAndScale(el.geometry, project, sf);
      if (polyline.length >= 2) {
        const isUnderground =
          el.tags?.tunnel === "yes" ||
          (!!el.tags?.layer && parseInt(el.tags.layer) < 0);
        result.roads.push({
          polyline,
          halfWidth: (widthMeters * sf) / 2,
          roadClass,
          roadType,
          isUnderground,
          isBridge: !!el.tags?.bridge && el.tags.bridge !== "no",
        });
      }
    }

    // ── Railways ──
    if (el.type === "way" && el.tags?.railway && el.geometry) {
      const polyline = projectAndScale(el.geometry, project, sf);
      if (polyline.length >= 2) {
        const isUnderground =
          el.tags?.tunnel === "yes" ||
          (!!el.tags?.layer && parseInt(el.tags.layer) < 0);
        result.roads.push({
          polyline,
          halfWidth: (3 * sf) / 2,
          roadClass: "railway",
          roadType: "railway",
          isUnderground,
          isBridge: !!el.tags?.bridge && el.tags.bridge !== "no",
        });
      }
    }

    // ── Water Areas ──
    if (el.type === "way" && isWaterTag(el.tags)) {
      const poly = processPolygonWay(el, project, sf);
      if (poly)
        result.waterAreas.push({ polygon: poly, isOcean: isOcean(el.tags) });
    }

    if (el.type === "relation" && isWaterTag(el.tags)) {
      const polys = processRelationPolygons(el, project, sf, ways);
      result.waterAreas.push(
        ...polys.map((poly) => ({ polygon: poly, isOcean: isOcean(el.tags) })),
      );
    }

    // ── Waterways (skip if already handled as water area) ──
    if (
      el.type === "way" &&
      isWaterwayTag(el.tags) &&
      !isWaterTag(el.tags) &&
      el.geometry
    ) {
      const wwType = el.tags!.waterway;
      const width =
        parseLengthMeters(el.tags?.width) ?? WATERWAY_WIDTHS[wwType] ?? 5;
      const polyline = projectAndScale(el.geometry, project, sf);
      if (polyline.length >= 2) {
        result.waterways.push({
          polyline,
          halfWidth: (width * sf) / 2,
        });
      }
    }

    // ── Parks ──
    if (el.type === "way" && isParkTag(el.tags)) {
      const poly = processPolygonWay(el, project, sf);
      if (poly) result.parks.push(poly);
    }

    if (el.type === "relation" && isParkTag(el.tags)) {
      const polys = processRelationPolygons(el, project, sf, ways);
      result.parks.push(...polys);
    }

    // ── Sand / Beach ──
    if (el.type === "way" && isSandTag(el.tags)) {
      const poly = processPolygonWay(el, project, sf);
      if (poly) result.sandAreas.push(poly);
    }

    if (el.type === "relation" && isSandTag(el.tags)) {
      const polys = processRelationPolygons(el, project, sf, ways);
      result.sandAreas.push(...polys);
    }

    // ── Piers / Docks ──
    if (el.type === "way" && isPierTag(el.tags) && el.geometry) {
      const poly = processPolygonWay(el, project, sf);
      if (poly) {
        result.piers.push(poly);
      } else if (el.geometry.length >= 2) {
        // Linear pier (not a closed polygon) → treat as ribbon
        const polyline = projectAndScale(el.geometry, project, sf);
        result.pierLines.push({ polyline, halfWidth: (2 * sf) / 2 });
      }
    }

    if (el.type === "relation" && isPierTag(el.tags)) {
      const polys = processRelationPolygons(el, project, sf, ways);
      result.piers.push(...polys);
    }
  }

  result.buildings = removeCoveredBuildingOutlines(result.buildings);
  return result;
}
