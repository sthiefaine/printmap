import type { BuildInput, BuiltModel, Progress } from "./build";
import type { WorkerReply } from "./worker";

/** One worker per build: terminating it really stops the WASM computation. */
export function buildInWorker(
  input: BuildInput,
  signal: AbortSignal,
  onProgress: Progress,
): Promise<BuiltModel> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = (settle: () => void) => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
      settle();
    };
    const abort = () =>
      finish(() => reject(new DOMException("Annulé", "AbortError")));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === "progress") onProgress(reply.fraction, reply.label);
      else if (reply.type === "done") finish(() => resolve(reply.model));
      else finish(() => reject(new Error(reply.message)));
    };
    worker.onerror = (event) =>
      finish(() =>
        reject(new Error(event.message || "Le moteur 3D n’a pas pu démarrer.")),
      );
    worker.postMessage(input);
  });
}
