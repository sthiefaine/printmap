import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { createDemoData, DEMO_BBOX } from "../../src/lib/demo";
import { getBboxDimensions } from "../../src/lib/mesh/base-plate-mesh";
import { parseCityGMLBuilding } from "../../src/lib/data/citygml-parser";
import {
  enrichWithMunicipalRoofs,
  MONTPELLIER_LOD2_SOURCE,
} from "../../src/lib/data/montpellier-lod2";
import { assertClosedSolid } from "../helpers/solid";
import {
  salonPrintLayouts,
  SAINT_ETIENNE_STADIUM_BBOX,
  SAINT_ETIENNE_TWO_PLATE_BBOX,
} from "../../src/lib/print-layout";
import {
  IGN_ROOF_SOURCE,
  reconstructIGNRoof,
  type IGNRoofGrid,
} from "../../src/lib/data/ign-roofs";
import type {
  BBox,
  MapDataResponse,
  OverpassElement,
} from "../../src/types/osm";
import type { PrintMesh } from "../../src/types/print";

async function demo(page: Page) {
  await page
    .getByRole("button", { name: /Essayer une démo sans réseau/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("DÉMO SYNTHÉTIQUE · quartier inventé", { exact: true }),
  ).toBeVisible();
}
async function download(page: Page, name: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  const item = await pending;
  const path = await item.path();
  expect(path).toBeTruthy();
  return { bytes: await readFile(path!), name: item.suggestedFilename() };
}
function stlBounds(bytes: Buffer) {
  const triangles = bytes.readUInt32LE(80);
  expect(bytes.length).toBe(84 + triangles * 50);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triangles; i++)
    for (let vertex = 0; vertex < 3; vertex++)
      for (let axis = 0; axis < 3; axis++) {
        const value = bytes.readFloatLE(
          84 + i * 50 + 12 + vertex * 12 + axis * 4,
        );
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
  return { min, max, size: max.map((value, i) => value - min[i]) };
}

async function horizontalSurfaceHeights(bytes: Buffer, layer: string) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("3D/3dmodel.model")!.async("string");
  const materials = [...xml.matchAll(/<base name="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const material = materials.indexOf(layer);
  expect(material).toBeGreaterThanOrEqual(0);
  const vertices = [...xml.matchAll(/<vertex[^>]+z="([^"]+)"/g)].map((match) =>
    Number(match[1]),
  );
  const heights: number[] = [];
  for (const match of xml.matchAll(/<triangle\s+([^>]+)\/>/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/(\w+)="([^"]+)"/g)].map((attribute) => [
        attribute[1],
        attribute[2],
      ]),
    );
    if (Number(attributes.p1) !== material) continue;
    const z = [attributes.v1, attributes.v2, attributes.v3].map(
      (index) => vertices[Number(index)],
    );
    if (Math.max(...z) - Math.min(...z) < 1e-5) heights.push(z[0]);
  }
  expect(heights.length).toBeGreaterThan(0);
  return heights;
}

function meshFrom3MF(xml: string): PrintMesh {
  const attributes = (text: string) =>
    Object.fromEntries(
      [...text.matchAll(/(\w+)="([^"]+)"/g)].map((attribute) => [
        attribute[1],
        Number(attribute[2]),
      ]),
    );
  const vertices = [...xml.matchAll(/<vertex\s+([^>]+)\/>/g)].flatMap(
    (match) => {
      const vertex = attributes(match[1]);
      return [vertex.x, vertex.y, vertex.z];
    },
  );
  const triangles = [...xml.matchAll(/<triangle\s+([^>]+)\/>/g)].map((match) =>
    attributes(match[1]),
  );
  return {
    positions: new Float32Array(vertices),
    indices: new Uint32Array(
      triangles.flatMap((triangle) => [triangle.v1, triangle.v2, triangle.v3]),
    ),
    faceLayers: new Uint8Array(triangles.map((triangle) => triangle.p1)),
  };
}

function enclosedDemoData(bbox: BBox) {
  const data = createDemoData();
  const [south, west, north, east] = bbox;
  // Resize the synthetic fixture so all its geometry belongs to the requested
  // area, while retaining its known roads, buildings and natural surfaces.
  for (const element of data.osmData.elements)
    for (const point of element.geometry || []) {
      point.lat =
        south +
        ((point.lat - DEMO_BBOX[0]) / (DEMO_BBOX[2] - DEMO_BBOX[0])) *
          (north - south);
      point.lon =
        west +
        ((point.lon - DEMO_BBOX[1]) / (DEMO_BBOX[3] - DEMO_BBOX[1])) *
          (east - west);
    }
  data.elevationGrid = { ...data.elevationGrid, south, west, north, east };
  return data;
}

