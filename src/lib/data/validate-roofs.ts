import type { OverpassElement } from "@/types/osm";

export const MAX_ROOF_VERTICES = 400000;
export const MAX_ROOF_BUILDINGS = 15000;

/** Import boundary: bound the total work and reject malformed measured roof geometry. */
export function validateRoofData(elements: OverpassElement[]): void {
  let vertices = 0,
    buildings = 0;
  for (const element of elements) {
    if (element.roofSurfaces == null && element.measuredSolid == null) continue;
    if (
      (element.roofSurfaces != null &&
        (!Array.isArray(element.roofSurfaces) ||
          !element.roofSurfaces.length ||
          element.roofSurfaces.length > 5000)) ||
      ++buildings > MAX_ROOF_BUILDINGS ||
      !Number.isFinite(element.groundElevation) ||
      element.groundElevation! < -100 ||
      element.groundElevation! > 1000
    )
      throw new Error("Toitures mesurées du projet invalides.");
    if (element.measuredSolid != null) {
      const solid = element.measuredSolid;
      if (
        !solid ||
        !Array.isArray(solid.surfaces) ||
        !solid.surfaces.length ||
        solid.surfaces.length > 5000 ||
        typeof solid.source !== "string" ||
        !solid.source.length ||
        solid.source.length > 1000 ||
        !Number.isInteger(solid.year) ||
        solid.year < 1900 ||
        solid.year > 2100 ||
        solid.surfaces.some(
          (surface) =>
            !surface ||
            ![
              "roof",
              "wall",
              "ground",
              "outerCeiling",
              "outerFloor",
              "closure",
            ].includes(surface.kind),
        )
      )
        throw new Error("Coque 3D mesurée du projet invalide.");
    }
    for (const roof of [
      ...(element.roofSurfaces ?? []),
      ...(element.measuredSolid?.surfaces ?? []),
    ]) {
      if (
        !roof ||
        !Array.isArray(roof.outer) ||
        !Array.isArray(roof.holes) ||
        roof.holes.length > 1000
      )
        throw new Error("Panneau de toiture invalide.");
      for (const ring of [roof.outer, ...roof.holes]) {
        if (!Array.isArray(ring) || ring.length < 4 || ring.length > 20000)
          throw new Error("Contour de toiture invalide.");
        vertices += ring.length;
        if (vertices > MAX_ROOF_VERTICES)
          throw new Error("Le projet contient trop de détails de toiture.");
        for (const point of ring)
          if (
            !point ||
            ![point.lat, point.lon, point.elevation].every(Number.isFinite) ||
            Math.abs(point.lat) > 85 ||
            Math.abs(point.lon) > 180 ||
            point.elevation < -100 ||
            point.elevation > 1000
          )
            throw new Error("Altitude ou coordonnées de toiture invalides.");
        const first = ring[0],
          last = ring.at(-1)!;
        if (
          Math.abs(first.lon - last.lon) > 1e-7 ||
          Math.abs(first.lat - last.lat) > 1e-7 ||
          Math.abs(first.elevation - last.elevation) > 0.01
        )
          throw new Error("Contour de toiture ouvert.");
      }
    }
  }
}
