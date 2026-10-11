import type { LatLon } from "@/types/osm";

// EPSG:2154, RGF93 / Lambert-93; ellipsoid GRS80 and two standard parallels.
const A = 6378137;
const E = Math.sqrt(2 / 298.257222101 - 1 / 298.257222101 ** 2);
const rad = Math.PI / 180;
const phi1 = 44 * rad,
  phi2 = 49 * rad,
  phi0 = 46.5 * rad;
const iso = (phi: number) =>
  Math.log(
    Math.tan(Math.PI / 4 + phi / 2) *
      ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2),
  );
const m = (phi: number) =>
  Math.cos(phi) / Math.sqrt(1 - E * E * Math.sin(phi) ** 2);
const N = Math.log(m(phi1) / m(phi2)) / (iso(phi2) - iso(phi1));
const C = (A * m(phi1) * Math.exp(N * iso(phi1))) / N;
const YS = 6600000 + C * Math.exp(-N * iso(phi0));

export function toLambert93(lon: number, lat: number): [number, number] {
  const radius = C * Math.exp(-N * iso(lat * rad));
  const angle = N * (lon - 3) * rad;
  return [700000 + radius * Math.sin(angle), YS - radius * Math.cos(angle)];
}

export function fromLambert93(x: number, y: number): LatLon {
  const radius = Math.hypot(x - 700000, YS - y);
  const latitudeIso = -Math.log(radius / C) / N;
  let phi = 2 * Math.atan(Math.exp(latitudeIso)) - Math.PI / 2;
  for (let i = 0; i < 8; i++)
    phi =
      2 *
        Math.atan(
          Math.exp(latitudeIso) *
            ((1 + E * Math.sin(phi)) / (1 - E * Math.sin(phi))) ** (E / 2),
        ) -
      Math.PI / 2;
  return { lon: 3 + Math.atan2(x - 700000, YS - y) / N / rad, lat: phi / rad };
}
