import type { BBox } from "@/types/osm";
import { createProjectionForBbox } from "../projection";

export function getBboxDimensions(
  bbox: BBox,
  scale: number,
  originLat?: number,
): { widthMm: number; heightMm: number } {
  const { project } = createProjectionForBbox(bbox, originLat);
  const sf = 1000 / scale;

  const [x1, y1] = project(bbox[1], bbox[0]);
  const [x2, y2] = project(bbox[3], bbox[2]);

  return {
    widthMm: Math.abs(x2 - x1) * sf,
    heightMm: Math.abs(y2 - y1) * sf,
  };
}
