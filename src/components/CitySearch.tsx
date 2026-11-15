"use client";
import { useEffect, useRef, useState } from "react";
import type { NominatimResult } from "@/types/osm";
import { useAppStore } from "@/store/app-store";

export function CitySearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [message, setMessage] = useState("");
  const [active, setActive] = useState(0);
  const flyId = useRef(0);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 3) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/geocode?q=${encodeURIComponent(text)}`,
          {
            signal: abort.signal,
          },
        );
        if (!response.ok) throw new Error();
        const data = await response.json();
        const list = Array.isArray(data) ? (data as NominatimResult[]) : [];
        setResults(list);
        setActive(0);
        setMessage(list.length ? "" : "Aucun lieu trouvé.");
      } catch {
        if (!abort.signal.aborted)
          setMessage("Recherche indisponible : déplacez la carte à la main.");
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query]);

  const choose = (result: NominatimResult) => {
    setQuery("");
    setResults([]);
    setMessage("");
    useAppStore.getState().set({
      flyTo: {
        lat: Number(result.lat),
        lng: Number(result.lon),
        id: ++flyId.current,
      },
    });
    useAppStore.getState().set({ view: "map" });
  };
  const visible = query.trim().length >= 3 ? results : [];

  return (
    <div className="relative">
      <input
        aria-label="Rechercher une ville ou un lieu"
        placeholder="Rechercher une ville, un quartier…"
        className="w-full rounded-lg border border-line bg-white px-3 py-2 placeholder:text-muted"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setResults([]);
          setMessage("");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && visible.length) {
            event.preventDefault();
            setActive((active + 1) % visible.length);
          } else if (event.key === "ArrowUp" && visible.length) {
            event.preventDefault();
            setActive((active - 1 + visible.length) % visible.length);
          } else if (event.key === "Enter" && visible[active])
            choose(visible[active]);
          else if (event.key === "Escape") setQuery("");
        }}
      />
      {visible.length ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-white shadow-lg">
          {visible.map((result, index) => (
            <li key={result.place_id}>
              <button
                className={`block w-full px-3 py-2 text-left text-[13px] hover:bg-panel ${index === active ? "bg-panel" : ""}`}
                onClick={() => choose(result)}
              >
                {result.display_name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {message && query.trim().length >= 3 ? (
        <p className="mt-1 text-xs text-muted" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
