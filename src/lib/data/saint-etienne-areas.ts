import type { BBox } from "@/types/osm";

export const SAINT_ETIENNE_STADIUM_BBOX: BBox = [
  45.4288, 4.3702, 45.4628, 4.406,
];

// The centre, Design, Expo and stadium fit in two nearly square tiles at the
// wide selection's four-plate scale. Couriot lies west of this corridor.
export const SAINT_ETIENNE_TWO_PLATE_BBOX: BBox = [
  45.4288, 4.3818, 45.4628, 4.406,
];

/** Use the same real raster sample positions for both salon selections.
 * Changing the acquisition window otherwise shifts the 2 m decimation and
 * can reject a roof that was usable in the wider selection, as at hall A.
 * Only footprints inside the requested selection are reconstructed. */
export function saintEtienneRoofAcquisitionBbox(bbox: BBox): BBox {
  return bbox.every(
    (coordinate, index) => coordinate === SAINT_ETIENNE_TWO_PLATE_BBOX[index],
  )
    ? [...SAINT_ETIENNE_STADIUM_BBOX]
    : [...bbox];
}
