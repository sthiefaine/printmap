import type { OverpassElement } from "@/types/osm";

const MAX_COORDINATES = 1_000_000;
const MAX_MEMBERS = 1_000_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Validate untrusted project geometry before any settings or geography changes. */
export function validateImportedElements(
  elements: unknown,
): asserts elements is OverpassElement[] {
  if (!Array.isArray(elements) || elements.length > 70000)
    throw new Error("Données du projet invalides ou trop volumineuses.");
  let coordinates = 0;
  let members = 0;
  const point = (value: unknown) => {
    if (
      !isRecord(value) ||
      typeof value.lat !== "number" ||
      typeof value.lon !== "number" ||
      !Number.isFinite(value.lat) ||
      !Number.isFinite(value.lon) ||
      Math.abs(value.lat) > 85 ||
      Math.abs(value.lon) > 180
    )
      throw new Error("Coordonnées géographiques du projet invalides.");
  };
  const geometry = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error("Géométrie du projet invalide.");
    coordinates += value.length;
    if (coordinates > MAX_COORDINATES)
      throw new Error("Le projet contient trop de coordonnées géographiques.");
    for (const coordinate of value) point(coordinate);
  };
  const tags = (value: unknown) => {
    if (
      value !== undefined &&
      (!isRecord(value) ||
        Object.values(value).some((tag) => typeof tag !== "string"))
    )
      throw new Error("Attributs géographiques du projet invalides.");
  };
  for (const element of elements) {
    if (
      !isRecord(element) ||
      typeof element.type !== "string" ||
      !["node", "way", "relation"].includes(element.type) ||
      !Number.isSafeInteger(element.id)
    )
      throw new Error("Élément géographique du projet invalide.");
    tags(element.tags);
    if (element.geometry !== undefined) geometry(element.geometry);
    if (element.lat !== undefined || element.lon !== undefined) {
      point(element);
      if (++coordinates > MAX_COORDINATES)
        throw new Error(
          "Le projet contient trop de coordonnées géographiques.",
        );
    }
    if (element.members !== undefined) {
      if (!Array.isArray(element.members))
        throw new Error("Membres géographiques du projet invalides.");
      members += element.members.length;
      if (members > MAX_MEMBERS)
        throw new Error("Le projet contient trop de membres géographiques.");
      for (const member of element.members) {
        if (
          !isRecord(member) ||
          typeof member.type !== "string" ||
          typeof member.role !== "string" ||
          (member.ref !== undefined && !Number.isSafeInteger(member.ref))
        )
          throw new Error("Membre géographique du projet invalide.");
        tags(member.tags);
        if (member.geometry !== undefined) geometry(member.geometry);
      }
    }
  }
}
