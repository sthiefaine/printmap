import type { BBox } from "@/types/osm";
import {
  SAINT_ETIENNE_STADIUM_BBOX,
  SAINT_ETIENNE_TWO_PLATE_BBOX,
} from "./data/saint-etienne-areas";

export type ShortcutCity = "montpellier" | "saint-etienne" | "rio";
export type CityPresetId =
  | "city"
  | "peyrou"
  | "saint-etienne"
  | "saint-etienne-stadium"
  | "saint-etienne-two-plates"
  | "saint-etienne-roofs"
  | "rio";

export interface CityPreset {
  id: CityPresetId;
  city: ShortcutCity;
  label: string;
  name: string;
  bbox: BBox;
}

export const PEYROU_BBOX: BBox = [43.6099, 3.8677, 43.6131, 3.8745];
// 23.1 km²: the Corcovado summit, Botafogo cove, Sugarloaf and the northern
// Copacabana waterfront fit within the same selection, below the 25 km² cap.
export const RIO_BBOX: BBox = [-22.974, -43.212, -22.939, -43.154];

export const CITY_PRESETS: CityPreset[] = [
  {
    id: "city",
    city: "montpellier",
    label: "Centre",
    name: "Montpellier, centre",
    bbox: [43.6074, 3.8705, 43.6164, 3.8829],
  },
  {
    id: "peyrou",
    city: "montpellier",
    label: "Peyrou · Arc et aqueduc",
    name: "Peyrou · Arc et aqueduc",
    bbox: PEYROU_BBOX,
  },
  {
    id: "saint-etienne",
    city: "saint-etienne",
    label: "Centre et Parc Expo",
    name: "Saint-Étienne · centre et Parc Expo",
    bbox: [45.4288, 4.3702, 45.454, 4.406],
  },
  {
    id: "saint-etienne-stadium",
    city: "saint-etienne",
    label: "Centre, Expo et stade",
    name: "Saint-Étienne · centre, Parc Expo et Geoffroy-Guichard",
    bbox: SAINT_ETIENNE_STADIUM_BBOX,
  },
  {
    id: "saint-etienne-two-plates",
    city: "saint-etienne",
    label: "Cadrage resserré · 2 plaques",
    name: "Saint-Étienne · centre, Expo et stade · cadrage 2 plaques",
    bbox: SAINT_ETIENNE_TWO_PLATE_BBOX,
  },
  {
    id: "saint-etienne-roofs",
    city: "saint-etienne",
    label: "Badouillière · toitures détaillées",
    name: "Saint-Étienne · Badouillière, toitures mesurées",
    bbox: [45.43085, 4.38145, 45.4379, 4.3945],
  },
  {
    id: "rio",
    city: "rio",
    label: "Corcovado, Botafogo et Pain de Sucre",
    name: "Rio de Janeiro · Corcovado, Botafogo et Copacabana",
    bbox: RIO_BBOX,
  },
];

export const CITY_SHORTCUTS = [
  { city: "montpellier", label: "Montpellier", preset: "city" },
  {
    city: "saint-etienne",
    label: "Saint-Étienne",
    preset: "saint-etienne-stadium",
  },
  { city: "rio", label: "Rio de Janeiro", preset: "rio" },
] as const;
