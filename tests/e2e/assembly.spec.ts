import { test, expect, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { createLocalProjection } from "../../src/lib/projection";
import type {
  BBox,
  MapDataResponse,
  OverpassElement,
} from "../../src/types/osm";
import type { PrintMesh } from "../../src/types/print";
import { assertClosedSolid } from "../helpers/solid";

/** Synthetic buildings, with one physical terrain plane shared by every request. */
function plateData(
  bbox: BBox,
  marker = "E2E plaque synthétique",
): MapDataResponse {
  const [south, west, north, east] = bbox;
  const point = (x: number, y: number) => ({
    lon: west + x * (east - west),
    lat: south + y * (north - south),
  });
  const polygon = (
    id: number,
    tags: Record<string, string>,
    points: number[][],
  ): OverpassElement => ({
    type: "way",
    id,
    tags,
    geometry: [...points, points[0]].map(([x, y]) => point(x, y)),
  });
  const elements: OverpassElement[] = [
    polygon(81001, { building: "yes", height: "12", name: marker }, [
      [0.2, 0.2],
      [0.32, 0.2],
      [0.32, 0.35],
      [0.2, 0.35],
    ]),
    polygon(81002, { building: "yes", height: "8" }, [
      [0.65, 0.62],
      [0.78, 0.62],
      [0.78, 0.76],
      [0.65, 0.76],
    ]),
    polygon(81003, { leisure: "garden" }, [
      [0.18, 0.64],
      [0.4, 0.64],
      [0.4, 0.82],
      [0.18, 0.82],
    ]),
    {
      type: "way",
      id: 81004,
      tags: { highway: "residential", width: "7" },
      geometry: [point(0, 0.5), point(1, 0.5)],
    },
  ];
  const projection = createLocalProjection(43.6119, 3.8767);
  const elevation = (lon: number, lat: number) => {
    const [x, y] = projection.project(lon, lat);
    return 100 + x * 0.004 + y * 0.002;
  };
  const points = Array.from({ length: 9 }, (_, i) =>
    elevation(
      west + ((i % 3) / 2) * (east - west),
      south + (Math.floor(i / 3) / 2) * (north - south),
    ),
  );
  return {
    osmData: { elements },
    elevationGrid: {
      south,
      west,
      north,
      east,
      rows: 3,
      cols: 3,
      points,
      minElev: Math.min(...points),
      maxElev: Math.max(...points),
      source:
        "E2E · plan synthétique en coordonnées mondiales, altitude en mètres",
      resolutionM: 30,
    },
    report: {
      sources: [marker],
      warnings: ["Données synthétiques de test, aucun relevé réel."],
      fetchedAt: "2026-10-15T12:00:00.000Z",
      areaKm2: 0.525625,
      elementCount: elements.length,
      buildingCount: 2,
      measuredBuildingCount: 0,
      ignBuildingCount: 0,
      elevationSource: "E2E · plan synthétique mondial",
      elevationResolutionM: 30,
      seaCoverage: "available",
    },
  };
}

async function download(page: Page, name: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  const item = await pending,
    path = await item.path();
  expect(path).toBeTruthy();
  return { bytes: await readFile(path!), name: item.suggestedFilename() };
}

function stlMesh(bytes: Buffer): PrintMesh {
  const count = bytes.readUInt32LE(80);
  expect(bytes.length).toBe(84 + count * 50);
  const positions = new Float32Array(count * 9),
    indices = new Uint32Array(count * 3);
  for (let face = 0; face < count; face++)
    for (let vertex = 0; vertex < 3; vertex++) {
      const at = face * 9 + vertex * 3;
      for (let axis = 0; axis < 3; axis++)
        positions[at + axis] = bytes.readFloatLE(
          84 + face * 50 + 12 + vertex * 12 + axis * 4,
        );
      indices[face * 3 + vertex] = face * 3 + vertex;
    }
  return { positions, indices, faceLayers: new Uint8Array(count) };
}

async function threeMfMesh(bytes: Buffer): Promise<PrintMesh> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file("3D/3dmodel.model");
  expect(file).toBeTruthy();
  const xml = await file!.async("string");
  const attrs = (text: string) =>
    Object.fromEntries(
      [...text.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [m[1], Number(m[2])]),
    );
  const vertices = [...xml.matchAll(/<vertex\s+([^>]+)\/>/g)].flatMap((m) => {
    const a = attrs(m[1]);
    return [a.x, a.y, a.z];
  });
  const faces = [...xml.matchAll(/<triangle\s+([^>]+)\/>/g)].map((m) =>
    attrs(m[1]),
  );
  return {
    positions: new Float32Array(vertices),
    indices: new Uint32Array(faces.flatMap((a) => [a.v1, a.v2, a.v3])),
    faceLayers: new Uint8Array(faces.map((a) => a.p1)),
  };
}

