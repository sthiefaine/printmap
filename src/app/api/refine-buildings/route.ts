import { NextResponse } from "next/server";
import { validateBbox } from "@/lib/data/bbox";
import { validateAssemblyData } from "@/lib/assembly-project";
import { refineBuildingData } from "@/lib/data/refine-buildings";

export const runtime = "nodejs";
export const maxDuration = 40;
const MAX_BYTES = 32 * 1024 * 1024;
let activeRequests = 0;

async function readBody(
  request: Request,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  if (Number(request.headers.get("content-length")) > MAX_BYTES)
    throw new RangeError(
      "Données trop volumineuses : affinez une plaque plus petite.",
    );
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Données de plaque absentes.");
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new RangeError(
          "Données trop volumineuses : affinez une plaque plus petite.",
        );
      }
      parts.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  if (activeRequests >= 2)
    return NextResponse.json(
      {
        error:
          "Des détails sont déjà en cours de collecte. Réessayez dans quelques secondes.",
      },
      { status: 429, headers: { "Retry-After": "5" } },
    );
  activeRequests++;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(35000)]);
  try {
    let data, bbox, retry;
    try {
      const body = (await readBody(request, signal)) as {
        bbox?: unknown;
        data?: unknown;
        retry?: unknown;
      };
      bbox = validateBbox(body?.bbox);
      data = validateAssemblyData(body?.data, bbox);
      if (body.retry != null && typeof body.retry !== "boolean")
        throw new Error("Choix de reprise invalide.");
      retry = body.retry === true;
    } catch (error) {
      return NextResponse.json(
        {
          error: signal.aborted
            ? "Transmission des données interrompue. Les lots déjà sauvegardés sont conservés."
            : error instanceof Error
              ? error.message
              : "Données invalides.",
        },
        {
          status: request.signal.aborted
            ? 499
            : signal.aborted
              ? 408
              : error instanceof RangeError
                ? 413
                : 400,
        },
      );
    }
    return NextResponse.json(
      await refineBuildingData(data, bbox, signal, retry),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: request.signal.aborted
          ? "Affinement annulé."
          : error instanceof Error && error.name !== "TimeoutError"
            ? error.message
            : "Le lot de détails a dépassé son délai. Les lots déjà sauvegardés sont conservés.",
      },
      { status: request.signal.aborted ? 499 : 502 },
    );
  } finally {
    activeRequests--;
  }
}
