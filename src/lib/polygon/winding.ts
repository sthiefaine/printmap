import type { Point2D } from "@/types/geometry";
import { isClockwise } from "./area";

export function ensureCCW(points: Point2D[]): Point2D[] {
  return isClockwise(points) ? [...points].reverse() : points;
}

export function ensureCW(points: Point2D[]): Point2D[] {
  return isClockwise(points) ? points : [...points].reverse();
}
