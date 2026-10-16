import type {
  BBox,
  MapDataResponse,
  LandmarkRefinementProgress,
} from "@/types/osm";
import { validateAssemblyData } from "@/lib/assembly-project";

/** One network batch at a time. Persist completed batches before starting another. */
export async function refineLandmarkQueue(
  initial: MapDataResponse,
  bbox: BBox,
  signal: AbortSignal,
  options: {
    retry?: boolean;
    onBatch: (data: MapDataResponse) => Promise<void>;
    onProgress: (progress?: LandmarkRefinementProgress) => void;
  },
): Promise<MapDataResponse> {
  let data = initial,
    first = true;
  do {
    signal.throwIfAborted();
    const before = data.report.landmarkRefinement;
    if (before?.remaining === 0 && !(first && options.retry && before.failed))
      break;
    options.onProgress(before);
    const response = await fetch("/api/refine-buildings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bbox,
        data,
        retry: first && options.retry === true,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error || "L’affinement des détails a été interrompu.",
      );
    const next = validateAssemblyData(result, bbox);
    const progress = next.report.landmarkRefinement;
    if (!progress)
      throw new Error("La progression des détails est absente de la réponse.");
    // This route refines roofs, not terrain or the print datum. Preserve the
    // previously aligned terrain byte for byte across all requests and backups.
    if (
      JSON.stringify(next.elevationGrid) !==
      JSON.stringify(initial.elevationGrid)
    )
      throw new Error(
        "Le lot de détails a modifié le relief commun ; il n’a pas été conservé.",
      );
    if (
      before &&
      progress.remaining > 0 &&
      progress.remaining >= before.remaining &&
      progress.completed <= before.completed &&
      progress.attempts.length <= before.attempts.length &&
      !(first && options.retry)
    )
      throw new Error(
        "Le lot n’a pas progressé. Les détails déjà sauvegardés sont conservés.",
      );
    signal.throwIfAborted();
    await options.onBatch(next);
    signal.throwIfAborted();
    data = next;
    first = false;
  } while (data.report.landmarkRefinement!.remaining > 0);
  return data;
}
