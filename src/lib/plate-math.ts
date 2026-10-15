/** Pure numeric rules shared by plate planning and its Freerange audit.
 * Inputs are metres expressed as millimetres at 1:1000, then physical mm.
 * Runtime guards also protect imported projects and callers outside the audit.
 */
export function plateFitFactor(
  width: number,
  depth: number,
  cols: number,
  rows: number,
  usable: 95 | 145,
): number {
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(depth) ||
    depth <= 0
  )
    throw new Error("Dimensions géographiques invalides.");
  if (
    !Number.isInteger(cols) ||
    cols < 1 ||
    cols > 25 ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 25
  )
    throw new Error("Grille de plaques invalide.");
  if (usable !== 95 && usable !== 145)
    throw new Error("Format de plaque invalide.");
  const factor = Math.min(
    (cols * usable) / width,
    (rows * usable) / depth,
    1000 / Math.max(width, depth),
  );
  const scale = 1000 / factor;
  if (
    !Number.isFinite(factor) ||
    factor <= 0 ||
    !Number.isFinite(scale) ||
    scale <= 0
  )
    throw new Error(
      "Ces dimensions ne permettent pas une échelle exploitable.",
    );
  console.assert(Number.isFinite(factor));
  console.assert(factor > 0);
  console.assert(Number.isFinite(scale));
  return factor;
}

export function physicalPlateDimensions(
  geographicWidth: number,
  geographicDepth: number,
  scale: number,
  usable: 95 | 145,
) {
  if (
    !Number.isFinite(geographicWidth) ||
    geographicWidth <= 0 ||
    !Number.isFinite(geographicDepth) ||
    geographicDepth <= 0
  )
    throw new Error("Dimensions géographiques invalides.");
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error("Échelle invalide.");
  if (usable !== 95 && usable !== 145)
    throw new Error("Format de plaque invalide.");
  const widthMm = (geographicWidth * 1000) / scale;
  const depthMm = (geographicDepth * 1000) / scale;
  if (
    !Number.isFinite(widthMm) ||
    widthMm <= 0 ||
    !Number.isFinite(depthMm) ||
    depthMm <= 0
  )
    throw new Error(
      "Ces dimensions ne permettent pas une maquette exploitable.",
    );
  const cols = Math.max(1, Math.ceil(widthMm / usable - 1e-9));
  const rows = Math.max(1, Math.ceil(depthMm / usable - 1e-9));
  console.assert(Number.isFinite(widthMm));
  console.assert(Number.isFinite(depthMm));
  console.assert(cols >= 1);
  console.assert(rows >= 1);
  console.assert(Number.isInteger(cols));
  console.assert(Number.isInteger(rows));
  return { widthMm, depthMm, cols, rows };
}
