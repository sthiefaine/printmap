import type { BBox, OverpassElement } from "@/types/osm";

// These objects can be mapped as points or areas. A position alone does not
// describe a printable fountain or sculpture. Do not turn it into a basin.
export const LANDMARK_SELECTORS = [
  'nwr["amenity"="fountain"]',
  'nwr["tourism"="artwork"]["artwork_type"~"^(statue|sculpture)$"]',
  'nwr["historic"="monument"]',
  'nwr["historic"="memorial"]["memorial"!~"^(plaque|stolperstein)$"]',
] as const;

function landmarkKind(tags: Record<string, string> | undefined) {
  if (tags?.amenity === "fountain") return "fontaine";
  if (
    tags?.tourism === "artwork" &&
    /^(statue|sculpture)$/.test(tags.artwork_type ?? "")
  )
    return "sculpture";
  if (tags?.historic === "monument") return "monument";
  if (
    tags?.historic === "memorial" &&
    !/^(plaque|stolperstein)$/.test(tags.memorial ?? "")
  )
    return "mémorial";
  return null;
}

export function summarizePointLandmarks(
  elements: readonly OverpassElement[],
  bbox: BBox,
): { pointLandmarkCount: number; warnings: string[] } {
  const points = [
    ...new Map(
      elements
        .filter(
          (element) =>
            element.type === "node" &&
            landmarkKind(element.tags) &&
            !element.measuredSolid?.surfaces.length &&
            !element.roofSurfaces?.length &&
            Number.isFinite(element.lat) &&
            Number.isFinite(element.lon) &&
            element.lat! >= bbox[0] &&
            element.lon! >= bbox[1] &&
            element.lat! <= bbox[2] &&
            element.lon! <= bbox[3],
        )
        .map((element) => [element.id, element]),
    ).values(),
  ];
  if (!points.length) return { pointLandmarkCount: 0, warnings: [] };

  // Keep one readable warning, prioritising named fountains and heritage
  // objects rather than listing every small memorial in a large selection.
  const priority = (element: OverpassElement) =>
    (element.tags?.name ? 4 : 0) +
    (element.tags?.amenity === "fountain" ? 2 : 0) +
    (element.tags?.heritage ? 1 : 0);
  points.sort((a, b) => priority(b) - priority(a) || a.id - b.id);
  const examples = points.slice(0, 4).map((element) => {
    const name = element.tags?.name?.replace(/\s+/g, " ").trim().slice(0, 120);
    return name || `${landmarkKind(element.tags)} OSM ${element.id}`;
  });
  const remaining = points.length - examples.length;
  const subject =
    points.length === 1
      ? `Objet uniquement localisé par un point : ${examples[0]}`
      : `${points.length} fontaines, sculptures ou monuments uniquement localisés par des points : ${examples.join(" ; ")}${remaining ? ` ; et ${remaining} autres` : ""}`;
  return {
    pointLandmarkCount: points.length,
    warnings: [
      `${subject}. Aucune géométrie 3D de ces objets n’est fournie par les données collectées ; ils ne sont pas reconstruits dans la maquette.`,
    ],
  };
}
