/// <reference lib="webworker" />
import { buildPrintModel } from "./build-print-model";
import type {
  BuildWorkerRequest,
  BuildWorkerResponse,
  PrintMesh,
} from "@/types/print";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<BuildWorkerRequest>) => {
  const { id, input } = event.data;
  const send = (message: BuildWorkerResponse, transfer: Transferable[] = []) =>
    scope.postMessage(message, transfer);
  try {
    const model = await buildPrintModel(input, (progress, label) =>
      send({ type: "progress", id, progress, label }),
    );
    const transfer: Transferable[] = [];
    const add = (mesh: PrintMesh) =>
      transfer.push(
        mesh.positions.buffer as ArrayBuffer,
        mesh.indices.buffer as ArrayBuffer,
        mesh.faceLayers.buffer as ArrayBuffer,
      );
    add(model);
    for (const tile of model.tiles) add(tile);
    send({ type: "success", id, model }, transfer);
  } catch (error) {
    send({
      type: "error",
      id,
      message:
        error instanceof Error
          ? error.message
          : "Échec de la génération du modèle.",
    });
  }
};
