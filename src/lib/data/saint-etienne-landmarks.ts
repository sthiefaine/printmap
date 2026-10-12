/** OSM identities only: this inventory supplies no invented building geometry. */
export const SAINT_ETIENNE_LANDMARKS = [
  { id: "CRAIG/2021/1004236.00", name: "Grand’Église" },
  { id: "CRAIG/2021/1003662.00", name: "Église Saint-Louis" },
  { id: "CRAIG/2021/1004016.00", name: "Musée d’Art et d’Industrie" },
  { id: "way/63322493", name: "Cathédrale Saint-Charles" },
  { id: "relation/5201020", name: "Hôtel de Ville" },
  { id: "way/63262968", name: "Église Sainte-Marie" },
  { id: "way/172156092", name: "Tour Observatoire" },
  { id: "way/63303051", name: "Cité du Design · La Platine" },
  { id: "way/63261991", name: "Ancienne Manufacture d’Armes" },
  { id: "way/63308936", name: "Chevalement Couriot" },
  { id: "way/49047886", name: "Zénith" },
  { id: "way/63330323", name: "Parc Expo · hall B" },
  { id: "way/750956600", name: "Parc Expo · hall A" },
  { id: "way/499335263", name: "Geoffroy-Guichard · Charles-Paret" },
  { id: "way/499335264", name: "Geoffroy-Guichard · Jean-Snella" },
  { id: "way/499335249", name: "Geoffroy-Guichard · Henri-Point" },
  { id: "way/499335252", name: "Geoffroy-Guichard · Pierre-Faurand" },
] as const;

const byId = new Map<string, { id: string; name: string }>(
  SAINT_ETIENNE_LANDMARKS.map((landmark) => [landmark.id, landmark]),
);

export function saintEtienneLandmark(sourceId: string | undefined) {
  return sourceId ? byId.get(sourceId) : undefined;
}
