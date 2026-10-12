import type { Manifold, ManifoldToplevel } from "manifold-3d";
import type { PrintLayer } from "@/types/print";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

/** Preserve the established boolean order unless native ancestry is dense. */
export function preparePrintLayers(
  cad: ManifoldToplevel,
  owner: Handles,
  solids: readonly Manifold[],
  materialIds: Map<number, PrintLayer>,
): readonly Manifold[] {
  // A thousand tagged details already multiplies the several thousand DEM
  // boundary shells into millions of native source-map entries in Decompose.
  // Small sites do not need that memory optimisation: keep their exact input
  // handles/order, since regrouping can change native triangulation at a cut.
  return solids.length > 1024
    ? fusePrintLayers(cad, owner, solids, materialIds)
    : solids;
}

/** Reduce native ancestry to one source per printable material, without rounding. */
export function fusePrintLayers(
  cad: ManifoldToplevel,
  owner: Handles,
  solids: readonly Manifold[],
  materialIds: Map<number, PrintLayer>,
): Manifold[] {
  const layers = new Map<PrintLayer, Manifold[]>();
  for (const solid of solids) {
    const layer = materialIds.get(solid.originalID());
    if (!layer)
      throw new Error("Un détail ne possède pas de matériau imprimable.");
    const items = layers.get(layer) ?? [];
    items.push(solid);
    layers.set(layer, items);
  }
  return Array.from(layers, ([layer, items]) => {
    const joined = owner.keep(cad.Manifold.union(items));
    // Decompose copies the parent's entire native source map into each shell.
    // Thousands of buildings and numerical DEM skins otherwise exhaust WASM
    // memory before those skins can be discarded. Source repairs are finished;
    // only the shared print colour is needed here. AsOriginal keeps coordinates,
    // winding and cavities, and does not simplify or convert to Float32.
    const original = owner.keep(joined.asOriginal());
    materialIds.set(original.originalID(), layer);
    return original;
  });
}
