import type {
  BuildWorkerResponse,
  PrintInput,
  PrintModel,
  PrintProgress,
} from "@/types/print";

let nextId = 0;

/** A fresh worker per request allows actual cancellation of synchronous WASM. */
export function generatePrintModel(
  input: PrintInput,
  options: { onProgress?: PrintProgress; signal?: AbortSignal } = {},
): Promise<PrintModel> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Génération annulée", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./model.worker.ts", import.meta.url), {
      type: "module",
    });
    const id = ++nextId;
    const cleanup = () => {
      worker.terminate();
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Génération annulée", "AbortError"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<BuildWorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      if (response.type === "progress")
        options.onProgress?.(response.progress, response.label);
      else if (response.type === "success") {
        cleanup();
        resolve(response.model);
      } else {
        cleanup();
        reject(new Error(response.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Le moteur 3D n’a pas pu démarrer."));
    };
    worker.postMessage({ type: "build", id, input });
  });
}
