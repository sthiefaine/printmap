/// <reference lib="webworker" />
import { buildModel, type BuildInput, type BuiltModel } from "./build";

export type WorkerReply =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; model: BuiltModel }
  | { type: "error"; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<BuildInput>) => {
  const send = (reply: WorkerReply, transfer: Transferable[] = []) =>
    scope.postMessage(reply, transfer);
  try {
    const model = await buildModel(event.data, (fraction, label) =>
      send({ type: "progress", fraction, label }),
    );
    const buffers = new Set<ArrayBufferLike>();
    for (const tile of model.tiles)
      for (const mesh of [
        tile.solid,
        ...tile.parts,
        ...(tile.marks ? [tile.marks] : []),
      ]) {
        buffers.add(mesh.positions.buffer);
        buffers.add(mesh.indices.buffer);
      }
    if (model.keys) {
      buffers.add(model.keys.positions.buffer);
      buffers.add(model.keys.indices.buffer);
    }
    send({ type: "done", model }, [...buffers] as Transferable[]);
  } catch (error) {
    send({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "La maquette n’a pas pu être construite.",
    });
  }
};