test.beforeEach(async ({ page }) => {
  // The core workflow must remain usable when the external basemap is unavailable.
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
});

test("offline workshop exports actual dimensions, colours and distinct tiles", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await demo(page);
  const initial = stlBounds((await download(page, "Télécharger le STL")).bytes);
  expect(Math.max(...initial.size.slice(0, 2))).toBeCloseTo(200, 2);
  expect(initial.min[2]).toBe(0);
  await page
    .getByRole("spinbutton", { name: /Long côté de la pièce/ })
    .fill("160");
  await expect(
    page.getByRole("spinbutton", { name: /Long côté de la pièce/ }),
  ).toHaveValue("160");
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  const resized = stlBounds((await download(page, "Télécharger le STL")).bytes);
  expect(Math.max(...resized.size.slice(0, 2))).toBeCloseTo(160, 2);
  await page
    .getByLabel("Couleur : Lacs, rivières et mer", { exact: true })
    .fill("#123abc");
  await expect(
    page.getByRole("button", { name: "Télécharger le 3MF", exact: true }),
  ).toBeEnabled();
  const colored = await JSZip.loadAsync(
    (await download(page, "Télécharger le 3MF")).bytes,
  );
  expect(await colored.file("3D/3dmodel.model")!.async("string")).toContain(
    'displaycolor="#123ABCFF"',
  );
  await page
    .getByRole("spinbutton", { name: "Colonnes de tuiles", exact: true })
    .fill("2");
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  const tileDownload = await download(page, "Télécharger le STL");
  expect(tileDownload.name).toMatch(/tuiles\.zip$/);
  const tiles = await JSZip.loadAsync(tileDownload.bytes);
  const left = await tiles.file("tuile_1_1.stl")!.async("nodebuffer");
  const right = await tiles.file("tuile_1_2.stl")!.async("nodebuffer");
  expect(left.equals(right)).toBe(false);
  expect(stlBounds(left).size[0]).toBeCloseTo(resized.size[0] / 2, 2);
  expect(errors).toEqual([]);
});

test("saved project restores the zone and raw data without network collection", async ({
  page,
}) => {
  await demo(page);
  const saved = await download(page, "Enregistrer");
  const project = JSON.parse(saved.bytes.toString());
  expect(project.version).toBe(2);
  expect(project.snapshot.osmData.elements.length).toBeGreaterThan(30);
  await page.getByRole("button", { name: "Effacer la sélection" }).click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: saved.name,
    mimeType: "application/json",
    buffer: saved.bytes,
  });
  await expect(
    page.getByText("Projet restauré, données disponibles hors ligne.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
});

