import type { LatLon, OverpassElement } from "@/types/osm";

export interface GeographicPolygon {
  outer: LatLon[];
  holes: LatLon[][];
}

export function sameLocation(a: LatLon, b: LatLon) {
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
}

export function isClosedGeometry(geometry?: LatLon[]): geometry is LatLon[] {
  return (
    !!geometry &&
    geometry.length >= 4 &&
    geometry.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)) &&
    sameLocation(geometry[0], geometry[geometry.length - 1])
  );
}

/** OSM rings can consist of unordered ways, with either direction. Never close gaps. */
export function assembleRings(fragments: LatLon[][]): LatLon[][] {
  const pending = fragments
    .filter(
      (g) =>
        g.length >= 2 &&
        g.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)),
    )
    .map((g) => [...g]);
  const rings: LatLon[][] = [];
  while (pending.length) {
    const chain = pending.shift()!;
    while (!sameLocation(chain[0], chain[chain.length - 1])) {
      const end = chain[chain.length - 1];
      const index = pending.findIndex(
        (g) => sameLocation(end, g[0]) || sameLocation(end, g[g.length - 1]),
      );
      if (index < 0) break;
      const next = pending.splice(index, 1)[0];
      if (!sameLocation(end, next[0])) next.reverse();
      chain.push(...next.slice(1));
    }
    if (isClosedGeometry(chain)) rings.push(chain);
  }
  return rings;
}

export function geographicPointInRing(point: LatLon, ring: LatLon[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.lat > point.lat !== b.lat > point.lat &&
      point.lon <
        ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon
    )
      inside = !inside;
  }
  return inside;
}

export function relationPolygons(
  element: OverpassElement,
  ways?: Map<number, OverpassElement>,
): GeographicPolygon[] {
  const outerFragments: LatLon[][] = [],
    innerFragments: LatLon[][] = [];
  for (const member of element.members ?? []) {
    if (member.type !== "way") continue;
    const geometry =
      member.geometry ??
      (member.ref == null ? undefined : ways?.get(member.ref)?.geometry);
    if (!geometry) continue;
    if (member.role === "inner") innerFragments.push(geometry);
    else if (member.role === "outer" || member.role === "")
      outerFragments.push(geometry);
  }
  const outers = assembleRings(outerFragments),
    inners = assembleRings(innerFragments);
  return outers.map((outer) => ({
    outer,
    holes: inners.filter((hole) => geographicPointInRing(hole[0], outer)),
  }));
}

export function elementPolygons(
  element: OverpassElement,
  ways?: Map<number, OverpassElement>,
): GeographicPolygon[] {
  if (element.type === "relation") return relationPolygons(element, ways);
  return isClosedGeometry(element.geometry)
    ? [{ outer: element.geometry, holes: [] }]
    : [];
}
