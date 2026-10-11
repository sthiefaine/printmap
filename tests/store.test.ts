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
      realRoofCount: 0,
      taggedRoofCount: 0,
      staircaseCount: 0,
      measuredStructureCount: 0,
      reconstructedBridgeCount: 0,
      basinRimCount: 0,
      reconstructedAqueductCount: 0,
      aqueductArchCount: 0,
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

test("recovering relief preserves collected geometry and its date, then builds with the new grid", async () => {
  const originalFetch = globalThis.fetch;
  const originalWorker = globalThis.Worker;
  globalThis.Worker = ControlledWorker as unknown as typeof Worker;
  ControlledWorker.instances = [];
  const data = createDemoData();
  const report = {
    ...data.report,
    sources: ["Collected city"],
    warnings: [
      "Relief indisponible au moment de la collecte.",
      "Keep this warning",
    ],
    fetchedAt: "2020-07-01T10:00:00Z",
    osmTimestamp: "2020-06-30T23:00:00Z",
    elevationSource: null,
    elevationResolutionM: null,
  };
  const grid = {
    ...data.elevationGrid,
    source: "Recovered DEM",
    resolutionM: 5,
    warnings: ["New terrain warning"],
  };
  let request: { url: unknown; body: string } | undefined;
  globalThis.fetch = async (url, options) => {
    request = { url, body: options!.body as string };
    return Response.json({ elevationGrid: grid });
  };
  try {
    useMapStore.getState().setBbox(DEMO_BBOX);
    useMapStore.setState({
      osmData: data.osmData,
      report,
      elevationGrid: null,
    });
    const settings = useSceneStore.getState().modelSettings;
    const recovery = useMapStore.getState().refreshRelief();
    assert.equal(useMapStore.getState().status, "fetching");
    assert.equal(useMapStore.getState().osmData, data.osmData);
    assert.equal(useMapStore.getState().report, report);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(request, {
      url: "/api/elevation",
      body: JSON.stringify({ bbox: DEMO_BBOX }),
    });
    const worker = ControlledWorker.instances[0];
    assert.equal(worker.request!.input.osmData, data.osmData);
    assert.deepEqual(worker.request!.input.elevationGrid, grid);
    assert.deepEqual(useMapStore.getState().bbox, DEMO_BBOX);
    assert.equal(useSceneStore.getState().modelSettings, settings);
    assert.equal(useMapStore.getState().report?.fetchedAt, report.fetchedAt);
    assert.equal(
      useMapStore.getState().report?.osmTimestamp,
      report.osmTimestamp,
    );
    assert.deepEqual(useMapStore.getState().report?.sources, [
      "Collected city",
      "Recovered DEM",
    ]);
    assert.deepEqual(useMapStore.getState().report?.warnings, [
      "Keep this warning",
      "New terrain warning",
    ]);
    assert.equal(useMapStore.getState().report?.elevationResolutionM, 5);
    worker.deliver(fakeModel(26));
    await recovery;
    assert.equal(useMapStore.getState().status, "done");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
    useMapStore.getState().reset();
    useSceneStore.getState().resetSettings();
  }
});

test("cancelled relief recovery rejects a late DEM without removing local city data", async () => {
  const originalFetch = globalThis.fetch;
  const data = createDemoData();
  let signal: AbortSignal | undefined;
  let release!: (value: Response) => void;
  globalThis.fetch = (_url, options) => {
    signal = options?.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  try {
    useMapStore.getState().setBbox(DEMO_BBOX);
    useMapStore.setState({
      osmData: data.osmData,
      report: data.report,
      elevationGrid: null,
    });
    const recovery = useMapStore.getState().refreshRelief();
    useMapStore.getState().cancel();
    assert.equal(signal?.aborted, true);
    release(Response.json({ elevationGrid: data.elevationGrid }));
    await recovery;
    assert.equal(useMapStore.getState().elevationGrid, null);
    assert.equal(useMapStore.getState().osmData, data.osmData);
    assert.equal(useMapStore.getState().report, data.report);
    assert.deepEqual(useMapStore.getState().bbox, DEMO_BBOX);
    assert.equal(useMapStore.getState().status, "idle");
    assert.equal(useMapStore.getState().error, null);
  } finally {
    globalThis.fetch = originalFetch;
    useMapStore.getState().reset();
  }
});

test("relief for an obsolete selection cannot replace the terrain of a new zone", async () => {
  const originalFetch = globalThis.fetch;
  const data = createDemoData();
  let release!: (value: Response) => void;
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  try {
    useMapStore.getState().setBbox(DEMO_BBOX);
    useMapStore.setState({
      osmData: data.osmData,
      report: data.report,
      elevationGrid: null,
    });
    const recovery = useMapStore.getState().refreshRelief();
    const replacement: [number, number, number, number] = [
      43.6, 3.8, 43.61, 3.81,
    ];
    useMapStore.getState().setBbox(replacement);
    release(Response.json({ elevationGrid: data.elevationGrid }));
    await recovery;
    assert.deepEqual(useMapStore.getState().bbox, replacement);
    assert.equal(useMapStore.getState().elevationGrid, null);
    assert.equal(useMapStore.getState().osmData, null);
    assert.equal(useMapStore.getState().status, "idle");
  } finally {
    globalThis.fetch = originalFetch;
    useMapStore.getState().reset();
  }
});

test("relief from a different zone is rejected while the collected city remains recoverable", async () => {
  const originalFetch = globalThis.fetch;
  const data = createDemoData();
  globalThis.fetch = async () =>
    Response.json({
      elevationGrid: { ...data.elevationGrid, west: DEMO_BBOX[1] - 0.001 },
    });
  try {
    useMapStore.getState().setBbox(DEMO_BBOX);
    useMapStore.setState({
      osmData: data.osmData,
      report: data.report,
      elevationGrid: null,
    });
    await useMapStore.getState().refreshRelief();
    assert.equal(useMapStore.getState().status, "error");
    assert.match(useMapStore.getState().error!, /ne correspond pas à la zone/);
    assert.equal(useMapStore.getState().elevationGrid, null);
    assert.equal(useMapStore.getState().osmData, data.osmData);
    assert.equal(useMapStore.getState().report, data.report);
    assert.deepEqual(useMapStore.getState().bbox, DEMO_BBOX);
  } finally {
    globalThis.fetch = originalFetch;
    useMapStore.getState().reset();
  }
});
