"use client";

import { useRef, useEffect, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { TerraDraw, TerraDrawRectangleMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { useMapStore } from "@/store/use-map-store";
import { useAppStore } from "@/store/use-app-store";

const CARTOGRAPHIC_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const AERIAL_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    "ign-aerial": {
      type: "raster",
      tiles: [
        "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM_0_19&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image%2Fjpeg",
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '<a href="https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_BD-ORTHO" target="_blank" rel="noopener noreferrer">© IGN · BD ORTHO</a> · <a href="https://www.data.gouv.fr/pages/legal/licences/etalab-2.0" target="_blank" rel="noopener noreferrer">Licence Ouverte 2.0</a>',
    },
  },
  layers: [
    {
      id: "aerial-background",
      type: "background",
      paint: { "background-color": "#dce3d3" },
    },
    { id: "ign-aerial", type: "raster", source: "ign-aerial" },
  ],
};

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  const selectedCity = useMapStore((s) => s.selectedCity);
  const bbox = useMapStore((s) => s.bbox);
  const drawingRevision = useAppStore((s) => s.drawingRevision);
  const viewMode = useAppStore((s) => s.viewMode);
  const [mapError, setMapError] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [basemap, setBasemap] = useState<"map" | "aerial">("map");

  const changeBasemap = (next: "map" | "aerial") => {
    const map = mapRef.current;
    if (!map || next === basemap) return;
    // The adapter owns layers in the old style: unregister it before replacing
    // that style, then restore drawing and the selected zone on style.load.
    drawRef.current?.stop();
    drawRef.current = null;
    setMapError(false);
    setMapReady(false);
    setBasemap(next);
    map.setStyle(next === "aerial" ? AERIAL_STYLE : CARTOGRAPHIC_STYLE, {
      diff: false,
    });
  };

  useEffect(() => {
    if (!containerRef.current) return;
    maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: CARTOGRAPHIC_STYLE,
      center: [3.8767, 43.6119],
      zoom: 14,
      pitch: 0,
    });
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: false }),
      "bottom-right",
    );
    mapRef.current = map;
    // On mobile the settings panel temporarily hides the whole stage. Resize
    // and frame the chosen zone when the map receives its visible dimensions.
    const resizeObserver = new ResizeObserver((entries) => {
      if (
        !entries.some(
          (entry) =>
            entry.contentRect.width > 0 && entry.contentRect.height > 0,
        )
      )
        return;
      map.resize();
      const selected = useMapStore.getState().bbox;
      if (selected) frameSelection(map, selected);
    });
    resizeObserver.observe(containerRef.current);
    // Cartographic reference at the centre of OSM pitch way/147027148;
    // this label is only on the map and never becomes exported geometry.
    const stadiumLabel = document.createElement("div");
    stadiumLabel.className = "map-landmark";
    stadiumLabel.textContent = "Geoffroy-Guichard";
    const stadiumMarker = new maplibregl.Marker({
      element: stadiumLabel,
      anchor: "bottom",
    })
      .setLngLat([4.39014, 45.46078])
      .addTo(map);
    let initialStyle = true;
    map.on("error", () => setMapError(true));
    map.on("style.load", () => {
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
      if (initialStyle && selected) frameSelection(map, selected);
      initialStyle = false;
      setMapReady(true);
    });
    return () => {
      resizeObserver.disconnect();
      drawRef.current?.stop();
      drawRef.current = null;
      stadiumMarker.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const selection = map?.getSource("print-selection") as
      maplibregl.GeoJSONSource | undefined;
    if (!map || !selection) return;
    // GeoJSON can update while image tiles are still pending; otherwise clearing
    // the drawing would hide the current zone until another selection change.
    if (bbox) updateSelection(map, bbox);
    else selection.setData({ type: "FeatureCollection", features: [] });
  }, [bbox]);
  useEffect(() => {
    const map = mapRef.current;
    const selected = useMapStore.getState().bbox;
    if (map && selected) frameSelection(map, selected);
    else if (selectedCity)
      map?.flyTo({
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
      requestAnimationFrame(() => {
        const map = mapRef.current;
        map?.resize();
        const selected = useMapStore.getState().bbox;
        if (map && selected) frameSelection(map, selected);
      });
  }, [viewMode]);
  return (
    <div className="map-view">
      <div ref={containerRef} className="map-canvas" />
      <div className="map-tools">
        <div
          className="map-basemap-switch"
          role="group"
          aria-label="Fond de carte"
        >
          <button
            aria-pressed={basemap === "map"}
            onClick={() => changeBasemap("map")}
          >
            Carte
          </button>
          <button
            aria-pressed={basemap === "aerial"}
            onClick={() => changeBasemap("aerial")}
          >
            Photo aérienne (France)
          </button>
        </div>
        <div className="map-notice">
          <span>
            {mapError
              ? basemap === "aerial"
                ? "Photo IGN indisponible ou hors couverture française. Revenez à Carte pour sélectionner la zone."
                : "Fond de carte indisponible. La sélection rapide et la démo restent disponibles."
              : mapReady
                ? "Dessinez un rectangle : cliquez sur deux coins opposés."
                : "Chargement du fond de carte…"}
          </span>
          {basemap === "aerial" ? (
            <p className="map-reference">
              Référence visuelle IGN : les détails visibles sur la photo ne sont
              imprimés que si leur géométrie 3D est disponible.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Large presets must show both their northern and southern edges. */
function frameSelection(
  map: maplibregl.Map,
  bbox: [number, number, number, number],
) {
  if (!map.getContainer().clientWidth || !map.getContainer().clientHeight)
    return;
  const [south, west, north, east] = bbox;
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    {
      padding: { top: 120, bottom: 48, left: 48, right: 48 },
      maxZoom: 17,
      duration: 0,
    },
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
