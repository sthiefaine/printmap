import type { BBox } from "@/types/osm";

export const MAX_AREA_KM2 = 25;

export function bboxDimensions(bbox: BBox) {
  const [south, west, north, east] = bbox;
  const heightM = (north - south) * 111195;
  const widthM =
    (east - west) * 111195 * Math.cos((((south + north) / 2) * Math.PI) / 180);
  return { widthM, heightM, areaKm2: (widthM * heightM) / 1e6 };
}

export function validateBbox(value: unknown): BBox {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    throw new Error(
      "Zone invalide : coordonnées [sud, ouest, nord, est] attendues.",
    );
  }
  const bbox = value as BBox;
  const [south, west, north, east] = bbox;
  if (
    south < -85 ||
    north > 85 ||
    west < -180 ||
    east > 180 ||
    south >= north ||
    west >= east
  ) {
    throw new Error(
      "Zone invalide : vérifiez les coordonnées et l’ordre des limites.",
    );
  }
  const { widthM, heightM, areaKm2 } = bboxDimensions(bbox);
  if (widthM < 20 || heightM < 20)
    throw new Error("Sélectionnez une zone d’au moins 20 m de côté.");
  if (areaKm2 > MAX_AREA_KM2 || Math.max(widthM, heightM) > 12000) {
    throw new Error(
      "Zone trop grande : sélectionnez au maximum 25 km², avec moins de 12 km de côté. Un quartier donnera une impression plus lisible.",
    );
  }
  return bbox;
}

export function isMetropolitanFrance(bbox: BBox) {
  return (
    bbox[0] >= 41.3 && bbox[2] <= 51.2 && bbox[1] >= -5.3 && bbox[3] <= 9.7
  );
}
