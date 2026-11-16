"use client";
import { useEffect, useRef, useState } from "react";
import type { NominatimResult } from "@/types/osm";
import { useAppStore } from "@/store/app-store";

let flyId = 0;
function flyTo(result: NominatimResult) {
  useAppStore.getState().set({
    view: "map",
    flyTo: { lat: Number(result.lat), lng: Number(result.lon), id: ++flyId },
  });
}

export function CitySearch() {
  const [query, setQuery] = useState("");
  /** Answer of the geocoder, kept with the text it answers. */
  const [answer, setAnswer] = useState<{
    text: string;
    results: NominatimResult[];
    failed: boolean;
  } | null>(null);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  /** Enter was pressed before the results came back: take the first one. */
  const takeFirst = useRef(false);

  const text = query.trim();
  useEffect(() => {
    if (text.length < 3) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      let results: NominatimResult[] = [],
        failed = false;
      try {
        const response = await fetch(
          `/api/geocode?q=${encodeURIComponent(text)}`,
          { signal: abort.signal },
        );
        if (!response.ok) throw new Error();
        const data = await response.json();
        // The geocoder can return the same place twice.
        const seen = new Set<number>();
        results = (
          Array.isArray(data) ? (data as NominatimResult[]) : []
        ).filter(
          (result) => !seen.has(result.place_id) && seen.add(result.place_id),
        );
      } catch {
        if (abort.signal.aborted) return;
        failed = true;
      }
      if (takeFirst.current && results[0]) {
        takeFirst.current = false;
        setQuery("");
        setAnswer(null);
        flyTo(results[0]);
        return;
      }
      takeFirst.current = false;
      setActive(0);
      setAnswer({ text, results, failed });
    }, 350);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [text]);

  const current = answer?.text === text ? answer : null;
  const searching = text.length >= 3 && !current;
  // The list only shows while the field is in use: late results must never
  // open on top of the buttons below once the user has moved on.
  const visible = focused && current ? current.results : [];
  const choose = (result: NominatimResult) => {
    setQuery("");
    setAnswer(null);
    flyTo(result);
  };

  return (
    <div className="relative">
      <input
        aria-label="Rechercher une ville ou un lieu"
        placeholder="Rechercher une ville, un quartier…"
        className="w-full rounded-lg border border-line bg-white py-2 pr-9 pl-3 placeholder:text-muted"
        value={query}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          takeFirst.current = false;
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && visible.length) {
            event.preventDefault();
            setActive((active + 1) % visible.length);
          } else if (event.key === "ArrowUp" && visible.length) {
            event.preventDefault();
            setActive((active - 1 + visible.length) % visible.length);
          } else if (event.key === "Enter") {
            if (visible[active]) choose(visible[active]);
            else if (searching) takeFirst.current = true;
          } else if (event.key === "Escape") setQuery("");
        }}
      />
      {searching ? (
        <span
          className="absolute top-2.5 right-3 h-4 w-4 rounded-full border-2 border-line border-t-green"
          style={{ animation: "spin 0.8s linear infinite" }}
          role="status"
          aria-label="Recherche en cours"
        />
      ) : null}
      {visible.length ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-white shadow-lg">
          {visible.map((result, index) => (
            <li key={result.place_id}>
              <button
                className={`block w-full px-3 py-2 text-left text-[13px] hover:bg-panel ${index === active ? "bg-panel" : ""}`}
                // Keep the focus in the field so the list stays open until
                // the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(result)}
              >
                {result.display_name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {current && !current.results.length ? (
        <p className="mt-1 text-xs text-muted" role="status">
          {current.failed
            ? "Recherche indisponible : déplacez la carte à la main."
            : "Aucun lieu trouvé."}
        </p>
      ) : null}
    </div>
  );
}