test("collection error can be retried and cancellation ignores a late response", async ({
  page,
}) => {
  let calls = 0;
  let resolveDelayed: (() => void) | undefined;
  await page.route("**/api/map-data", async (route) => {
    calls++;
    if (calls === 1)
      await route.fulfill({
        status: 503,
        json: { error: "Source de test indisponible" },
      });
    else if (calls === 2) await route.fulfill({ json: createDemoData() });
    else {
      await new Promise<void>((resolve) => {
        resolveDelayed = resolve;
      });
      await route.fulfill({ json: createDemoData() }).catch(() => {});
    }
  });
  await page.getByRole("button", { name: "Montpellier", exact: true }).click();
  await page
    .getByRole("button", { name: "Récupérer et construire", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Source de test indisponible" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Réessayer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Montpellier", exact: true }).click();
  await page
    .getByRole("button", { name: "Récupérer et construire", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Annuler", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Annuler", exact: true }).click();
  resolveDelayed?.();
  await expect(
    page.getByRole("button", { name: "Récupérer et construire", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeDisabled();
});

test("small screens expose settings and return to the model", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Réglages", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choisir un morceau de ville" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Essayer une démo sans réseau/ })
    .click();
  await expect(
    page.getByText("Données synthétiques · essai hors ligne", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Prêt à exporter", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Réglages", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Voir l'atelier", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Quartier de démonstration",
      exact: true,
    }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("a 300 m district exports surfaces at ground level and keeps engraving reversible", async ({
  page,
}) => {
  let collectedBbox: BBox | undefined;
  await page.route("**/api/map-data", async (route) => {
    const { bbox } = route.request().postDataJSON() as { bbox: BBox };
    collectedBbox = bbox;
    const data = enclosedDemoData(bbox);
    await route.fulfill({ json: { ...data, elevationGrid: null } });
  });
  await page.getByRole("button", { name: "Montpellier", exact: true }).click();
  await page
    .getByRole("button", { name: "Quartier de 300 m", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Récupérer et construire", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Télécharger le 3MF", exact: true }),
  ).toBeEnabled();

  const flat = await download(page, "Télécharger le 3MF");
  for (const layer of ["roads", "parks", "water", "sand"])
    for (const height of await horizontalSurfaceHeights(flat.bytes, layer))
      expect(height).toBeCloseTo(3, 4);

  const roads = page
    .locator("details.feature-card")
    .filter({ has: page.getByText("Routes et chemins", { exact: true }) });
  await roads.getByText("Routes et chemins", { exact: true }).click();
  const offset = roads.getByRole("slider", { name: "Décalage vertical" });
  await offset.press("Home");
  for (let i = 0; i < 8; i++) await offset.press("ArrowRight");
  await expect(offset).toHaveValue("-0.4");
  await expect(
    page.getByRole("button", { name: "Télécharger le 3MF", exact: true }),
  ).toBeEnabled();
  const engraved = await download(page, "Télécharger le 3MF");
  for (const height of await horizontalSurfaceHeights(engraved.bytes, "roads"))
    expect(height).toBeCloseTo(2.6, 4);

  await roads.getByRole("button", { name: /^Au niveau du terrain/ }).click();
  await expect(offset).toHaveValue("0");
  await expect(
    page.getByRole("button", { name: "Télécharger le 3MF", exact: true }),
  ).toBeEnabled();
  const restored = await download(page, "Télécharger le 3MF");
  for (const height of await horizontalSurfaceHeights(restored.bytes, "roads"))
    expect(height).toBeCloseTo(3, 4);
  const bounds = stlBounds((await download(page, "Télécharger le STL")).bytes);
  expect(Math.max(...bounds.size.slice(0, 2))).toBeCloseTo(200, 2);
  const saved = JSON.parse(
    (await download(page, "Enregistrer")).bytes.toString(),
  );
  expect(saved.snapshot.bbox).toEqual(collectedBbox);
  const district = getBboxDimensions(saved.snapshot.bbox, 1000);
  expect(Math.max(district.widthMm, district.heightMm)).toBeCloseTo(300, 1);
  for (const layer of ["roads", "parks", "water", "sand"])
    expect(saved.settings.features[layer].heightMm).toBe(0);
});

test("Peyrou preset collects relief and all park access routes, then saves its exact site", async ({
  page,
}) => {
  let request: { bbox: BBox; relief: boolean } | undefined;
  let collections = 0;
  await page.route("**/api/map-data", async (route) => {
    collections++;
    request = route.request().postDataJSON() as typeof request;
    await route.fulfill({ json: enclosedDemoData(request!.bbox) });
  });
  await page
    .getByRole("button", { name: "Peyrou · Arc et aqueduc", exact: true })
    .click();
  await expect(
    page.getByText(/Relief et allées activés pour cette sélection/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Récupérer et construire", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  expect(request?.relief).toBe(true);
  expect(request?.bbox).toEqual([43.6099, 3.8677, 43.6131, 3.8745]);

  const saved = JSON.parse(
    (await download(page, "Enregistrer")).bytes.toString(),
  );
  expect(saved.snapshot.bbox).toEqual(request?.bbox);
  expect(saved.settings.base.topographyEnabled).toBe(true);
  expect(saved.settings.features.roads.filter).toBe("all");
  expect(saved.settings.features.roads.footpathsEnabled).toBe(true);
  expect(saved.snapshot.elevationGrid.south).toBe(request?.bbox[0]);
  expect(saved.snapshot.elevationGrid.east).toBe(request?.bbox[3]);
  const bounds = stlBounds((await download(page, "Télécharger le STL")).bytes);
  expect(Math.max(...bounds.size.slice(0, 2))).toBeCloseTo(200, 2);
  expect(bounds.size[2]).toBeGreaterThan(
    saved.settings.base.basePlateThicknessMm,
  );

  // Turning fine paths off remains an explicit reversible choice; one action
  // restores the complete access network without another collection request.
  const roads = page
    .locator("details.feature-card")
    .filter({ has: page.getByText("Routes et chemins", { exact: true }) });
  await roads.getByText("Routes et chemins", { exact: true }).click();
  await roads
    .getByRole("combobox", { name: "Réseau visible" })
    .selectOption("minor");
  const allPaths = roads.getByRole("button", {
    name: "Afficher allées et escaliers",
  });
  await expect(allPaths).toHaveAttribute("aria-pressed", "false");
  await allPaths.click();
  await expect(allPaths).toHaveAttribute("aria-pressed", "true");
  await expect(
    roads.getByRole("combobox", { name: "Réseau visible" }),
  ).toHaveValue("all");
  await expect(
    page.getByRole("button", { name: "Télécharger le 3MF", exact: true }),
  ).toBeEnabled();
  const restored = JSON.parse(
    (await download(page, "Enregistrer")).bytes.toString(),
  );
  expect(restored.settings.features.roads.footpathsEnabled).toBe(true);
  expect(restored.snapshot.bbox).toEqual(request?.bbox);
  expect(collections).toBe(1);
});

for (const preset of [
  {
    name: "Saint-Étienne · centre et Parc Expo",
    bbox: [45.4288, 4.3702, 45.454, 4.406],
    plates: 4,
  },
  {
    name: "Saint-Étienne · centre, Expo et stade",
    bbox: [45.4288, 4.3702, 45.4628, 4.406],
    plates: 4,
  },
  {
    name: "Saint-Étienne · cadrage 2 plaques",
    bbox: SAINT_ETIENNE_TWO_PLATE_BBOX,
    plates: 2,
  },
  {
    name: "Saint-Étienne · toitures détaillées",
    bbox: [45.43085, 4.38145, 45.4379, 4.3945],
    plates: 4,
  },
])
  test(`${preset.name} selects its zone and exports ${preset.plates} plates below 150 mm`, async ({
    page,
  }) => {
    let request: { bbox: BBox; relief: boolean } | undefined;
    await page.route("**/api/map-data", async (route) => {
      request = route.request().postDataJSON() as typeof request;
      await route.fulfill({ json: enclosedDemoData(request!.bbox) });
    });
    await page
      .getByRole("button", {
        name: preset.name,
        exact: true,
      })
      .click();
    if (preset.bbox[2] > 45.46)
      await expect(
        page.getByText("Geoffroy-Guichard", { exact: true }),
      ).toBeInViewport();
    await expect(
      page.getByRole("spinbutton", { name: /Long côté de la pièce/ }),
    ).toHaveValue("290");
    await expect(
      page.getByRole("spinbutton", { name: "Colonnes de tuiles", exact: true }),
    ).toHaveValue(preset.plates === 2 ? "1" : "2");
    await expect(
      page.getByRole("spinbutton", { name: "Lignes de tuiles", exact: true }),
    ).toHaveValue("2");
    await expect(
      page.getByRole("button", {
        name: preset.name.includes("détaillées") ? "Détaillé" : "Équilibré",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("button", { name: "Récupérer et construire", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Télécharger le STL", exact: true }),
    ).toBeEnabled();
    expect(request?.bbox).toEqual(preset.bbox);
    expect(request?.relief).toBe(true);
    const exported = await download(page, "Télécharger le STL");
    expect(exported.name).toMatch(/tuiles\.zip$/);
    const zip = await JSZip.loadAsync(exported.bytes);
    const pieces = Object.values(zip.files).filter((file) =>
      file.name.endsWith(".stl"),
    );
    expect(pieces).toHaveLength(preset.plates);
    for (const piece of pieces) {
      const bounds = stlBounds(await piece.async("nodebuffer"));
      expect(bounds.min[2]).toBe(0);
      expect(Math.max(...bounds.size.slice(0, 2))).toBeCloseTo(145, 2);
    }
  });

test("Saint-Étienne switches between two and four 150 mm plates using the same collected city", async ({
  page,
}) => {
  let collections = 0;
  await page.route("**/api/map-data", async (route) => {
    collections++;
    const request = route.request().postDataJSON();
    expect(request.bbox).toEqual(SAINT_ETIENNE_STADIUM_BBOX);
    await route.fulfill({ json: enclosedDemoData(request.bbox) });
  });
  await page
    .getByRole("button", {
      name: "Saint-Étienne · centre, Expo et stade",
      exact: true,
    })
    .click();
  for (const count of [2, 4, 2]) {
    const layout = salonPrintLayouts(SAINT_ETIENNE_STADIUM_BBOX).find(
      (item) => item.count === count,
    )!;
    const choice = page.getByRole("button", {
      name: `${count} plaques`,
      exact: true,
    });
    await choice.click();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    if (collections === 0)
      await page
        .getByRole("button", {
          name: "Récupérer et construire",
          exact: true,
        })
        .click();
    await expect(
      page.getByRole("button", {
        name: "Télécharger le 3MF",
        exact: true,
      }),
    ).toBeEnabled();
    const saved = JSON.parse(
      (await download(page, "Enregistrer")).bytes.toString(),
    );
    expect(saved.snapshot.bbox).toEqual(SAINT_ETIENNE_STADIUM_BBOX);
    expect(saved.settings.base.grid).toEqual(layout.grid);
    expect(saved.settings.base.elevationExaggeration).toBe(1);
    expect(saved.settings.features.buildings.buildingScale).toBe(1);
    expect(saved.scale).toBeCloseTo(layout.scale, 6);
    const zip = await JSZip.loadAsync(
      (await download(page, "Télécharger le 3MF")).bytes,
    );
    const pieces = Object.values(zip.files).filter((file) =>
      file.name.endsWith(".3mf"),
    );
    expect(pieces).toHaveLength(count);
    let totalVolume = 0;
    for (const piece of pieces) {
      const child = await JSZip.loadAsync(await piece.async("nodebuffer"));
      const mesh = meshFrom3MF(
        await child.file("3D/3dmodel.model")!.async("string"),
      );
      totalVolume += assertClosedSolid(mesh);
      const bounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < mesh.positions.length; i += 3) {
        bounds[0] = Math.min(bounds[0], mesh.positions[i]);
        bounds[1] = Math.min(bounds[1], mesh.positions[i + 1]);
        bounds[2] = Math.max(bounds[2], mesh.positions[i]);
        bounds[3] = Math.max(bounds[3], mesh.positions[i + 1]);
      }
      expect(bounds[2] - bounds[0]).toBeCloseTo(layout.tileWidthMm, 3);
      expect(bounds[3] - bounds[1]).toBeCloseTo(layout.tileHeightMm, 3);
      expect(
        Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]),
      ).toBeLessThan(150);
    }
    expect(totalVolume).toBeGreaterThan(0);
    expect(collections).toBe(1);
  }
});

test("real Expo raster roofs survive the browser worker and four 3MF exports", async ({
  page,
}) => {
  const fixture = JSON.parse(
    await readFile("tests/fixtures/saint-etienne-ign-roofs.json", "utf8"),
  ) as {
    elements: OverpassElement[];
    grid: Omit<IGNRoofGrid, "mns" | "mnt"> & { mns: number[]; mnt: number[] };
  };
  const grid: IGNRoofGrid = {
    ...fixture.grid,
    mns: Float32Array.from(fixture.grid.mns),
    mnt: Float32Array.from(fixture.grid.mnt),
  };
  const elements = fixture.elements.map((element) => {
    const roof = reconstructIGNRoof(element, grid);
    expect(roof).toBeTruthy();
    return {
      ...element,
      tags: {
        ...element.tags,
        height: String(roof!.maxElevation - roof!.groundElevation),
        "printmap:roof_reconstruction": "lidar",
        "printmap:roof_resolution_m": String(grid.resolutionM),
        "printmap:roof_fit_tolerance_m": String(0.35 + 0.12 * grid.resolutionM),
      },
      roofSurfaces: roof!.surfaces,
      groundElevation: roof!.groundElevation,
      roofSource: IGN_ROOF_SOURCE,
    };
  });
  await page.route("**/api/map-data", async (route) => {
    const { bbox } = route.request().postDataJSON() as { bbox: BBox };
    const datum = Math.min(
      ...elements.map((element) => element.groundElevation),
    );
    const data: MapDataResponse = {
      osmData: { elements },
      elevationGrid: {
        rows: 2,
        cols: 2,
        points: Array(4).fill(datum),
        minElev: datum,
        maxElev: datum,
        south: bbox[0],
        west: bbox[1],
        north: bbox[2],
        east: bbox[3],
        source: "IGN69 · flat datum control for actual source roofs",
      },
      report: {
        ...createDemoData().report,
        sources: [IGN_ROOF_SOURCE],
        warnings: [],
        buildingCount: elements.length,
        elementCount: elements.length,
        lidarRoofBuildingCount: elements.length,
        lidarRoofSurfaceCount: elements.reduce(
          (sum, e) => sum + e.roofSurfaces.length,
          0,
        ),
        lidarRoofResolutionM: grid.resolutionM,
      },
    };
    await route.fulfill({ json: data });
  });
  await page
    .getByRole("button", {
      name: "Saint-Étienne · centre, Expo et stade",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Récupérer et construire", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Télécharger le 3MF", exact: true }),
  ).toBeEnabled();
  await page.locator(".quality-report > summary").click();
  await expect(
    page.getByText(/2 reconstructions depuis le LiDAR IGN/),
  ).toBeVisible();
  const exported = await JSZip.loadAsync(
    (await download(page, "Télécharger le 3MF")).bytes,
  );
  const pieces = Object.values(exported.files).filter((file) =>
    file.name.endsWith(".3mf"),
  );
  expect(pieces).toHaveLength(4);
  let buildingFaces = 0;
  for (const piece of pieces) {
    const zip = await JSZip.loadAsync(await piece.async("nodebuffer"));
    const xml = await zip.file("3D/3dmodel.model")!.async("string");
    const mesh = meshFrom3MF(xml);
    assertClosedSolid(mesh);
    buildingFaces += Array.from(mesh.faceLayers).filter(
      (layer) => layer === 1,
    ).length;
  }
  expect(buildingFaces).toBeGreaterThan(50);
});

test("terrain can be recovered after a flat collection without replacing the stairs or source date", async ({
  page,
}) => {
  const fetchedAt = "2020-07-01T10:00:00Z";
  const osmTimestamp = "2020-06-30T23:00:00Z";
  let collectionCalls = 0;
  let elevationCalls = 0;
  let collectedBbox: BBox | undefined;
  let collectedElements: OverpassElement[] = [];
  await page.route("**/api/map-data", async (route) => {
    collectionCalls++;
    const { bbox, relief } = route.request().postDataJSON() as {
      bbox: BBox;
      relief: boolean;
    };
    expect(relief).toBe(false);
    collectedBbox = bbox;
    const [south, west, north, east] = bbox;
    collectedElements = [
      {
        type: "way",
        id: 910001,
        tags: { highway: "steps", step_count: "12", width: "6", incline: "up" },
        geometry: [
          { lat: south + (north - south) * 0.35, lon: (west + east) / 2 },
          { lat: south + (north - south) * 0.45, lon: (west + east) / 2 },
        ],
      },
    ];
    const response: MapDataResponse = {
      osmData: {
        elements: collectedElements,
        osm3s: { timestamp_osm_base: osmTimestamp },
      },
      elevationGrid: null,
      report: {
        sources: ["Escalier synthétique de test"],
        warnings: [],
        fetchedAt,
        osmTimestamp,
        areaKm2: 0.09,
        elementCount: 1,
        buildingCount: 0,
        measuredBuildingCount: 0,
        ignBuildingCount: 0,
        elevationSource: null,
        elevationResolutionM: null,
        seaCoverage: "unavailable",
      },
    };
    await route.fulfill({ json: response });
  });
  await page.route("**/api/elevation", async (route) => {
    elevationCalls++;
    const { bbox } = route.request().postDataJSON() as { bbox: BBox };
    expect(bbox).toEqual(collectedBbox);
    const [south, west, north, east] = bbox;
    // Two plateaux separated by a four metre terrace; the stairway crosses
    // the incline, so its rebuilt flights must connect to the actual terrain.
    const rows = 33,
      cols = 2;
    const points = Array.from({ length: rows * cols }, (_, index) => {
      const y = Math.floor(index / cols) / (rows - 1);
      return 40 + 4 * Math.max(0, Math.min(1, (y - 0.35) / 0.1));
    });
    await route.fulfill({
      json: {
        elevationGrid: {
          south,
          west,
          north,
          east,
          rows,
          cols,
          points,
          minElev: 40,
          maxElev: 44,
          source: "Terrasse synthétique de test",
          resolutionM: 9.375,
        },
      },
    });
  });
  await page.getByRole("button", { name: "Montpellier", exact: true }).click();
  await page
    .getByRole("button", { name: "Quartier de 300 m", exact: true })
    .click();
  await page.getByRole("tab", { name: "Socle et relief", exact: true }).click();
  const reliefToggle = page.getByRole("checkbox", {
    name: "Relief du terrain",
    exact: true,
  });
  await reliefToggle.uncheck();
  await page
    .getByRole("button", { name: "Récupérer et construire", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  const flat = stlBounds((await download(page, "Télécharger le STL")).bytes);
  expect(flat.size[2]).toBeCloseTo(3, 4);

  await reliefToggle.check();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  expect(elevationCalls).toBe(1);
  expect(collectionCalls).toBe(1);
  const terrain = stlBounds((await download(page, "Télécharger le STL")).bytes);
  expect(terrain.min[2]).toBe(0);
  expect(terrain.size[2]).toBeGreaterThan(5);
  expect(Math.max(...terrain.size.slice(0, 2))).toBeCloseTo(200, 2);
  await page.getByText("Rapport du modèle", { exact: true }).click();
  await expect(
    page
      .locator("p")
      .filter({ has: page.getByText("Escaliers", { exact: true }) }),
  ).toContainText("1 volée reconstruite");
  const zip = await JSZip.loadAsync(
    (await download(page, "Télécharger le 3MF")).bytes,
  );
  const xml = await zip.file("3D/3dmodel.model")!.async("string");
  assertClosedSolid(meshFrom3MF(xml));
  expect(xml).toContain("Terrasse synthétique de test");
  const saved = JSON.parse(
    (await download(page, "Enregistrer")).bytes.toString(),
  );
  expect(saved.snapshot.bbox).toEqual(collectedBbox);
  expect(saved.snapshot.osmData.elements).toEqual(collectedElements);
  expect(saved.snapshot.osmData.osm3s.timestamp_osm_base).toBe(osmTimestamp);
  expect(saved.snapshot.report.fetchedAt).toBe(fetchedAt);
  expect(saved.snapshot.report.osmTimestamp).toBe(osmTimestamp);
  expect(saved.snapshot.report.elevationSource).toBe(
    "Terrasse synthétique de test",
  );
  expect(
    saved.snapshot.elevationGrid.maxElev - saved.snapshot.elevationGrid.minElev,
  ).toBe(4);
  expect(saved.settings.base.topographyEnabled).toBe(true);
});

test("aerial reference switching preserves the selected site and rectangle drawing on both backgrounds", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://tiles.openfreemap.org/styles/liberty", (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "test-background",
            type: "background",
            paint: { "background-color": "#dce3d3" },
          },
        ],
      },
    }),
  );
  let aerialTiles = 0;
  const aerialTile = await readFile(
    new URL("../fixtures/aerial-reference-tile.png", import.meta.url),
  );
  await page.route("https://data.geopf.fr/wmts?**", (route) => {
    aerialTiles++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("LAYER")).toBe("ORTHOIMAGERY.ORTHOPHOTOS");
    expect(url.searchParams.get("TILEMATRIXSET")).toBe("PM_0_19");
    // An isolated image fixture keeps the test independent from IGN availability.
    return route.fulfill({
      contentType: "image/png",
      body: aerialTile,
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Peyrou · Arc et aqueduc", exact: true })
    .click();
  const backgrounds = page.getByRole("group", {
    name: "Fond de carte",
    exact: true,
  });
  await backgrounds
    .getByRole("button", { name: "Photo aérienne (France)", exact: true })
    .click();
  await expect(
    backgrounds.getByRole("button", {
      name: "Photo aérienne (France)",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Référence visuelle IGN/)).toBeVisible();
  await expect.poll(() => aerialTiles).toBeGreaterThan(0);
  await expect(
    page.getByText("Dessinez un rectangle : cliquez sur deux coins opposés.", {
      exact: true,
    }),
  ).toBeVisible();
  const original = JSON.parse(
    (await download(page, "Enregistrer")).bytes.toString(),
  );
  expect(original.snapshot.bbox).toEqual([43.6099, 3.8677, 43.6131, 3.8745]);
  expect(original.snapshot.osmData).toBeNull();

  const drawRectangle = async (horizontalOffset = 0) => {
    const bounds = await page.locator(".map-canvas canvas").boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(
      bounds!.x + bounds!.width * (0.35 + horizontalOffset),
      bounds!.y + bounds!.height * 0.45,
    );
    await page.mouse.move(
      bounds!.x + bounds!.width * (0.6 + horizontalOffset),
      bounds!.y + bounds!.height * 0.7,
      { steps: 4 },
    );
    await page.mouse.click(
      bounds!.x + bounds!.width * (0.6 + horizontalOffset),
      bounds!.y + bounds!.height * 0.7,
    );
    return JSON.parse((await download(page, "Enregistrer")).bytes.toString());
  };
  const aerialSelection = await drawRectangle();
  expect(aerialSelection.snapshot.bbox).not.toEqual(original.snapshot.bbox);
  expect(aerialSelection.snapshot.bbox[2]).toBeGreaterThan(
    aerialSelection.snapshot.bbox[0],
  );
  expect(aerialSelection.snapshot.bbox[3]).toBeGreaterThan(
    aerialSelection.snapshot.bbox[1],
  );
  await backgrounds.getByRole("button", { name: "Carte", exact: true }).click();
  await expect(
    page.getByText("Dessinez un rectangle : cliquez sur deux coins opposés.", {
      exact: true,
    }),
  ).toBeVisible();
  const kept = JSON.parse(
    (await download(page, "Enregistrer")).bytes.toString(),
  );
  expect(kept.snapshot.bbox).toEqual(aerialSelection.snapshot.bbox);
  const cartographicSelection = await drawRectangle(-0.05);
  expect(cartographicSelection.snapshot.bbox).not.toEqual(
    aerialSelection.snapshot.bbox,
  );
  expect(cartographicSelection.snapshot.bbox[2]).toBeGreaterThan(
    cartographicSelection.snapshot.bbox[0],
  );
  expect(cartographicSelection.snapshot.bbox[3]).toBeGreaterThan(
    cartographicSelection.snapshot.bbox[1],
  );
  expect(cartographicSelection.snapshot.osmData).toBeNull();
  expect(errors).toEqual([]);
});

test("the real municipal Peyrou gate reaches the preview and closed 3MF export as a complete measured volume", async ({
  page,
}) => {
  const building = parseCityGMLBuilding(
    await readFile(
      new URL("../fixtures/montpellier-lod2-arc-b137169.xml", import.meta.url),
      "utf8",
    ),
  );
  expect(building).not.toBeNull();
  expect(building!.measuredSolid!.surfaces).toHaveLength(90);
  // The existing OSM envelope must be replaced: extruding it as well as the
  // real surveyed gate would fill its opening again.
  const osmGate: OverpassElement = {
    type: "way",
    id: 8656870,
    tags: {
      building: "yes",
      height: "0",
      historic: "city_gate",
      name: "Porte du Peyrou - Arc de Triomphe",
    },
    geometry: [
      { lat: 43.6112143, lon: 3.8723945 },
      { lat: 43.6112102, lon: 3.8724497 },
      { lat: 43.6111316, lon: 3.8724387 },
      { lat: 43.6110531, lon: 3.8724277 },
      { lat: 43.6110572, lon: 3.8723725 },
      { lat: 43.6111369, lon: 3.872383 },
      { lat: 43.6112143, lon: 3.8723945 },
    ],
  };
  const enriched = enrichWithMunicipalRoofs([osmGate], [building!]);
  expect(enriched.replaced).toBe(1);
  expect(enriched.elements).toHaveLength(1);
  await page.route("**/api/map-data", async (route) => {
    const { bbox, relief } = route.request().postDataJSON() as {
      bbox: BBox;
      relief: boolean;
    };
    expect(relief).toBe(true);
    const [south, west, north, east] = bbox;
    const altitude = building!.groundElevation;
    const response: MapDataResponse = {
      osmData: { elements: enriched.elements },
      elevationGrid: {
        south,
        west,
        north,
        east,
        rows: 2,
        cols: 2,
        points: Array(4).fill(altitude),
        minElev: altitude,
        maxElev: altitude,
        source: "Plan de référence constant du test",
      },
      report: {
        sources: [
          "OpenStreetMap · Overpass",
          `${MONTPELLIER_LOD2_SOURCE} · ODbL · https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier`,
        ],
        warnings: [],
        fetchedAt: "2026-10-11T12:00:00Z",
        areaKm2: 0.195,
        elementCount: 1,
        buildingCount: 1,
        measuredBuildingCount: 1,
        ignBuildingCount: 0,
        elevationSource: "Plan de référence constant du test",
        elevationResolutionM: null,
        seaCoverage: "unavailable",
        lod2BuildingCount: 1,
        lod2RoofSurfaceCount: building!.roofSurfaces.length,
        lod2SolidCount: 1,
        lod2Year: 2020,
      },
    };
    await route.fulfill({ json: response });
  });
  await page
    .getByRole("button", { name: "Peyrou · Arc et aqueduc", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Récupérer et construire", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Télécharger le 3MF", exact: true }),
  ).toBeEnabled();
  await page.getByText("Rapport du modèle", { exact: true }).click();
  await expect(
    page.locator("p").filter({
      has: page.getByText("Volumes 3D complets mesurés", { exact: true }),
    }),
  ).toContainText("1 géométrie complète");
  const exported = await JSZip.loadAsync(
    (await download(page, "Télécharger le 3MF")).bytes,
  );
  const xml = await exported.file("3D/3dmodel.model")!.async("string");
  expect(xml).toContain('unit="millimeter"');
  expect(xml).toMatch(/<metadata name="Copyright">[^<]*Montpellier/);
  expect(xml).toContain("CityGML");
  expect(xml).toContain("2020");
  assertClosedSolid(meshFrom3MF(xml));
  const saved = JSON.parse(
    (await download(page, "Enregistrer")).bytes.toString(),
  );
  expect(saved.snapshot.osmData.elements).toHaveLength(1);
  expect(
    saved.snapshot.osmData.elements[0].measuredSolid.surfaces,
  ).toHaveLength(90);
  expect(saved.snapshot.report.lod2SolidCount).toBe(1);
});
