export type Point2D = [number, number]; // [x, y] in projected meters
export type Ring = Point2D[];

export interface Polygon2D {
  outer: Ring;
  holes: Ring[];
}
