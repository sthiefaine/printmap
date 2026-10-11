import test from "node:test";
import assert from "node:assert/strict";
import { useMapStore } from "../src/store/use-map-store";
import { useSceneStore } from "../src/store/use-scene-store";
import { createDemoData, DEMO_BBOX } from "../src/lib/demo";
import type {
  BuildWorkerRequest,
  BuildWorkerResponse,
  PrintModel,
} from "../src/types/print";

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: { data: BuildWorkerResponse }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  request: BuildWorkerRequest | null = null;
  terminated = false;
  constructor() {
    ControlledWorker.instances.push(this);
  }
  postMessage(request: BuildWorkerRequest) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  deliver(model: PrintModel) {
    this.onmessage?.({
      data: { type: "success", id: this.request!.id, model },
    });
  }
}
function fakeModel(buildingCount: number): PrintModel {
  return {
    positions: new Float32Array(),
    indices: new Uint32Array(),
    faceLayers: new Uint8Array(),
    colors: {
      basePlate: "#eeeeee",
      buildings: "#eeeeee",
      roads: "#777777",
      water: "#0000ff",
      parks: "#00ff00",
      sand: "#eeee00",
      piers: "#aaaaaa",
      frame: "#eeeeee",
    },
    dimensions: { widthMm: 200, depthMm: 200, heightMm: 20 },
    stats: {
      buildingCount,
      roadCount: 1,
      waterCount: 1,
      parkCount: 1,
      sandCount: 0,
      pierCount: 0,
      discardedFeatures: 0,
      triangleCount: 0,
      components: 1,
      volumeMm3: 1,
      estimatedHeights: 0,
    },
    warnings: [],
    tiles: [],
    sources: ["Test"],
    fetchedAt: "2026-10-11T08:00:00Z",
  };
}

// Even a provider that ignores AbortSignal must not publish stale geography.
test("a late collection response cannot replace a newly selected zone", async () => {
  const originalFetch = globalThis.fetch;
  let release!: (value: Response) => void;
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  try {
    useMapStore.getState().setBbox(DEMO_BBOX);
    const collection = useMapStore.getState().generate();
    const replacement: [number, number, number, number] = [
      43.6, 3.8, 43.61, 3.81,
    ];
    useMapStore.getState().setBbox(replacement);
    release(Response.json(createDemoData()));
    await collection;
    assert.deepEqual(useMapStore.getState().bbox, replacement);
    assert.equal(useMapStore.getState().osmData, null);
    assert.equal(useMapStore.getState().status, "idle");
  } finally {
    globalThis.fetch = originalFetch;
    useMapStore.getState().reset();
  }
});

test("cancel aborts collection and leaves a usable idle state", async () => {
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (_url, options) =>
    new Promise<Response>((_resolve, reject) => {
      signal = options?.signal as AbortSignal;
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Cancelled", "AbortError")),
        { once: true },
      );
    });
  try {
    useMapStore.getState().setBbox(DEMO_BBOX);
    const collection = useMapStore.getState().generate();
    useMapStore.getState().cancel();
    await collection;
    assert.equal(signal?.aborted, true);
    assert.equal(useMapStore.getState().status, "idle");
    assert.equal(useMapStore.getState().error, null);
  } finally {
    globalThis.fetch = originalFetch;
    useMapStore.getState().reset();
  }
});

test("changed print settings terminate the previous worker and publish only the latest model", async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = ControlledWorker as unknown as typeof Worker;
  ControlledWorker.instances = [];
  try {
    useMapStore.getState().setBbox(DEMO_BBOX);
    useMapStore.getState().setOsmData(createDemoData().osmData);
    const initialBuild = useMapStore.getState().rebuild();
    const firstWorker = ControlledWorker.instances[0];
    useMapStore.getState().invalidateModel();
    useSceneStore.getState().updatePrintSettings({ minFeatureMm: 1 });
    const latestBuild = useMapStore.getState().rebuild();
    assert.equal(firstWorker.terminated, true);
    assert.equal(useMapStore.getState().model, null);
    firstWorker.deliver(fakeModel(99));
    ControlledWorker.instances[1].deliver(fakeModel(12));
    await Promise.all([initialBuild, latestBuild]);
    assert.equal(useMapStore.getState().model?.stats.buildingCount, 12);
    assert.equal(useMapStore.getState().status, "done");
    assert.equal(ControlledWorker.instances[1].terminated, true);
  } finally {
    globalThis.Worker = originalWorker;
    useMapStore.getState().reset();
    useSceneStore.getState().resetSettings();
  }
});
