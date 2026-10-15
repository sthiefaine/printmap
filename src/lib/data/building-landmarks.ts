import { saintEtienneLandmark } from "./saint-etienne-landmarks";

/** Names locate acquired geometry; the inventory never creates architecture. */
export function buildingLandmark(building: {
  sourceId?: string;
  tags: Record<string, string>;
}): { id: string; name: string } | undefined {
  const known = saintEtienneLandmark(building.sourceId);
  if (known) return known;
  if (building.sourceId === "MMM/B102558")
    return { id: "MMM/B102558", name: "L’Arbre Blanc" };
  const { tags, sourceId } = building;
  const name = (tags.name || tags.official_name)?.trim();
  if (!sourceId || !name || name.length > 160) return;
  const identifiable =
    /^(church|cathedral|chapel|mosque|temple|synagogue|stadium|civic|train_station)$/.test(
      tags.building ?? "",
    ) ||
    /^(place_of_worship|townhall|theatre|arts_centre|university|hospital)$/.test(
      tags.amenity ?? "",
    ) ||
    /^(museum|gallery|attraction)$/.test(tags.tourism ?? "") ||
    (!!tags.historic && tags.historic !== "no") ||
    tags.leisure === "stadium" ||
    tags.shop === "mall";
  return identifiable
    ? { id: tags["printmap:osm_id"] || sourceId, name }
    : undefined;
}
