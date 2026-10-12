import type { BBox, MeasuredSurface, RoofSurface } from "@/types/osm";
import { convexEnvelope, type Lod2Building } from "./citygml-parser";
import { fromLambert93 } from "./lambert93";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value != null && typeof value === "object" && !Array.isArray(value);
const triple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

const kinds: Record<string, MeasuredSurface["kind"]> = {
  RoofSurface: "roof",
  WallSurface: "wall",
  GroundSurface: "ground",
  OuterCeilingSurface: "outerCeiling",
  OuterFloorSurface: "outerFloor",
  ClosureSurface: "closure",
};

/** Decode surveyed Lambert-93 / IGN69 surfaces, never infer a missing roof. */
export function parseCityJSONBuildings(
  document: unknown,
  metadata: { source: string; year: number },
): { buildings: Lod2Building[]; skippedBuildingCount: number } {
  if (
    !record(document) ||
    document.type !== "CityJSON" ||
    !["1.0", "1.1", "2.0"].includes(String(document.version)) ||
    !record(document.CityObjects) ||
    !Array.isArray(document.vertices) ||
    document.vertices.length > 200000 ||
    !record(document.metadata) ||
    !/\/EPSG\/0\/2154$/.test(String(document.metadata.referenceSystem)) ||
    !metadata.source ||
    metadata.source.length > 1000 ||
    !Number.isInteger(metadata.year) ||
    metadata.year < 1900 ||
    metadata.year > 2100
  )
    throw new Error("Modèle CityJSON ou projection Lambert-93 invalide.");
  const objects = Object.entries(document.CityObjects);
  if (objects.length > 15000 || !document.vertices.every(triple))
    throw new Error("Le modèle CityJSON dépasse les limites de géométrie.");
  const transform = document.transform;
  if (
    transform != null &&
    (!record(transform) ||
      !triple(transform.scale) ||
      transform.scale.some((value) => value <= 0 || value > 1) ||
      !triple(transform.translate))
  )
    throw new Error("Transformation CityJSON invalide.");
  const scale = record(transform) ? (transform.scale as number[]) : [1, 1, 1];
  const translate = record(transform)
    ? (transform.translate as number[])
    : [0, 0, 0];
  const vertices = document.vertices as number[][];
  const converted = new Map<number, RoofSurface["outer"][number]>();
  const point = (index: unknown) => {
    if (
      !Number.isInteger(index) ||
      Number(index) < 0 ||
      Number(index) >= vertices.length
    )
      throw new Error("Sommet CityJSON invalide.");
    const at = Number(index);
    const known = converted.get(at);
    if (known) return known;
    const [x, y, z] = vertices[at].map(
      (value, axis) => value * scale[axis] + translate[axis],
    );
    if (
      x < -200000 ||
      x > 1400000 ||
      y < 6000000 ||
      y > 7200000 ||
      z < -100 ||
      z > 1000 ||
      ![x, y, z].every(Number.isFinite)
    )
      throw new Error("Coordonnées CityJSON hors Lambert-93 / IGN69.");
    const result = { ...fromLambert93(x, y), elevation: z };
    converted.set(at, result);
    return result;
  };
  const ring = (indices: unknown): RoofSurface["outer"] => {
    if (!Array.isArray(indices) || indices.length < 3 || indices.length > 20000)
      throw new Error("Contour CityJSON invalide.");
    const result = indices.map(point);
    const first = result[0],
      last = result.at(-1)!;
    if (first !== last) result.push(first);
    if (new Set(result).size < 3) throw new Error("Contour CityJSON dégénéré.");
    return result;
  };

  const buildings: Lod2Building[] = [];
  let skippedBuildingCount = 0,
    vertexCount = 0;
  for (const [id, object] of objects) {
    if (
      !record(object) ||
      !["Building", "BuildingPart"].includes(String(object.type))
    )
      continue;
    try {
      if (!Array.isArray(object.geometry) || id.length > 256)
        throw new Error("Bâtiment CityJSON invalide.");
      // The CRAIG delivery repeats each surveyed surface in a Solid without
      // semantics. Read its semantic MultiSurface once, at the highest LoD.
      const geometry = object.geometry
        .filter(
          (value): value is RecordValue =>
            record(value) &&
            value.type === "MultiSurface" &&
            record(value.semantics) &&
            Number(value.lod) >= 2,
        )
        .sort((a, b) => Number(b.lod) - Number(a.lod))[0];
      if (
        !geometry ||
        !Array.isArray(geometry.boundaries) ||
        geometry.boundaries.length > 5000 ||
        !record(geometry.semantics) ||
        !Array.isArray(geometry.semantics.surfaces) ||
        !Array.isArray(geometry.semantics.values) ||
        geometry.semantics.values.length !== geometry.boundaries.length
      )
        throw new Error("Surfaces sémantiques CityJSON absentes.");
      const descriptions = geometry.semantics.surfaces;
      const surfaces: MeasuredSurface[] = geometry.boundaries.map(
        (boundary, at) => {
          const semantic = geometry.semantics as RecordValue;
          const index = (semantic.values as unknown[])[at];
          if (
            !Number.isInteger(index) ||
            Number(index) < 0 ||
            Number(index) >= descriptions.length
          )
            throw new Error("Sémantique CityJSON invalide.");
          const description = descriptions[Number(index)];
          const kind = record(description)
            ? kinds[String(description.type)]
            : undefined;
          if (
            !kind ||
            !Array.isArray(boundary) ||
            !boundary.length ||
            boundary.length > 1001
          )
            throw new Error("Face CityJSON invalide.");
          return {
            kind,
            outer: ring(boundary[0]),
            holes: boundary.slice(1).map(ring),
          };
        },
      );
      const roofSurfaces = surfaces.filter(
        (surface) => surface.kind === "roof",
      );
      const ground = surfaces.filter((surface) => surface.kind === "ground");
      if (!roofSurfaces.length || !ground.length)
        throw new Error("Toiture ou fondation mesurée absente.");
      const groundPoints = ground.flatMap((surface) => surface.outer);
      const groundElevation = Math.min(...groundPoints.map((p) => p.elevation));
      const height =
        Math.max(
          ...roofSurfaces.flatMap((surface) =>
            surface.outer.map((p) => p.elevation),
          ),
        ) - groundElevation;
      if (height <= 0 || height > 300)
        throw new Error("Hauteur CityJSON invalide.");
      const complex =
        ground.length > 1 ||
        surfaces.some(
          (surface) =>
            surface.kind === "outerCeiling" ||
            surface.kind === "outerFloor" ||
            (surface.kind === "wall" && surface.holes.length > 0),
        );
      // Claim a complete boundary only when the delivery also references every
      // semantic face in one exterior Solid shell, with no omitted cavity shell.
      const faceKeys = geometry.boundaries
        .map((face) => JSON.stringify(face))
        .sort();
      const solid = object.geometry.find(
        (value) =>
          record(value) &&
          value.type === "Solid" &&
          Number(value.lod) === Number(geometry.lod) &&
          Array.isArray(value.boundaries) &&
          value.boundaries.length === 1 &&
          Array.isArray(value.boundaries[0]) &&
          JSON.stringify(
            value.boundaries[0].map((face) => JSON.stringify(face)).sort(),
          ) === JSON.stringify(faceKeys),
      );
      const measuredSolid =
        complex && solid
          ? { surfaces, source: metadata.source, year: metadata.year }
          : undefined;
      const footprints = ground.map(({ outer, holes }) => ({
        outer: outer.map(({ lat, lon }) => ({ lat, lon })),
        holes: holes.map((inner) =>
          inner.map(({ lat, lon }) => ({ lat, lon })),
        ),
      }));
      const envelope = measuredSolid
        ? convexEnvelope(surfaces.flatMap((surface) => surface.outer))
        : undefined;
      const searchPoints = envelope?.outer ?? groundPoints;
      const bounds: BBox = [
        Math.min(...searchPoints.map((p) => p.lat)),
        Math.min(...searchPoints.map((p) => p.lon)),
        Math.max(...searchPoints.map((p) => p.lat)),
        Math.max(...searchPoints.map((p) => p.lon)),
      ];
      const count = [
        ...roofSurfaces,
        ...(measuredSolid?.surfaces ?? []),
      ].reduce(
        (sum, surface) =>
          sum +
          surface.outer.length +
          surface.holes.reduce((n, inner) => n + inner.length, 0),
        0,
      );
      if (vertexCount + count > 400000)
        throw new Error("Trop de détails CityJSON.");
      vertexCount += count;
      buildings.push({
        id,
        roofSurfaces,
        footprints,
        groundElevation,
        height,
        bounds,
        measuredSolid,
        envelope,
      });
    } catch {
      // An incomplete surveyed object keeps its OSM/IGN fallback; never erase
      // courtyard rings or invent a closing face to make the import succeed.
      skippedBuildingCount++;
    }
  }
  return { buildings, skippedBuildingCount };
}