function assert145mm(mesh: PrintMesh) {
  assertClosedSolid(mesh);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], mesh.positions[i + axis]);
      max[axis] = Math.max(max[axis], mesh.positions[i + axis]);
    }
  expect(max[0] - min[0]).toBeCloseTo(145, 2);
  expect(max[1] - min[1]).toBeCloseTo(145, 2);
  expect(min[2]).toBe(0);
  expect(max[2]).toBeGreaterThan(3);
}

async function openFile(page: Page, bytes: Buffer, name: string) {
  const pending = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Ouvrir un projet", exact: true })
    .click();
  await (
    await pending
  ).setFiles({ name, mimeType: "application/json", buffer: bytes });
}

async function createAssembly(page: Page) {
  await page
    .getByRole("group", { name: "Raccourcis de villes" })
    .getByRole("button", { name: "Montpellier", exact: true })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "Échelle du projet", exact: true }),
  ).toHaveValue("5000");
  await page
    .getByRole("button", { name: "Créer un projet par plaques", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Plaque 0, 0", exact: true }),
  ).toBeVisible();
}

function bboxFrom(route: Route): BBox {
  const body = route.request().postDataJSON();
  expect(body).toHaveProperty("bbox");
  expect(body.bbox).toHaveLength(4);
  return body.bbox as BBox;
}

test.beforeEach(async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.route("https://data.geopf.fr/**", (route) => route.abort());
  await page.goto("/");
});

interface Manifest {
  kind: "assembly-project";
  version: 1;
  project: {
    version: 1;
    id: string;
    name: string;
    origin: { lat: number; lng: number };
    scale: number;
    plateSizeMm: number;
    usableMm: number;
    cells: Array<{ col: number; row: number }>;
    activeCell: { col: number; row: number } | null;
    elevationDatumM: number | null;
    settings: unknown;
    boundaryElevations: Record<string, number>;
  };
}
async function manifest(page: Page) {
  const file = await download(page, "Enregistrer");
  const content = JSON.parse(file.bytes.toString()) as Manifest;
  expect(content.kind).toBe("assembly-project");
  expect(content.version).toBe(1);
  expect(content.project.version).toBe(1);
  expect(content.project.plateSizeMm).toBe(150);
  expect(content.project.usableMm).toBe(145);
  expect(content.project.scale).toBe(5000);
  expect(content).not.toHaveProperty("snapshot");
  expect(content.project).not.toHaveProperty("osmData");
  return { ...file, content };
}
async function ready(page: Page) {
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText(
      "Plaque prête. Vous pouvez l’exporter ou en choisir une autre.",
      { exact: true },
    ),
  ).toBeVisible();
}
async function loadPlate(page: Page, cached = false) {
  await page
    .getByRole("button", {
      name: cached
        ? "Construire cette plaque"
        : "Charger et construire cette plaque",
      exact: true,
    })
    .click();
  await ready(page);
}

