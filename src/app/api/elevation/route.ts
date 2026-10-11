import { NextResponse } from "next/server";
import { validateBbox } from "@/lib/data/bbox";
import { fetchElevation } from "@/lib/data/elevation";

export const runtime = "nodejs";
export const maxDuration = 60;
let activeRequests = 0;

/** Acquire missing terrain without replacing already collected city geometry. */
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
  if (activeRequests >= 3)
    return NextResponse.json(
      {
        error:
          "Des reliefs sont déjà en cours de collecte. Réessayez dans quelques secondes.",
      },
      { status: 429, headers: { "Retry-After": "5" } },
    );
  activeRequests++;
  try {
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(55000),
    ]);
    const elevationGrid = await fetchElevation(bbox, signal);
    signal.throwIfAborted();
    return NextResponse.json({ elevationGrid });
  } catch {
    return NextResponse.json(
      {
        error: request.signal.aborted
          ? "Collecte du relief annulée."
          : "Relief indisponible. Réessayez ou choisissez une zone plus petite.",
      },
      { status: request.signal.aborted ? 499 : 502 },
    );
  } finally {
    activeRequests--;
  }
}
