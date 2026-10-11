import * as GeoJSON from "geojson";

/**
 * Parse GPX XML string to extract track points as a GeoJSON LineString
 */
export function parseGPX(gpxString: string): GeoJSON.LineString | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxString, "text/xml");

    if (doc.documentElement.nodeName === "parsererror") {
      console.error("Failed to parse GPX XML");
      return null;
    }

    const coordinates: GeoJSON.Position[] = [];

    // Extract track points from <trk><trkseg><trkpt> elements
    const trkpts = doc.querySelectorAll("trk trkseg trkpt");
    if (trkpts.length > 0) {
      trkpts.forEach((trkpt) => {
        const lat = parseFloat(trkpt.getAttribute("lat") || "0");
        const lon = parseFloat(trkpt.getAttribute("lon") || "0");
        if (!isNaN(lat) && !isNaN(lon)) {
          coordinates.push([lon, lat]);
        }
      });
    }

    // If no track points, try route points
    if (coordinates.length === 0) {
      const rtepts = doc.querySelectorAll("rte rtept");
      rtepts.forEach((rtept) => {
        const lat = parseFloat(rtept.getAttribute("lat") || "0");
        const lon = parseFloat(rtept.getAttribute("lon") || "0");
        if (!isNaN(lat) && !isNaN(lon)) {
          coordinates.push([lon, lat]);
        }
      });
    }

    // If no route points, try waypoints
    if (coordinates.length === 0) {
      const wpts = doc.querySelectorAll("wpt");
      wpts.forEach((wpt) => {
        const lat = parseFloat(wpt.getAttribute("lat") || "0");
        const lon = parseFloat(wpt.getAttribute("lon") || "0");
        if (!isNaN(lat) && !isNaN(lon)) {
          coordinates.push([lon, lat]);
        }
      });
    }

    if (coordinates.length < 2) {
      console.warn("GPX file contains fewer than 2 points");
      return null;
    }

    return {
      type: "LineString",
      coordinates,
    };
  } catch (error) {
    console.error("Error parsing GPX:", error);
    return null;
  }
}
