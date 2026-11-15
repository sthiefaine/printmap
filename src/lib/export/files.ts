import JSZip from "jszip";
import type { BuiltModel, BuiltTile, MeshData } from "@/lib/model/build";
import {
  LAYER_NAMES,
  LAYERS,
  type LayerId,
  type ModelSettings,
} from "@/lib/model/settings";

export type ExportFormat = "stl" | "3mf";

/** Binary STL, millimetres, Z up. */
export function stlBytes({ positions, indices }: MeshData): Uint8Array {
  const count = indices.length / 3;
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  new TextEncoder().encodeInto("PrintMap - mm - Z up", bytes);
  view.setUint32(80, count, true);
  let offset = 84;
  for (let t = 0; t < count; t++) {
    const a = indices[t * 3] * 3,
      b = indices[t * 3 + 1] * 3,
      c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    for (const value of [nx, ny, nz]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    for (const vertex of [a, b, c])
      for (let axis = 0; axis < 3; axis++) {
        view.setFloat32(offset, positions[vertex + axis], true);
        offset += 4;
      }
    offset += 2;
  }
  return bytes;
}

const number = (value: number) => String(Math.round(value * 10000) / 10000);

/** One 3MF object made of one part per colour, so that a slicer can give
 * each of them its own filament. */
export async function threeMFBytes(
  tile: BuiltTile,
  colors: Record<LayerId, string>,
): Promise<Uint8Array> {
  const used = LAYERS.filter((layer) =>
    tile.parts.some((part) => part.layer === layer),
  );
  const xml: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="fr" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `<metadata name="Title">PrintMap ${tile.label}</metadata>`,
    "<resources>",
    '<basematerials id="1">',
    ...used.map(
      (layer) =>
        `<base name="${LAYER_NAMES[layer]}" displaycolor="${colors[layer].toUpperCase()}FF"/>`,
    ),
    "</basematerials>",
  ];
  const ids: number[] = [];
  tile.parts.forEach((part, index) => {
    const id = index + 2;
    ids.push(id);
    xml.push(
      `<object id="${id}" type="model" name="${LAYER_NAMES[part.layer]}" pid="1" pindex="${used.indexOf(part.layer)}"><mesh><vertices>`,
    );
    const p = part.positions;
    const chunk: string[] = [];
    for (let i = 0; i < p.length; i += 3)
      chunk.push(
        `<vertex x="${number(p[i])}" y="${number(p[i + 1])}" z="${number(p[i + 2])}"/>`,
      );
    xml.push(chunk.join(""), "</vertices><triangles>");
    const t = part.indices;
    const triangles: string[] = [];
    for (let i = 0; i < t.length; i += 3)
      triangles.push(
        `<triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>`,
      );
    xml.push(triangles.join(""), "</triangles></mesh></object>");
  });
  const group = tile.parts.length + 2;
  xml.push(
    `<object id="${group}" type="model" name="Plaque ${tile.label}"><components>`,
    ...ids.map((id) => `<component objectid="${id}"/>`),
    "</components></object>",
    "</resources>",
    `<build><item objectid="${group}"/></build>`,
    "</model>",
  );
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
  );
  zip.file("3D/3dmodel.model", xml.join("\n"));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** Numbered plan, north up, as seen from above. */
