import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";

interface Handles {
  keep<T extends { delete(): void }>(handle: T): T;
}

export interface BasinRimOptions {
  /** Exact mapped water interior; the rim occupies its exterior only. */
  footprint: CrossSection;
  clip: CrossSection;
  /** Closed terrain with a planar bottom and its actual triangulated top. */
  terrainSolid?: Manifold;
  /** A surveyed planar support can replace terrainSolid; curved callbacks reject. */
  surfaceAt?: (x: number, y: number) => number;
  terrainMaxZ: number;
  foundationZ: number;
  widthMm: number;
  heightMm: number;
  minWidthMm?: number;
  minHeightMm?: number;
}

export interface PrintableBasinRim {
  solid: Manifold;
  rim: CrossSection;
  widthMm: number;
  heightMm: number;
  adjustedDimensions: boolean;
  terrainMode: "mesh" | "plane";
}

/** Add a supported boundary without replacing or filling the basin interior. */
export function makeBasinRim(
  cad: ManifoldToplevel,
  owner: Handles,
  options: BasinRimOptions,
): PrintableBasinRim | null {
  const minimumWidth = Math.max(0.4, options.minWidthMm ?? 0.4);
  const minimumHeight = Math.max(0.12, options.minHeightMm ?? 0.12);
  if (
    ![
      options.terrainMaxZ,
      options.foundationZ,
      options.widthMm,
      options.heightMm,
      minimumWidth,
      minimumHeight,
    ].every(Number.isFinite) ||
    options.widthMm < 0 ||
    options.heightMm < 0 ||
    options.foundationZ < 0 ||
    options.terrainMaxZ < options.foundationZ ||
    options.footprint.isEmpty() ||
    options.clip.isEmpty() ||
    (!options.terrainSolid && !options.surfaceAt)
  )
    return null;
  const widthMm = Math.max(minimumWidth, options.widthMm);
  const heightMm = Math.max(minimumHeight, options.heightMm);
  const handles: { delete(): void }[] = [];
  const arena: Handles = {
    keep(handle) {
      handles.push(handle);
      return handle;
    },
  };
  const outputs = new Set<{ delete(): void }>();
  try {
    // Subtract the original footprint before clipping. Clipping first would add
    // a false border across water where the selection cuts through the basin.
    const outer = arena.keep(options.footprint.offset(widthMm, "Round", 2, 24));
    const ring = arena.keep(outer.subtract(options.footprint));
    const rim = arena.keep(ring.intersect(options.clip));
    if (rim.isEmpty() || rim.area() <= 0.000001) return null;
    const bottomZ = Math.max(0, options.foundationZ - 0.02);
    let solid: Manifold;
    let terrainMode: PrintableBasinRim["terrainMode"];
    if (options.terrainSolid) {
      const source = options.terrainSolid;
      if (source.status() !== "NoError" || source.isEmpty()) return null;
      const bottom = source.boundingBox().min[2];
      const raisedTerrain = arena.keep(
        source.warp((vertex) => {
          if (vertex[2] > bottom + 0.000001) vertex[2] += heightMm;
        }),
      );
      const maximum = raisedTerrain.boundingBox().max[2];
      if (maximum <= bottomZ) return null;
      const column = arena.keep(
        arena
          .keep(rim.extrude(maximum - bottomZ + 1))
          .translate([0, 0, bottomZ]),
      );
      solid = arena.keep(column.intersect(raisedTerrain));
      terrainMode = "mesh";
    } else {
      const sample = options.surfaceAt!;
      const bounds = rim.bounds();
      const [minX, minY] = bounds.min,
        [maxX, maxY] = bounds.max;
      const z00 = sample(minX, minY),
        z10 = sample(maxX, minY),
        z01 = sample(minX, maxY);
      if (![z00, z10, z01].every(Number.isFinite)) return null;
      const dx = maxX - minX,
        dy = maxY - minY;
      if (dx <= 0 || dy <= 0) return null;
      const plane = (x: number, y: number) =>
        z00 + ((x - minX) / dx) * (z10 - z00) + ((y - minY) / dy) * (z01 - z00);
      const consistent = (x: number, y: number) => {
        const measured = sample(x, y);
        return (
          Number.isFinite(measured) &&
          measured >= options.foundationZ &&
          Math.abs(measured - plane(x, y)) < 0.00001
        );
      };
      for (const ring of rim.toPolygons())
        for (let i = 0; i < ring.length; i++) {
          const [x, y] = ring[i],
            [nx, ny] = ring[(i + 1) % ring.length];
          if (!consistent(x, y) || !consistent((x + nx) / 2, (y + ny) / 2))
            return null;
        }
      // A non-planar DEM must be supplied as its actual triangle mesh. Sampling
      // only a ring's vertices could otherwise bridge terrain peaks or float.
      for (let row = 0; row <= 4; row++)
        for (let col = 0; col <= 4; col++)
          if (!consistent(minX + (col / 4) * dx, minY + (row / 4) * dy))
            return null;
      solid = arena.keep(
        arena.keep(rim.extrude(1)).warp((vertex) => {
          vertex[2] =
            vertex[2] > 0.5 ? plane(vertex[0], vertex[1]) + heightMm : bottomZ;
        }),
      );
      terrainMode = "plane";
    }
    if (solid.status() !== "NoError" || solid.isEmpty() || solid.volume() <= 0)
      return null;
    for (const handle of [solid, rim]) {
      owner.keep(handle);
      outputs.add(handle);
    }
    return {
      solid,
      rim,
      widthMm,
      heightMm,
      adjustedDimensions:
        widthMm !== options.widthMm || heightMm !== options.heightMm,
      terrainMode,
    };
  } catch {
    return null;
  } finally {
    for (let i = handles.length - 1; i >= 0; i--)
      if (!outputs.has(handles[i])) handles[i].delete();
  }
}
