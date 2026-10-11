import JSZip from "jszip";
import type { PrintMesh, PrintModel } from "@/types/print";
import type { GridSettings } from "@/store/use-scene-store";
import { downloadBlob } from "./download";

/** Binary STL in millimetres, with vertical Z and the socle resting at Z=0. */
export function createSTLBuffer(mesh: PrintMesh): ArrayBuffer {
  const triangleCount = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  const header = new TextEncoder().encode(
    "PrintMap | millimeters | Z up | closed solid",
  );
  new Uint8Array(buffer, 0, header.length).set(header);
  view.setUint32(80, triangleCount, true);
  const p = mesh.positions;
  for (let tri = 0; tri < triangleCount; tri++) {
    const a = mesh.indices[tri * 3] * 3,
      b = mesh.indices[tri * 3 + 1] * 3,
      c = mesh.indices[tri * 3 + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    let offset = 84 + tri * 50;
    for (const value of [
      nx / len,
      ny / len,
      nz / len,
      p[a],
      p[a + 1],
      p[a + 2],
      p[b],
      p[b + 1],
      p[b + 2],
      p[c],
      p[c + 1],
      p[c + 2],
    ]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
  }
  return buffer;
}

export async function exportToSTL(
  model: PrintModel,
  filename = "printmap.stl",
  grid?: GridSettings,
): Promise<void> {
  if (
    grid &&
    (grid.cols * grid.rows !== (model.tiles.length || 1) ||
      model.tiles.some(
        (tile) => tile.col >= grid.cols || tile.row >= grid.rows,
      ))
  )
    throw new Error(
      "La grille a changé. Régénérez la maquette avant l’export.",
    );
  if (!model.tiles.length) {
    downloadBlob(
      new Blob([createSTLBuffer(model)], { type: "application/octet-stream" }),
      filename,
    );
    return;
  }
  const zip = new JSZip();
  for (const tile of model.tiles)
    zip.file(
      `tuile_${tile.row + 1}_${tile.col + 1}.stl`,
      createSTLBuffer(tile),
    );
  zip.file(
    "LISEZ-MOI.txt",
    `PrintMap — tuiles en millimètres, axe Z vertical.\nChaque tuile est un solide fermé posé à Z=0.\nGrille : ${grid?.cols ?? Math.max(...model.tiles.map((t) => t.col)) + 1} colonnes × ${grid?.rows ?? Math.max(...model.tiles.map((t) => t.row)) + 1} lignes.\nLes lignes vont du sud vers le nord, les colonnes de l’ouest vers l’est.\nAssembler les tuiles par leurs arêtes droites.\n\nSources :\n${model.sources.join("\n")}\nDonnées récupérées le ${model.fetchedAt}.\n${model.osmTimestamp ? `OpenStreetMap : ${model.osmTimestamp}.\n` : ""}`,
  );
  downloadBlob(
    await zip.generateAsync({ type: "blob", compression: "DEFLATE" }),
    `${filename.replace(/\.stl$/i, "")}-tuiles.zip`,
  );
}