test("progressive five-building refinement shows the base, preserves completed batches and resumes after reload", async ({
  page,
}) => {
  const ids = [82001, 82002, 82003, 82004, 82005];
  const source = "E2E · toiture LiDAR synthétique, aucun relevé réel";
  let collections = 0;
  let phase: "hold" | "save-then-outage" | "finish" = "hold";
  let releaseInitial!: () => void;
  let settleInitial!: () => void;
  const initialSettled = new Promise<void>((resolve) => {
    settleInitial = resolve;
  });
  const batches: number[][] = [];
  const requests: Array<{ completed: number; terrain: string }> = [];
  let active = 0,
    maximumActive = 0;
  const refinedIds = (data: MapDataResponse) =>
    data.osmData.elements
      .filter(
        (element) => element.tags?.["printmap:roof_refinement"] === "landmark",
      )
      .map((element) => element.id);
  const nextBatch = (previous: MapDataResponse) => {
    const data = structuredClone(previous);
    const selected = ids
      .filter((id) => !refinedIds(data).includes(id))
      .slice(0, 2);
    for (const element of data.osmData.elements) {
      if (!selected.includes(element.id)) continue;
      const height = Number(element.tags!.height);
      element.groundElevation = 100;
      element.roofSurfaces = [
        {
          outer: element.geometry!.map((point) => ({
            ...point,
            elevation: 100 + height,
          })),
          holes: [],
        },
      ];
      element.roofSource = source;
      element.tags = {
        ...element.tags,
        "printmap:roof_reconstruction": "lidar",
        "printmap:roof_refinement": "landmark",
        "printmap:roof_resolution_m": "1",
        "printmap:height_source": source,
      };
    }
    const completed = refinedIds(data).length;
    data.report.sources = [...new Set([...data.report.sources, source])];
    data.report.landmarkRoofBuildingCount = completed;
    data.report.lidarRoofBuildingCount = completed;
    data.report.lidarRoofSurfaceCount = completed;
    data.report.lidarRoofResolutionM = 1;
    data.report.lidarRoofMinResolutionM = 1;
    data.report.landmarkRefinement = {
      version: 1,
      updatedAt: "2026-10-16T13:00:00.000Z",
      completed,
      remaining: ids.length - completed,
      failed: 0,
      limited: 0,
      attempts: [],
    };
    return { data, selected };
  };
  await page.route("**/api/map-data", async (route) => {
    collections++;
    const bbox = bboxFrom(route);
    const data = plateData(bbox, "Cinq édifices synthétiques");
    data.osmData.elements = data.osmData.elements.filter(
      (element) => !element.tags?.building,
    );
    const starts = [
      [0.12, 0.15],
      [0.43, 0.15],
      [0.73, 0.15],
      [0.43, 0.68],
      [0.73, 0.68],
    ];
    for (const [index, id] of ids.entries()) {
      const [x, y] = starts[index];
      data.osmData.elements.push({
        type: "way",
        id,
        tags: {
          building: "church",
          name: `Édifice synthétique ${index + 1}`,
          height: String(12 + index * 2),
        },
        geometry: [
          [x, y],
          [x + 0.1, y],
          [x + 0.1, y + 0.12],
          [x, y + 0.12],
          [x, y],
        ].map(([u, v]) => ({
          lon: bbox[1] + u * (bbox[3] - bbox[1]),
          lat: bbox[0] + v * (bbox[2] - bbox[0]),
        })),
      });
    }
    data.report.buildingCount = ids.length;
    data.report.elementCount = data.osmData.elements.length;
    data.report.landmarkRefinement = {
      version: 1,
      updatedAt: data.report.fetchedAt,
      completed: 0,
      remaining: ids.length,
      failed: 0,
      limited: 0,
      attempts: [],
    };
    await route.fulfill({ json: data });
  });
  await page.route("**/api/refine-buildings", async (route) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      const { data } = route.request().postDataJSON() as {
        data: MapDataResponse;
      };
      requests.push({
        completed: refinedIds(data).length,
        terrain: JSON.stringify(data.elevationGrid),
      });
      if (phase === "hold") {
        await new Promise<void>((resolve) => {
          releaseInitial = resolve;
        });
        await route
          .fulfill({ json: nextBatch(data).data })
          .catch(() => undefined);
        settleInitial();
        return;
      }
      if (phase === "save-then-outage" && batches.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "Détails synthétiques temporairement indisponibles" },
        });
        return;
      }
      const next = nextBatch(data);
      batches.push(next.selected);
      await route.fulfill({ json: next.data });
    } finally {
      active--;
    }
  });

  await createAssembly(page);
  await page
    .getByRole("button", {
      name: "Charger et construire cette plaque",
      exact: true,
    })
    .click();
  await expect.poll(() => requests.length).toBe(1);
  // The first optional network batch is suspended, yet the real worker has
  // already built a base whose report and scene are visible.
  await expect(page.locator(".scene-view canvas")).toBeVisible();
  await expect(page.locator(".quality-report summary")).toContainText(
    "5 bâtiments",
  );
  await page.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  releaseInitial();
  await initialSettled;
  assert145mm(stlMesh((await download(page, "Télécharger le STL")).bytes));
  const baseline = (await manifest(page)).content.project;
  const baseData = JSON.parse(
    (
      await download(page, "Enregistrer les données de cette plaque")
    ).bytes.toString(),
  ).data as MapDataResponse;
  expect(refinedIds(baseData)).toEqual([]);
  expect(baseData.report.landmarkRefinement?.remaining).toBe(5);

  const refine = page.getByRole("button", {
    name: "Affiner les édifices remarquables",
    exact: true,
  });
  phase = "save-then-outage";
  await refine.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Détails synthétiques temporairement indisponibles" }),
  ).toBeVisible();
  await expect(refine).toBeEnabled();
  const partial = JSON.parse(
    (
      await download(page, "Enregistrer les données de cette plaque")
    ).bytes.toString(),
  ).data as MapDataResponse;
  expect(refinedIds(partial)).toEqual(ids.slice(0, 2));
  expect(partial.report.landmarkRefinement).toMatchObject({
    completed: 2,
    remaining: 3,
  });
  expect(partial.elevationGrid).toEqual(baseData.elevationGrid);
  expect(partial.report.fetchedAt).toBe(baseData.report.fetchedAt);
  expect((await manifest(page)).content.project).toEqual(baseline);

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Construire cette plaque", exact: true }),
  ).toBeEnabled();
  const restored = JSON.parse(
    (
      await download(page, "Enregistrer les données de cette plaque")
    ).bytes.toString(),
  ).data as MapDataResponse;
  expect(restored).toEqual(partial);
  await loadPlate(page, true);
  expect(collections).toBe(1);
  expect(requests).toHaveLength(3);
  phase = "finish";
  await refine.click();
  await expect.poll(() => batches.length).toBe(3);
  await expect(refine).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  const finished = JSON.parse(
    (
      await download(page, "Enregistrer les données de cette plaque")
    ).bytes.toString(),
  ).data as MapDataResponse;
  expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
  expect(batches.flat()).toEqual(ids);
  expect(requests.map((request) => request.completed)).toEqual([0, 0, 2, 2, 4]);
  expect(maximumActive).toBe(1);
  expect(collections).toBe(1);
  expect(finished.report.landmarkRefinement).toMatchObject({
    completed: 5,
    remaining: 0,
    failed: 0,
    limited: 0,
  });
  expect(finished.elevationGrid).toEqual(baseData.elevationGrid);
  expect(
    requests.every(
      (request) => request.terrain === JSON.stringify(baseData.elevationGrid),
    ),
  ).toBe(true);
  expect((await manifest(page)).content.project).toEqual(baseline);
  await expect(page.locator(".quality-report summary")).toContainText(
    "5 LiDAR",
  );
  assert145mm(stlMesh((await download(page, "Télécharger le STL")).bytes));
});

