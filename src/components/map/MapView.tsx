"use client";

import { useRef, useEffect, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { TerraDraw, TerraDrawRectangleMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { useMapStore } from "@/store/use-map-store";
import { useAppStore } from "@/store/use-app-store";

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const selectedCity = useMapStore((s) => s.selectedCity);
  const bbox = useMapStore((s) => s.bbox);
  const drawingRevision = useAppStore((s) => s.drawingRevision);
  const viewMode = useAppStore((s) => s.viewMode);
  const [mapError, setMapError] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [3.8767, 43.6119],
      zoom: 14,
      pitch: 0,
    });
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: false }),
      "bottom-right",
    );
    mapRef.current = map;
    map.on("error", () => setMapError(true));
    map.on("load", () => {
      setMapError(false);
      map.addSource("print-selection", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "print-selection-fill",
        type: "fill",
        source: "print-selection",
        paint: { "fill-color": "#d16c39", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "print-selection-line",
        type: "line",
        source: "print-selection",
        paint: { "line-color": "#d16c39", "line-width": 2 },
      });
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [new TerraDrawRectangleMode()],
      });
      draw.start();
      draw.setMode("rectangle");
      draw.on("finish", (id) => {
        const feature = draw.getSnapshot().find((f) => f.id === id);
        if (feature?.geometry.type !== "Polygon") return;
        const ring = feature.geometry.coordinates[0];
        const latitudes = ring.map((p) => p[1]);
        const longitudes = ring.map((p) => p[0]);
        useMapStore
          .getState()
          .setBbox([
            Math.min(...latitudes),
            Math.min(...longitudes),
            Math.max(...latitudes),
            Math.max(...longitudes),
          ]);
        draw.clear();
      });
      drawRef.current = draw;
      const selected = useMapStore.getState().bbox;
      if (selected) updateSelection(map, selected);
    });
    return () => {
      drawRef.current?.stop();
      drawRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (bbox && mapRef.current?.isStyleLoaded())
      updateSelection(mapRef.current, bbox);
    else if (!bbox && mapRef.current?.isStyleLoaded())
      (
        mapRef.current.getSource("print-selection") as
          maplibregl.GeoJSONSource | undefined
      )?.setData({ type: "FeatureCollection", features: [] });
  }, [bbox]);
  useEffect(() => {
    if (selectedCity)
      mapRef.current?.flyTo({
        center: [selectedCity.lng, selectedCity.lat],
        zoom: 14.5,
        duration: 1000,
      });
    drawRef.current?.clear();
  }, [selectedCity]);
  useEffect(() => {
    drawRef.current?.setMode("rectangle");
  }, [drawingRevision]);
  useEffect(() => {
    if (viewMode === "map")
      requestAnimationFrame(() => mapRef.current?.resize());
  }, [viewMode]);
  return (
    <div className="map-view">
      <div ref={containerRef} className="map-canvas" />
      {mapError ? (
        <div className="map-notice">
          Fond de carte indisponible. La sélection rapide et la démo restent
          disponibles.
        </div>
      ) : (
        <div className="map-notice">
          Dessinez un rectangle : cliquez sur deux coins opposés.
        </div>
      )}
    </div>
  );
}
function updateSelection(
  map: maplibregl.Map,
  bbox: [number, number, number, number],
) {
  const [s, w, n, e] = bbox;
  (
    map.getSource("print-selection") as maplibregl.GeoJSONSource | undefined
  )?.setData({
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
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
  });
}
