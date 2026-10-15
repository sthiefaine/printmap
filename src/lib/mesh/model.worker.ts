/// <reference lib="webworker" />
import { buildPrintModel } from "./build-print-model";
import { preparePreview, printModelTransferables } from "./prepare-preview";
import type { BuildWorkerRequest, BuildWorkerResponse } from "@/types/print";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<BuildWorkerRequest>) => {
  const { id, input } = event.data;
  const send = (message: BuildWorkerResponse, transfer: Transferable[] = []) =>
    scope.postMessage(message, transfer);
  try {
    const model = await buildPrintModel(input, (progress, label) =>
      send({ type: "progress", id, progress, label }),
    );
    send({
      type: "progress",
      id,
      progress: 100,
      label: "Préparation de l’aperçu 3D",
    });
    model.preview = preparePreview(model);
    send({ type: "success", id, model }, printModelTransferables(model));
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