test("refreshing one cached plate preserves the last data on network failure, then updates sources without moving the assembly", async ({
  page,
}) => {
  let calls = 0;
  let phase: "initial" | "pending" | "storage" | "failure" | "fresh" =
    "initial";
  let release: (() => void) | undefined;
  await page.route("**/api/map-data", async (route) => {
    calls++;
    const bbox = bboxFrom(route);
    if (phase === "pending") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route
        .fulfill({ json: plateData(bbox, "Résultat annulé") })
        .catch(() => undefined);
      return;
    }
    if (phase === "failure") {
      await route.fulfill({
        status: 503,
        json: { error: "Source temporairement indisponible" },
      });
      return;
    }
    const data = plateData(
      bbox,
      phase === "fresh" ? "Église actualisée" : "Anciennes données",
    );
    if (phase === "fresh") {
      data.osmData.elements[0].tags!.building = "church";
      data.osmData.elements[0].tags!.height = "24";
      data.report.fetchedAt = "2026-10-16T12:00:00.000Z";
    }
    if (phase === "storage") data.report.fetchedAt = "2026-10-16T13:00:00.000Z";
    await route.fulfill({ json: data });
  });
  await createAssembly(page);
  await loadPlate(page);
  const before = (await manifest(page)).content.project;
  const oldBackup = JSON.parse(
    (
      await download(page, "Enregistrer les données de cette plaque")
    ).bytes.toString(),
  );
  phase = "pending";
  await page
    .getByRole("button", {
      name: "Actualiser les données de cette plaque",
      exact: true,
    })
    .click();
  await expect.poll(() => calls).toBe(2);
  await page.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  release!();
  // Keep a genuine write transaction active until the visible Cancel action
  // aborts it. A late promise guard alone cannot roll an IndexedDB write back.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.put = function (value, key) {
      const request =
        key === undefined ? put.call(this, value) : put.call(this, value, key);
      if (value?.data?.report?.fetchedAt === "2026-10-16T13:00:00.000Z") {
        document.documentElement.dataset.plateSavePending = "true";
        let holding = true;
        setTimeout(() => {
          holding = false;
        }, 5000);
        const keepAlive = () => {
          if (!holding) return;
          try {
            get.call(this, [value.projectId, value.col, value.row]).onsuccess =
              keepAlive;
          } catch {
            /* aborted */
          }
        };
        keepAlive();
      }
      return request;
    };
  });
  phase = "storage";
  await page
    .getByRole("button", {
      name: "Actualiser les données de cette plaque",
      exact: true,
    })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-plate-save-pending",
    "true",
  );
  await page.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  const cancelledWriteBackup = JSON.parse(
    (
      await download(page, "Enregistrer les données de cette plaque")
    ).bytes.toString(),
  );
  expect(cancelledWriteBackup.data).toEqual(oldBackup.data);
  phase = "failure";
  await page
    .getByRole("button", {
      name: "Actualiser les données de cette plaque",
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Source temporairement indisponible" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeEnabled();
  const failedBackup = JSON.parse(
    (
      await download(page, "Enregistrer les données de cette plaque")
    ).bytes.toString(),
  );
  expect(failedBackup.data).toEqual(oldBackup.data);
  phase = "fresh";
  await page
    .getByRole("button", {
      name: "Actualiser les données de cette plaque",
      exact: true,
    })
    .click();
  await ready(page);
  expect(calls).toBe(5);
  const after = (await manifest(page)).content.project;
  expect(after.origin).toEqual(before.origin);
  expect(after.scale).toBe(before.scale);
  expect(after.elevationDatumM).toBe(before.elevationDatumM);
  expect(after.boundaryElevations).toEqual(before.boundaryElevations);
  const freshBackup = JSON.parse(
    (
      await download(page, "Enregistrer les données de cette plaque")
    ).bytes.toString(),
  );
  expect(freshBackup.data.osmData.elements[0].tags.name).toBe(
    "Église actualisée",
  );
  await expect(
    page.getByRole("combobox", { name: "Voir un monument", exact: true }),
  ).toContainText("Église actualisée");
  assert145mm(stlMesh((await download(page, "Télécharger le STL")).bytes));
  await loadPlate(page, true);
  expect(calls).toBe(5);
});
function borderHeight(
  mesh: PrintMesh,
  side: "west" | "east",
  fraction: number,
) {
  const xs = Array.from(mesh.positions).filter((_, i) => i % 3 === 0);
  const target = side === "west" ? Math.min(...xs) : Math.max(...xs);
  const points = new Map<number, number>();
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const [a, b, c] = Array.from(mesh.indices.slice(at, at + 3));
    const p = mesh.positions;
    const nz =
      (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) -
      (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3] - p[a * 3]);
    if (nz <= 1e-8) continue;
    for (const index of [a, b, c])
      if (Math.abs(p[index * 3] - target) < 1e-5) {
        const y = p[index * 3 + 1],
          z = p[index * 3 + 2];
        points.set(y, Math.max(points.get(y) ?? -Infinity, z));
      }
  }
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  expect(sorted.length).toBeGreaterThan(1);
  const y = sorted[0][0] + fraction * (sorted.at(-1)![0] - sorted[0][0]);
  for (let i = 1; i < sorted.length; i++)
    if (y <= sorted[i][0]) {
      const a = sorted[i - 1],
        b = sorted[i],
        t = (y - a[0]) / (b[0] - a[0]);
      return a[1] + t * (b[1] - a[1]);
    }
  throw new Error("Missing exported terrain boundary");
}

