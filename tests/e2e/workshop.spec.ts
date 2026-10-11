import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { createDemoData } from "../../src/lib/demo";

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
  await page
    .locator('input[type="file"]')
    .setInputFiles({
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
