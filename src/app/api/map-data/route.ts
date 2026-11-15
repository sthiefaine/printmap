import { NextResponse } from "next/server";
import type { MapData } from "@/types/osm";
import { validateBbox } from "@/lib/data/bbox";
import { collectMapData } from "@/lib/data/collect";

export const maxDuration = 80;
export const runtime = "nodejs";
const cache = new Map<string, { value: MapData; expires: number }>();

export async function POST(request: Request) {
  let bbox;
  try {
    bbox = validateBbox((await request.json())?.bbox);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Zone invalide." },
      { status: 400 },
    );
  }
  const key = bbox.map((v) => v.toFixed(6)).join(",");
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now())
    return NextResponse.json(cached.value);
  try {
    const value = await collectMapData(
      bbox,
      AbortSignal.any([request.signal, AbortSignal.timeout(70000)]),
    );
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(key, { value, expires: Date.now() + 30 * 60 * 1000 });
    return NextResponse.json(value);
  } catch (error) {
    return NextResponse.json(
      {
        error: request.signal.aborted
          ? "Collecte annulée."
          : error instanceof Error && error.name !== "TimeoutError"
            ? error.message
            : "Les serveurs de données mettent trop de temps à répondre. Réessayez, ou choisissez une zone plus petite.",
      },
      { status: request.signal.aborted ? 499 : 502 },
    );
  }
}
