import type { BBox, MapDataResponse } from "@/types/osm";
import {
  enrichIGNLandmarkRoofs,
  fetchIGNLandmarkRoofGrids,
  landmarkRefinementProgress,
} from "./ign-landmark-roofs";

/** One resumable batch. Data already collected and the shared terrain never move. */
export async function refineBuildingData(
  data: MapDataResponse,
  bbox: BBox,
  signal: AbortSignal,
  retry = false,
): Promise<MapDataResponse> {
  signal.throwIfAborted();
  const progress = landmarkRefinementProgress(
    data.osmData.elements,
    bbox,
    data.report.landmarkRefinement,
    retry,
  );
  if (!progress.remaining)
    return {
      ...data,
      report: { ...data.report, landmarkRefinement: progress },
    };
  const options = {
    allowCoarseLidar: true,
    skipIds: new Set(progress.attempts.map((entry) => entry.id)),
  };
  const acquired = await fetchIGNLandmarkRoofGrids(
    data.osmData.elements,
    bbox,
    signal,
    options,
  );
  const refined = await enrichIGNLandmarkRoofs(
    data.osmData.elements,
    bbox,
    signal,
    {
      ...options,
      grids: acquired.grids,
      // This is the total across successive batches, net of roofs replaced.
      maxTotalLidarTriangles: 60000,
    },
  );
  signal.throwIfAborted();
  const updated = landmarkRefinementProgress(refined.elements, bbox, {
    ...progress,
    attempts: [...progress.attempts, ...refined.attempts],
  });
  const lidar = refined.elements.filter(
    (element) =>
      element.roofSurfaces?.length &&
      element.tags?.["printmap:roof_reconstruction"] === "lidar",
  );
  const warnings = data.report.warnings.filter(
    (warning) => !warning.startsWith("Affinement progressif :"),
  );
  warnings.push(
    `Affinement progressif : ${updated.completed} édifice(s) affiné(s), ${updated.remaining} en attente, ${updated.failed} relevé(s) indisponible(s) ou non exploitable(s), ${updated.limited} limité(s) par le budget de géométrie. Source native 0,5 m, grille utilisée 1 m ; façades et surfaces masquées non relevées.`,
  );
  return {
    ...data,
    osmData: { ...data.osmData, elements: refined.elements },
    report: {
      ...data.report,
      sources: [...new Set([...data.report.sources, ...refined.sources])],
      warnings,
      lidarRoofBuildingCount: lidar.length,
      lidarRoofSurfaceCount: lidar.reduce(
        (sum, element) => sum + element.roofSurfaces!.length,
        0,
      ),
      lidarRoofResolutionM:
        refined.resolutionM == null
          ? data.report.lidarRoofResolutionM
          : Math.max(
              data.report.lidarRoofResolutionM ?? refined.resolutionM,
              refined.resolutionM,
            ),
      lidarRoofMinResolutionM:
        refined.resolutionM == null
          ? data.report.lidarRoofMinResolutionM
          : Math.min(
              data.report.lidarRoofMinResolutionM ?? refined.resolutionM,
              refined.resolutionM,
            ),
      landmarkRoofBuildingCount: updated.completed,
      landmarkRefinement: updated,
    },
  };
}