test("an extensible project fetches only selected 145mm plates, preserves old coordinates and reconstructs cached data after reload", async ({
  page,
}) => {
  const requests: BBox[] = [],
    elevationRequests: BBox[] = [];
  await page.route("**/api/map-data", async (route) => {
    const bbox = bboxFrom(route);
    requests.push(bbox);
    expect(route.request().postDataJSON().relief).toBe(true);
    await route.fulfill({ json: plateData(bbox) });
  });
  await page.route("**/api/elevation", async (route) => {
    const bbox = bboxFrom(route);
    elevationRequests.push(bbox);
    await route.fulfill({
      json: { elevationGrid: plateData(bbox).elevationGrid },
    });
  });
  await createAssembly(page);
  const initial = (await manifest(page)).content.project;
  expect(initial.cells).toContainEqual({ col: 0, row: 0 });
  expect(initial.cells).toContainEqual({ col: 1, row: 0 });
  expect(requests).toHaveLength(0);
  expect(elevationRequests).toHaveLength(0);

  await page.getByRole("button", { name: "Plaque 0, 0", exact: true }).click();
  await loadPlate(page);
  expect(requests).toHaveLength(1);
  const first = stlMesh((await download(page, "Télécharger le STL")).bytes);
  assert145mm(first);
  assert145mm(
    await threeMfMesh((await download(page, "Télécharger le 3MF")).bytes),
  );

  await page.getByRole("button", { name: "Plaque 1, 0", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeDisabled();
  expect(requests).toHaveLength(1);
  await loadPlate(page);
  expect(requests).toHaveLength(2);
  const second = stlMesh((await download(page, "Télécharger le STL")).bytes);
  assert145mm(second);
  expect(requests[1][0]).toBeCloseTo(requests[0][0], 9);
  expect(requests[1][2]).toBeCloseTo(requests[0][2], 9);
  expect(requests[1][1]).toBeCloseTo(requests[0][3], 9);
  const world = createLocalProjection(initial.origin.lat, initial.origin.lng);
  for (const bbox of requests) {
    const a = world.project(bbox[1], bbox[0]),
      b = world.project(bbox[3], bbox[2]);
    expect(b[0] - a[0]).toBeCloseTo(725, 5);
    expect(b[1] - a[1]).toBeCloseTo(725, 5);
  }
  for (const fraction of [0.25, 0.75])
    expect(borderHeight(first, "east", fraction)).toBeCloseTo(
      borderHeight(second, "west", fraction),
      4,
    );

  await page.getByRole("button", { name: /Ajouter à droite$/ }).click();
  await expect(
    page.getByRole("button", { name: "Plaque 2, 0", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Plaque 0, 0", exact: true }).click();
  await page.getByRole("button", { name: /Ajouter à gauche$/ }).click();
  await expect(
    page.getByRole("button", { name: "Plaque -1, 0", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const extended = (await manifest(page)).content.project;
  expect(extended.id).toBe(initial.id);
  expect(extended.origin).toEqual(initial.origin);
  expect(extended.scale).toBe(initial.scale);
  expect(extended.usableMm).toBe(initial.usableMm);
  expect(extended.settings).toEqual(initial.settings);
  expect(extended.cells).toHaveLength(initial.cells.length + 2);
  for (const cell of initial.cells) expect(extended.cells).toContainEqual(cell);
  expect(requests).toHaveLength(2);

  await page.getByRole("button", { name: "Plaque 1, 0", exact: true }).click();
  const beforeReload = (await manifest(page)).content.project;
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Plaque 1, 0", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Construire cette plaque", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeDisabled();
  expect(requests).toHaveLength(2);
  expect(elevationRequests).toHaveLength(0);
  expect((await manifest(page)).content.project).toEqual(beforeReload);
  await loadPlate(page, true);
  expect(requests).toHaveLength(2);
  const restored = stlMesh((await download(page, "Télécharger le STL")).bytes);
  assert145mm(restored);
  expect(assertClosedSolid(restored)).toBeCloseTo(assertClosedSolid(second), 3);
});

test("cancelling a plate and selecting its neighbor rejects the delayed result and does not cache the cancelled plate", async ({
  page,
}) => {
  const requests: BBox[] = [];
  let release!: () => void,
    held = false,
    settled = false;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/map-data", async (route) => {
    const bbox = bboxFrom(route),
      number = requests.push(bbox);
    if (number === 1) {
      held = true;
      await delayed;
      // A deliberately cancelled browser request may reject fulfillment.
      // The visible current backup and uncached old tile below are the verdict.
      try {
        await route.fulfill({
          json: plateData(bbox, "E2E STALE PLATE RESPONSE"),
        });
      } catch {}
      settled = true;
    } else
      await route.fulfill({
        json: plateData(bbox, "E2E CURRENT PLATE RESPONSE"),
      });
  });
  await createAssembly(page);
  try {
    await page
      .getByRole("button", {
        name: "Charger et construire cette plaque",
        exact: true,
      })
      .click();
    await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "Annuler", exact: true }).click();
    await page
      .getByRole("button", { name: "Plaque 1, 0", exact: true })
      .click();
    await loadPlate(page);
    release();
    await expect.poll(() => settled).toBe(true);
    expect(requests).toHaveLength(2);
    const saved = JSON.parse(
      (
        await download(page, "Enregistrer les données de cette plaque")
      ).bytes.toString(),
    );
    expect(saved.kind).toBe("assembly-cell");
    expect(saved.cell).toEqual({ col: 1, row: 0 });
    expect(saved.data.report.sources).toContain("E2E CURRENT PLATE RESPONSE");
    expect(JSON.stringify(saved.data)).not.toContain(
      "E2E STALE PLATE RESPONSE",
    );
    expect([
      saved.data.elevationGrid.south,
      saved.data.elevationGrid.west,
      saved.data.elevationGrid.north,
      saved.data.elevationGrid.east,
    ]).toEqual(requests[1]);
    await page
      .getByRole("button", { name: "Plaque 0, 0", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Charger et construire cette plaque",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", {
        name: "Enregistrer les données de cette plaque",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Télécharger le STL", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
});

test("saved metadata and one plate backup restore in a fresh browser without collecting or rebuilding on open", async ({
  page,
  browser,
  baseURL,
}) => {
  let collections = 0;
  await page.route("**/api/map-data", async (route) => {
    collections++;
    await route.fulfill({
      json: plateData(bboxFrom(route), "E2E PORTABLE PLATE"),
    });
  });
  await createAssembly(page);
  await loadPlate(page);
  expect(collections).toBe(1);
  const metadata = await manifest(page);
  const backup = await download(
    page,
    "Enregistrer les données de cette plaque",
  );
  const content = JSON.parse(backup.bytes.toString());
  expect(content.kind).toBe("assembly-cell");
  expect(content.version).toBe(1);
  expect(content.project).toEqual(metadata.content.project);
  expect(content.cell).toEqual({ col: 0, row: 0 });
  expect(content.data.report.sources).toContain("E2E PORTABLE PLATE");

  await page
    .getByRole("button", { name: "Fermer le projet par plaques", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Reprendre le dernier projet",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reprendre le dernier projet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Construire cette plaque", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Télécharger le STL", exact: true }),
  ).toBeDisabled();
  expect(collections).toBe(1);

  const context = await browser.newContext({ baseURL });
  const other = await context.newPage();
  let unexpectedCollections = 0;
  try {
    await other.route("https://tiles.openfreemap.org/**", (route) =>
      route.abort(),
    );
    await other.route("**/api/map-data", async (route) => {
      unexpectedCollections++;
      await route.fulfill({ json: plateData(bboxFrom(route)) });
    });
    await other.goto("/");
    await openFile(other, metadata.bytes, metadata.name);
    await expect(
      other.getByRole("button", { name: "Plaque 0, 0", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      other.getByRole("button", {
        name: "Charger et construire cette plaque",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      other.getByRole("button", { name: "Télécharger le STL", exact: true }),
    ).toBeDisabled();
    expect(unexpectedCollections).toBe(0);
    expect((await manifest(other)).content.project).toEqual(
      metadata.content.project,
    );
    await openFile(other, backup.bytes, backup.name);
    await expect(
      other.getByRole("button", {
        name: "Construire cette plaque",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      other.getByRole("button", { name: "Télécharger le STL", exact: true }),
    ).toBeDisabled();
    expect(unexpectedCollections).toBe(0);
    await loadPlate(other, true);
    expect(unexpectedCollections).toBe(0);
    assert145mm(
      await threeMfMesh((await download(other, "Télécharger le 3MF")).bytes),
    );
    const restored = JSON.parse(
      (
        await download(other, "Enregistrer les données de cette plaque")
      ).bytes.toString(),
    );
    expect(restored.data.report.sources).toContain("E2E PORTABLE PLATE");
    expect(restored.project.id).toBe(metadata.content.project.id);
  } finally {
    await context.close();
  }
});

test("blocked IndexedDB still allows a 145mm print and a portable plate backup that rebuilds without another collection", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, "open", {
      configurable: true,
      value() {
        throw new DOMException(
          "E2E: IndexedDB unavailable in this browser context",
          "SecurityError",
        );
      },
    });
  });
  const page = await context.newPage();
  let collections = 0,
    elevationRequests = 0;
  try {
    await page.route("https://tiles.openfreemap.org/**", (route) =>
      route.abort(),
    );
    await page.route("**/api/map-data", async (route) => {
      collections++;
      await route.fulfill({
        json: plateData(bboxFrom(route), "E2E PLATE WITHOUT INDEXEDDB"),
      });
    });
    await page.route("**/api/elevation", async (route) => {
      elevationRequests++;
      await route.fulfill({
        json: { elevationGrid: plateData(bboxFrom(route)).elevationGrid },
      });
    });
    await page.goto("/");
    await createAssembly(page);
    await expect(
      page.getByText(
        "Le stockage local est indisponible. Les données de chaque plaque devront être enregistrées dans un fichier.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(collections).toBe(0);
    await page
      .getByRole("button", {
        name: "Charger et construire cette plaque",
        exact: true,
      })
      .click();
    const readyWithoutStorage = async () => {
      await expect(
        page.getByRole("button", {
          name: "Télécharger le STL",
          exact: true,
        }),
      ).toBeEnabled();
      await expect(
        page.getByText(
          "Plaque prête. Stockage local indisponible : enregistrez les données de cette plaque avant d’en changer.",
          { exact: true },
        ),
      ).toBeVisible();
    };
    await readyWithoutStorage();
    expect(collections).toBe(1);
    expect(elevationRequests).toBe(0);
    const initial = stlMesh((await download(page, "Télécharger le STL")).bytes);
    assert145mm(initial);
    assert145mm(
      await threeMfMesh((await download(page, "Télécharger le 3MF")).bytes),
    );
    const metadata = await manifest(page);
    const backup = await download(
      page,
      "Enregistrer les données de cette plaque",
    );
    const saved = JSON.parse(backup.bytes.toString());
    expect(saved.kind).toBe("assembly-cell");
    expect(saved.project.id).toBe(metadata.content.project.id);
    expect(saved.cell).toEqual({ col: 0, row: 0 });
    expect(saved.data.report.sources).toContain("E2E PLATE WITHOUT INDEXEDDB");

    // Only the small plan survives reload. The deliberately blocked database
    // and discarded transient must not pretend that the acquired data remains.
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Plaque 0, 0", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", {
        name: "Charger et construire cette plaque",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", {
        name: "Enregistrer les données de cette plaque",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Télécharger le STL", exact: true }),
    ).toBeDisabled();
    expect(collections).toBe(1);
    await openFile(page, backup.bytes, backup.name);
    await expect(
      page.getByText(
        "Données restaurées en mémoire. Le stockage local est indisponible : conservez votre fichier de plaque.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Construire cette plaque",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Télécharger le STL", exact: true }),
    ).toBeDisabled();
    expect(collections).toBe(1);
    await page
      .getByRole("button", { name: "Construire cette plaque", exact: true })
      .click();
    await readyWithoutStorage();
    expect(collections).toBe(1);
    expect(elevationRequests).toBe(0);
    const restored = stlMesh(
      (await download(page, "Télécharger le STL")).bytes,
    );
    assert145mm(restored);
    expect(assertClosedSolid(restored)).toBeCloseTo(
      assertClosedSolid(initial),
      3,
    );
    assert145mm(
      await threeMfMesh((await download(page, "Télécharger le 3MF")).bytes),
    );
    const secondBackup = JSON.parse(
      (
        await download(page, "Enregistrer les données de cette plaque")
      ).bytes.toString(),
    );
    expect(secondBackup.project.id).toBe(saved.project.id);
    expect(secondBackup.data.report.sources).toContain(
      "E2E PLATE WITHOUT INDEXEDDB",
    );
  } finally {
    await context.close();
  }
});

test("a plate import finishing after another plate is selected cannot reopen the old plate", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      IDBTransaction.prototype,
      "oncomplete",
    )!;
    let armed = false;
    let release: (() => void) | null = null;
    window.addEventListener("e2e-arm-import-write", () => {
      armed = true;
    });
    window.addEventListener("e2e-release-import-write", () => {
      release?.();
      release = null;
    });
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      configurable: true,
      get(this: IDBTransaction) {
        return descriptor.get!.call(this);
      },
      set(
        this: IDBTransaction,
        callback: ((this: IDBTransaction, event: Event) => unknown) | null,
      ) {
        if (!armed || this.mode !== "readwrite" || !callback) {
          descriptor.set!.call(this, callback);
          return;
        }
        armed = false;
        // The real IndexedDB write commits normally. Delay only the completion
        // callback awaited by the app, reproducing an import racing selection.
        descriptor.set!.call(
          this,
          function (this: IDBTransaction, event: Event) {
            release = () => callback.call(this, event);
            document.documentElement.setAttribute(
              "data-e2e-import-held",
              "true",
            );
          },
        );
      },
    });
  });
  const page = await context.newPage();
  let collections = 0;
  try {
    await page.route("https://tiles.openfreemap.org/**", (route) =>
      route.abort(),
    );
    await page.route("**/api/map-data", async (route) => {
      collections++;
      await route.fulfill({
        json: plateData(bboxFrom(route), "E2E IMPORT RACE SOURCE"),
      });
    });
    await page.goto("/");
    await createAssembly(page);
    await loadPlate(page);
    const backup = await download(
      page,
      "Enregistrer les données de cette plaque",
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("e2e-arm-import-write"));
    });
    await openFile(page, backup.bytes, backup.name);
    await expect(page.locator("html")).toHaveAttribute(
      "data-e2e-import-held",
      "true",
    );
    await page
      .getByRole("button", { name: "Plaque 1, 0", exact: true })
      .click();
    const selected = (await manifest(page)).content.project;
    expect(selected.activeCell).toEqual({ col: 1, row: 0 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event("e2e-release-import-write"));
    });
    // ProjectManager resolves its import handler only after the delayed write.
    await expect(
      page.getByText("Données de cette plaque restaurées sans collecte.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Plaque 1, 0", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Plaque 0, 0", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.getByRole("button", {
        name: "Charger et construire cette plaque",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Télécharger le STL", exact: true }),
    ).toBeDisabled();
    expect((await manifest(page)).content.project).toEqual(selected);
    expect(collections).toBe(1);
  } finally {
    await context.close();
  }
});

test("a readable but full localStorage keeps the plan usable and its downloaded manifest restores without an uncaught error", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    // Existing storage remains readable: quota exhaustion differs from a
    // browser denying access to the entire Storage object.
    Storage.prototype.setItem.call(
      localStorage,
      "e2e-readable-storage",
      "readable",
    );
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value() {
        throw new DOMException(
          "E2E: localStorage quota exhausted",
          "QuotaExceededError",
        );
      },
    });
  });
  const page = await context.newPage();
  const uncaught: string[] = [];
  let collections = 0;
  page.on("pageerror", (error) => uncaught.push(error.message));
  try {
    await page.route("https://tiles.openfreemap.org/**", (route) =>
      route.abort(),
    );
    await page.route("**/api/map-data", async (route) => {
      collections++;
      await route.fulfill({ json: plateData(bboxFrom(route)) });
    });
    await page.goto("/");
    expect(
      await page.evaluate(() => localStorage.getItem("e2e-readable-storage")),
    ).toBe("readable");
    await createAssembly(page);
    const memoryWarning = page.getByText(
      /^Le plan reste en mémoire : le stockage du navigateur est indisponible\./,
    );
    await expect(memoryWarning).toBeVisible();
    await page
      .getByRole("button", { name: "Plaque 1, 0", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Plaque 1, 0", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /Ajouter à droite$/ }).click();
    await expect(
      page.getByRole("button", { name: "Plaque 2, 0", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(memoryWarning).toBeVisible();
    const saved = await manifest(page);
    expect(saved.content.project.activeCell).toEqual({ col: 2, row: 0 });
    expect(saved.content.project.cells).toContainEqual({ col: 2, row: 0 });
    expect(collections).toBe(0);
    expect(uncaught).toEqual([]);

    await page
      .getByRole("button", {
        name: "Fermer le projet par plaques",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Reprendre le dernier projet",
        exact: true,
      }),
    ).toBeVisible();
    // Because writes failed, reload must not falsely recover an unsaved plan.
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Plaque 2, 0", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.getItem("e2e-readable-storage")),
    ).toBe("readable");
    await openFile(page, saved.bytes, saved.name);
    await expect(
      page.getByRole("button", { name: "Plaque 2, 0", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(memoryWarning).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Charger et construire cette plaque",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Télécharger le STL", exact: true }),
    ).toBeDisabled();
    expect((await manifest(page)).content.project).toEqual(
      saved.content.project,
    );
    expect(collections).toBe(0);
    expect(uncaught).toEqual([]);
  } finally {
    await context.close();
  }
});
