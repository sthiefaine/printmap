import JSZip from "jszip";
import type { PrintMesh, PrintModel } from "@/types/print";
import { PRINT_LAYERS } from "@/types/print";
import type { GridSettings } from "@/store/use-scene-store";
import { downloadBlob } from "./download";
import { validateExportLayout, assemblyPlanSVG } from "./validate-layout";

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
const RELATIONSHIPS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
type Provenance = Pick<PrintModel, "sources" | "fetchedAt" | "osmTimestamp">;
const escapeXML = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** One indexed closed mesh; base materials retain the layer colours on its surface. */
export function create3MFModelXML(
  mesh: PrintMesh,
  colors: PrintModel["colors"],
  provenance?: Provenance,
): string {
  const source =
    provenance ?? ("sources" in mesh ? (mesh as PrintModel) : undefined);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="fr-FR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ' <metadata name="Title">PrintMap</metadata>',
    ' <metadata name="Application">PrintMap</metadata>',
    ` <metadata name="Description">Maquette cartographique en millimètres. Couleurs de surface ; affectation des filaments dans le logiciel de tranchage.${source?.osmTimestamp ? ` Données OpenStreetMap du ${escapeXML(source.osmTimestamp)}.` : ""}</metadata>`,
  ];
  if (source) {
    lines.push(
      ` <metadata name="Copyright">${escapeXML(source.sources.join(" ; "))}</metadata>`,
    );
    lines.push(
      ` <metadata name="CreationDate">${escapeXML(source.fetchedAt)}</metadata>`,
    );
  }
  lines.push(' <resources><basematerials id="1">');
  for (const layer of PRINT_LAYERS) {
    const color = /^#[0-9a-f]{6}$/i.test(colors[layer])
      ? colors[layer].toUpperCase()
      : "#D4D4D4";
    lines.push(`  <base name="${layer}" displaycolor="${color}FF"/>`);
  }
  lines.push(
    ' </basematerials><object id="2" type="model" pid="1" pindex="0"><mesh><vertices>',
  );
  for (let i = 0; i < mesh.positions.length; i += 3)
    lines.push(
      `  <vertex x="${mesh.positions[i]}" y="${mesh.positions[i + 1]}" z="${mesh.positions[i + 2]}"/>`,
    );
  lines.push(" </vertices><triangles>");
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const material = mesh.faceLayers[i / 3] ?? 0;
    lines.push(
      `  <triangle v1="${mesh.indices[i]}" v2="${mesh.indices[i + 1]}" v3="${mesh.indices[i + 2]}" pid="1" p1="${material}"/>`,
    );
  }
  lines.push(
    ' </triangles></mesh></object></resources><build><item objectid="2"/></build></model>',
  );
  return lines.join("\n");
}

export async function create3MFBuffer(
  mesh: PrintMesh,
  colors: PrintModel["colors"],
  provenance?: Provenance,
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELATIONSHIPS);
  zip.file("3D/3dmodel.model", create3MFModelXML(mesh, colors, provenance));
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

export async function exportTo3MF(
  model: PrintModel,
  filename = "printmap.3mf",
  grid?: GridSettings,
): Promise<void> {
  validateExportLayout(model, grid);
  if (!model.tiles.length) {
    downloadBlob(
      new Blob([await create3MFBuffer(model, model.colors)], {
        type: "model/3mf",
      }),
      filename,
    );
    return;
  }
  const zip = new JSZip();
  zip.file("plan-assemblage.svg", assemblyPlanSVG(model));
  for (const tile of model.tiles)
    zip.file(
      `tuile_${tile.row + 1}_${tile.col + 1}.3mf`,
      await create3MFBuffer(tile, model.colors, model),
    );
  zip.file(
    "LISEZ-MOI.txt",
    `PrintMap — tuiles en millimètres, axe Z vertical.\nChaque tuile est un solide fermé posé à Z=0.\nLes lignes vont du sud vers le nord, les colonnes de l’ouest vers l’est.\nLes couleurs de surface sont conservées. Affectez les filaments dans votre logiciel de tranchage.\n\nSources :\n${model.sources.join("\n")}\nDonnées récupérées le ${model.fetchedAt}.\n${model.osmTimestamp ? `OpenStreetMap : ${model.osmTimestamp}.\n` : ""}`,
  );
  downloadBlob(
    await zip.generateAsync({ type: "blob", compression: "DEFLATE" }),
    `${filename.replace(/\.3mf$/i, "")}-tuiles.zip`,
  );
}
