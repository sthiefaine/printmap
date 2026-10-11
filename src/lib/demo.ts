import type {
  BBox,
  OverpassResponse,
  OverpassElement,
  ElevationGrid,
  DataReport,
} from "@/types/osm";

export const DEMO_BBOX: BBox = [43.605, 3.867, 43.613, 3.878];

/** An invented district, stored locally to exercise every printable layer offline. */
export function createDemoData(): {
  osmData: OverpassResponse;
  elevationGrid: ElevationGrid;
  report: DataReport;
} {
  const [south, west, north, east] = DEMO_BBOX;
  const point = (x: number, y: number) => ({
    lon: west + x * (east - west),
    lat: south + y * (north - south),
  });
  const elements: OverpassElement[] = [];
  let id = 900000;
  const polygon = (
    coordinates: [number, number][],
    tags: Record<string, string>,
  ) => {
    const ring = [...coordinates, coordinates[0]].map(([x, y]) => point(x, y));
    elements.push({ type: "way", id: id++, tags, geometry: ring });
  };
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 6; col++) {
      if ((col === 4 && row >= 2) || (row === 1 && col === 1)) continue;
      const x = 0.075 + col * 0.145;
      const y = 0.085 + row * 0.175;
      const width = col % 2 === 0 ? 0.07 : 0.095;
      const height = row % 2 === 0 ? 0.09 : 0.07;
      polygon(
        [
          [x, y],
          [x + width, y],
          [x + width, y + height],
          [x, y + height],
        ],
        {
          building: col === 2 ? "apartments" : "residential",
          height: String(8 + ((row * 3 + col) % 6) * 3),
          ...(col % 3 === 0
            ? {
                "roof:shape": "gabled",
                "roof:height": "2",
                "roof:direction": "90",
              }
            : {}),
        },
      );
    }
  }
  const line = (
    coordinates: [number, number][],
    tags: Record<string, string>,
  ) =>
    elements.push({
      type: "way",
      id: id++,
      tags,
      geometry: coordinates.map(([x, y]) => point(x, y)),
    });
  for (let col = 0; col < 6; col++)
    line(
      [
        [0.055 + col * 0.145, 0],
        [0.055 + col * 0.145, 1],
      ],
      {
        highway: col === 2 ? "secondary" : "residential",
        width: col === 2 ? "12" : "7",
      },
    );
  for (let row = 0; row < 5; row++)
    line(
      [
        [0, 0.065 + row * 0.175],
        [1, 0.065 + row * 0.175],
      ],
      { highway: row === 2 ? "tertiary" : "residential", width: "8" },
    );
  polygon(
    [
      [0.64, 0.45],
      [0.87, 0.46],
      [0.88, 0.76],
      [0.68, 0.79],
    ],
    { leisure: "park" },
  );
  polygon(
    [
      [0.73, 0.53],
      [0.82, 0.52],
      [0.84, 0.6],
      [0.8, 0.67],
      [0.72, 0.64],
    ],
    { natural: "water", water: "pond" },
  );
  polygon(
    [
      [0.22, 0.26],
      [0.32, 0.26],
      [0.32, 0.34],
      [0.22, 0.34],
    ],
    { leisure: "garden" },
  );
  line(
    [
      [0.96, 0],
      [0.93, 0.25],
      [0.965, 0.48],
      [0.94, 0.8],
      [0.97, 1],
    ],
    { waterway: "river", width: "18" },
  );
  line(
    [
      [0.66, 0.49],
      [0.85, 0.69],
    ],
    { highway: "footway", width: "2" },
  );
  polygon(
    [
      [0.72, 0.76],
      [0.88, 0.76],
      [0.88, 0.84],
      [0.72, 0.84],
    ],
    { natural: "sand" },
  );
  const rows = 8,
    cols = 8;
  const points = Array.from(
    { length: rows * cols },
    (_, i) => 24 + (i % cols) * 1.2 + Math.sin(Math.floor(i / cols) / 2) * 3,
  );
  const elevationGrid = {
    rows,
    cols,
    points,
    south,
    west,
    north,
    east,
    minElev: Math.min(...points),
    maxElev: Math.max(...points),
  };
  return {
    osmData: { elements },
    elevationGrid,
    report: {
      sources: ["Démonstration synthétique locale"],
      warnings: [
        "Ce quartier est inventé pour essayer l'atelier. Il ne représente pas les bâtiments réels de Montpellier.",
      ],
      fetchedAt: new Date().toISOString(),
      areaKm2: 0.8,
      elementCount: elements.length,
      buildingCount: 26,
      measuredBuildingCount: 0,
      ignBuildingCount: 0,
      elevationSource: "Relief synthétique",
      elevationResolutionM: 120,
      seaCoverage: "unavailable",
    },
  };
}
