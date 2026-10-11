import * as THREE from "three";

export type RGB01 = [number, number, number];

export interface BuildingColors {
  wall: RGB01;
  roof: RGB01;
}

// ── Material → color mappings ──

const WALL_MATERIAL_COLORS: Record<string, string> = {
  brick: "#8B4513",
  stone: "#A0A0A0",
  concrete: "#C0C0C0",
  glass: "#87CEEB",
  metal: "#B0B0B0",
  wood: "#DEB887",
  plaster: "#F5F5DC",
  render: "#F0E8D8",
  cement_block: "#B8B8B8",
  limestone: "#D4CFC0",
  sandstone: "#D2B48C",
  granite: "#808080",
  marble: "#F0F0F0",
  steel: "#71797E",
  copper: "#B87333",
  aluminium: "#A8A9AD",
  cladding: "#C8C0B0",
  stucco: "#F0E6D0",
  timber_framing: "#C4A882",
};

const ROOF_MATERIAL_COLORS: Record<string, string> = {
  tile: "#CD5C5C",
  roof_tiles: "#CD5C5C",
  clay: "#B85C38",
  slate: "#708090",
  thatch: "#DAA520",
  metal: "#808080",
  copper: "#B87333",
  tar_paper: "#3C3C3C",
  concrete: "#B0B0B0",
  asbestos: "#A0A0A0",
  glass: "#C0E0F0",
  wood: "#A0856C",
  eternit: "#909090",
  gravel: "#A0A0A0",
  grass: "#6AB04C",
};

// ── Color parsing ──

const tmpColor = new THREE.Color();

function parseColorString(value: string): RGB01 | null {
  try {
    tmpColor.set(value);
    return [tmpColor.r, tmpColor.g, tmpColor.b];
  } catch {
    return null;
  }
}

function materialToColor(
  material: string,
  lookup: Record<string, string>,
): RGB01 | null {
  const hex = lookup[material.toLowerCase()];
  if (!hex) return null;
  tmpColor.set(hex);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

// ── Public API ──

export function hexToRgb01(hex: string): RGB01 {
  tmpColor.set(hex);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

export function getBuildingColors(
  tags: Record<string, string>,
  defaultWall: RGB01,
  defaultRoof: RGB01,
): BuildingColors {
  // Wall color resolution
  const wall =
    (tags["building:colour"] && parseColorString(tags["building:colour"])) ||
    (tags["building:material"] &&
      materialToColor(tags["building:material"], WALL_MATERIAL_COLORS)) ||
    (tags["building:facade:colour"] &&
      parseColorString(tags["building:facade:colour"])) ||
    (tags["building:facade:material"] &&
      materialToColor(
        tags["building:facade:material"],
        WALL_MATERIAL_COLORS,
      )) ||
    defaultWall;

  // Roof color resolution
  const roof =
    (tags["roof:colour"] && parseColorString(tags["roof:colour"])) ||
    (tags["roof:material"] &&
      materialToColor(tags["roof:material"], ROOF_MATERIAL_COLORS)) ||
    defaultRoof;

  return { wall, roof };
}
