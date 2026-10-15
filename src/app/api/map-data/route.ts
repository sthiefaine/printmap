import { NextResponse } from "next/server";
import type { MapDataResponse } from "@/types/osm";
import { validateBbox } from "@/lib/data/bbox";
import { collectMapData } from "@/lib/data/collect";

export const maxDuration = 90;
export const runtime = "nodejs";
const cache = new Map<string, { value: MapDataResponse; expires: number }>();
let activeRequests = 0;

export async function POST(request: Request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Requête JSON invalide." },
      { status: 400 },
    );
  }
  let bbox;
  try {
    bbox = validateBbox(body?.bbox);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Zone invalide." },
      { status: 400 },
    );
  }
  if (body.relief != null && typeof body.relief !== "boolean")
    return NextResponse.json(
      { error: "Le choix relief doit être un booléen." },
      { status: 400 },
    );
  const relief = body.relief === true;
  const key = `${bbox.map((v) => v.toFixed(7)).join(",")}/${relief}`;
  const cached = cache.get(key);
  if (
    cached &&
    cached.expires > Date.now() &&
    (!relief || cached.value.elevationGrid)
  )
    return NextResponse.json(cached.value);
  if (activeRequests >= 3)
    return NextResponse.json(
      {
        error:
          "Des collectes sont déjà en cours. Réessayez dans quelques secondes.",
      },
      { status: 429, headers: { "Retry-After": "5" } },
    );
  activeRequests++;
  try {
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(85000),
    ]);
    const value = await collectMapData(bbox, relief, signal);
    // A transient terrain outage must not pin a requested relief to a flat
    // model for thirty minutes, including after a manual retry.
    if (!relief || value.elevationGrid) {
      if (cache.size >= 6) cache.delete(cache.keys().next().value!);
      cache.set(key, { value, expires: Date.now() + 30 * 60 * 1000 });
    }
    return NextResponse.json(value);
  } catch (error) {
    return NextResponse.json(
      {
        error: request.signal.aborted
          ? "Collecte annulée."
          : error instanceof Error && error.name !== "TimeoutError"
            ? error.message
            : "La collecte a dépassé son délai. Réessayez avec une sélection plus petite.",
      },
      { status: request.signal.aborted ? 499 : 502 },
    );
  } finally {
    activeRequests--;
  }
}
