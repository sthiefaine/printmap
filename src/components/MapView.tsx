"use client";
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { TerraDraw, TerraDrawRectangleMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import type { BBox } from "@/types/osm";
import { useAppStore } from "@/store/app-store";
import { bboxDimensions } from "@/lib/data/bbox";
import { computeLayout } from "@/lib/model/settings";

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const EMPTY = { type: "FeatureCollection" as const, features: [] };

/** The selected rectangle and the seams of the plates it will be cut into. */
function selectionData(bbox: BBox | null, cols: number, rows: number) {
  if (!bbox) return { area: EMPTY, seams: EMPTY };
  const [s, w, n, e] = bbox;
  const lines: number[][][] = [];
  for (let c = 1; c < cols; c++) {
    const x = w + ((e - w) * c) / cols;
    lines.push([
      [x, s],
      [x, n],
    ]);
  }
  for (let r = 1; r < rows; r++) {
    const y = s + ((n - s) * r) / rows;
    lines.push([
      [w, y],
      [e, y],
    ]);
  }
  return {
    area: {
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
    },
    seams: {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "MultiLineString" as const, coordinates: lines },
    },
  };
}

export function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const bbox = useAppStore((s) => s.bbox);
  const settings = useAppStore((s) => s.settings);
  const flyTo = useAppStore((s) => s.flyTo);
  const drawRequest = useAppStore((s) => s.drawRequest);
  const view = useAppStore((s) => s.view);

  useEffect(() => {
    if (!container.current) return;
    maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
    const { center } = useAppStore.getState();
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: [center.lng, center.lat],
      zoom: center.zoom,
    });
    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: false }),
      "bottom-right",
    );
    map.addControl(
      new maplibregl.ScaleControl({ unit: "metric" }),
      "bottom-left",
    );
    map.on("error", () => setFailed(true));
    map.on("moveend", () => {
      const c = map.getCenter();
      useAppStore
        .getState()
        .set({ center: { lat: c.lat, lng: c.lng, zoom: map.getZoom() } });
    });
    map.on("load", () => {
      setFailed(false);
      map.addSource("area", { type: "geojson", data: EMPTY });
      map.addSource("seams", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "area-fill",
        type: "fill",
        source: "area",
        paint: { "fill-color": "#c2622f", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "area-line",
        type: "line",
        source: "area",
        paint: { "line-color": "#c2622f", "line-width": 2.5 },
      });
      map.addLayer({
        id: "seams-line",
        type: "line",
        source: "seams",
        paint: {
          "line-color": "#c2622f",
          "line-width": 1.5,
          "line-dasharray": [3, 2],
        },
      });
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [new TerraDrawRectangleMode()],
      });
      draw.start();
      draw.on("finish", (id) => {
        const feature = draw.getSnapshot().find((f) => f.id === id);
        draw.clear();
        draw.setMode("static");
        map.getCanvas().style.cursor = "";
        if (feature?.geometry.type !== "Polygon") return;
        const ring = feature.geometry.coordinates[0];
        const lat = ring.map((p) => p[1]),
          lng = ring.map((p) => p[0]);
        useAppStore
          .getState()
          .setBbox([
            Math.min(...lat),
            Math.min(...lng),
            Math.max(...lat),
            Math.max(...lng),
          ]);
      });
      drawRef.current = draw;
      const saved = useAppStore.getState().bbox;
      if (saved) frame(map, saved);
      setReady(true);
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      drawRef.current?.stop();
      drawRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const { cols, rows } = bbox
    ? computeLayout(
        bboxDimensions(bbox).widthM,
        bboxDimensions(bbox).heightM,
        settings,
      )
    : { cols: 1, rows: 1 };
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const { area, seams } = selectionData(bbox, cols, rows);
    (map.getSource("area") as maplibregl.GeoJSONSource).setData(area);
    (map.getSource("seams") as maplibregl.GeoJSONSource).setData(seams);
  }, [bbox, cols, rows, ready]);
  useEffect(() => {
    if (bbox && mapRef.current && ready) frame(mapRef.current, bbox);
  }, [bbox, ready]);
  useEffect(() => {
    if (flyTo)
      mapRef.current?.flyTo({
        center: [flyTo.lng, flyTo.lat],
        zoom: 14.5,
        duration: 900,
      });
  }, [flyTo]);
  useEffect(() => {
    if (!drawRequest || !ready) return;
    drawRef.current?.setMode("rectangle");
    if (mapRef.current) mapRef.current.getCanvas().style.cursor = "crosshair";
  }, [drawRequest, ready]);
  useEffect(() => {
    if (view === "map") requestAnimationFrame(() => mapRef.current?.resize());
  }, [view]);

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
      {failed && !ready ? (
        <p className="absolute left-4 top-4 rounded-lg bg-white/95 px-3 py-2 text-sm shadow">
          Fond de carte indisponible. Vérifiez la connexion.
        </p>
      ) : null}
    </div>
  );
}

function frame(map: maplibregl.Map, bbox: BBox) {
  const [south, west, north, east] = bbox;
  if (!map.getContainer().clientWidth) return;
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: 70, maxZoom: 17, duration: 400 },
  );
}