export function assemblyPlanSVG(model: BuiltModel): string {
  const { cols, rows, tileWidthMm: tw, tileDepthMm: td } = model.layout;
  const unit = 600 / Math.max(cols * tw, rows * td);
  const w = cols * tw * unit,
    h = rows * td * unit;
  const cells = model.tiles
    .map((tile) => {
      const x = 20 + tile.col * tw * unit,
        y = 50 + tile.row * td * unit;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(tw * unit).toFixed(1)}" height="${(td * unit).toFixed(1)}" fill="#f6f3ec" stroke="#2f3b33" stroke-width="2"/><text x="${(x + (tw * unit) / 2).toFixed(1)}" y="${(y + (td * unit) / 2 + 9).toFixed(1)}" font-size="26" text-anchor="middle" font-family="sans-serif" fill="#2f3b33">${tile.label}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${(w + 40).toFixed(0)} ${(h + 100).toFixed(0)}"><rect width="100%" height="100%" fill="#fff"/><text x="20" y="30" font-size="18" font-family="sans-serif" fill="#2f3b33">Plan d’assemblage vu de dessus · nord en haut · ${cols} × ${rows} plaques de ${tw.toFixed(1)} × ${td.toFixed(1)} mm</text>${cells}<text x="20" y="${(h + 80).toFixed(0)}" font-size="15" font-family="sans-serif" fill="#2f3b33">Chaque numéro (colonne-rangée) est gravé sous sa plaque. Maquette assemblée : ${(cols * tw).toFixed(0)} × ${(rows * td).toFixed(0)} mm, échelle 1:${Math.round(model.layout.scale)}.</text></svg>`;
}

function readme(model: BuiltModel, format: ExportFormat) {
  const { cols, rows, tileWidthMm, tileDepthMm, scale } = model.layout;
  return [
    "PrintMap — maquette à imprimer",
    "",
    `Maquette assemblée : ${(cols * tileWidthMm).toFixed(0)} × ${(rows * tileDepthMm).toFixed(0)} × ${model.heightMm.toFixed(1)} mm, échelle 1:${Math.round(scale)}.`,
    `${cols * rows} plaque(s) de ${tileWidthMm.toFixed(1)} × ${tileDepthMm.toFixed(1)} mm : ${cols} colonne(s) d’ouest en est, ${rows} rangée(s) du nord au sud.`,
    "",
    "Impression",
    "- Chaque fichier est déjà à plat, dessous à Z = 0, en millimètres. Aucun support n’est nécessaire.",
    "- Couches de 0,2 mm ou moins, buse de 0,4 mm. 3 périmètres et 15 % de remplissage suffisent.",
    format === "3mf"
      ? "- 3MF : ouvrir chaque plaque comme un seul objet en plusieurs pièces, puis attribuer un filament par pièce (socle, routes, eau, espaces verts, bâtiments)."
      : "- STL : une seule matière. Pour changer de couleur à une hauteur donnée, ajouter une pause dans le trancheur.",
    "",
    "Assemblage",
    "- Le numéro colonne-rangée est gravé sous chaque plaque ; plan-assemblage.svg montre leur place, nord en haut.",
    model.keys
      ? `- Imprimer cles-assemblage.stl (${model.keys.count} clés papillon, dont 2 de rechange). Retourner les plaques côte à côte et enfoncer une clé dans chaque logement à cheval sur deux plaques. Une goutte de colle rend l’assemblage définitif.`
      : "- Les bords sont droits : coller les plaques bord à bord ou sur un support.",
    "",
    "Données © les contributeurs d’OpenStreetMap (ODbL). En France : IGN, Licence Ouverte 2.0.",
  ].join("\n");
}

/** A single plate downloads as a bare file; several as a ZIP with the plan. */
export async function exportModel(
  model: BuiltModel,
  settings: ModelSettings,
  format: ExportFormat,
  name: string,
): Promise<{ filename: string; bytes: Uint8Array }> {
  const encode = (tile: BuiltTile) =>
    format === "stl"
      ? Promise.resolve(stlBytes(tile.solid))
      : threeMFBytes(tile, settings.colors);
  if (model.tiles.length === 1)
    return {
      filename: `${name}.${format}`,
      bytes: await encode(model.tiles[0]),
    };
  const zip = new JSZip();
  for (const tile of model.tiles)
    zip.file(`plaque-${tile.label}.${format}`, await encode(tile));
  if (model.keys) zip.file("cles-assemblage.stl", stlBytes(model.keys));
  zip.file("plan-assemblage.svg", assemblyPlanSVG(model));
  zip.file("LISEZMOI.txt", readme(model, format));
  return {
    filename: `${name}-${model.layout.cols}x${model.layout.rows}-${format}.zip`,
    bytes: await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    }),
  };
}
