"use client";
import { useState, useRef, useEffect } from "react";
import type { NominatimResult } from "@/types/osm";
import { useMapStore } from "@/store/use-map-store";
export function CitySearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const select = (result: NominatimResult) => {
    controller.current?.abort();
    setQuery("");
    setResults([]);
    setError("");
    useMapStore.getState().setSelectedCity({
      name: result.display_name.split(",").slice(0, 2).join(","),
      lat: Number(result.lat),
      lng: Number(result.lon),
    });
  };
  useEffect(() => {
    controller.current?.abort();
    if (query.trim().length < 3) return;
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/geocode?q=${encodeURIComponent(query.trim())}`,
          { signal: abort.signal },
        );
        if (!res.ok)
          throw new Error(
            "Recherche indisponible. Utilisez la carte ou Montpellier.",
          );
        const data = await res.json();
        if (!abort.signal.aborted) {
          setResults(Array.isArray(data) ? data : []);
          setActive(0);
          setError(
            Array.isArray(data) && data.length === 0
              ? "Aucun lieu trouvé."
              : "",
          );
        }
      } catch (err) {
        if (!abort.signal.aborted)
          setError(
            err instanceof Error ? err.message : "Recherche indisponible.",
          );
      } finally {
        if (!abort.signal.aborted) setSearching(false);
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query]);
  const visibleResults = query.trim().length >= 3 ? results : [];
  return (
    <div className="city-search">
      <label htmlFor="city-search" className="field-label">
        Ville, quartier ou lieu
      </label>
      <div className="search-field">
        <span aria-hidden="true">⌕</span>
        <input
          id="city-search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visibleResults.length > 0}
          aria-controls="city-results"
          aria-activedescendant={
            visibleResults.length ? `city-result-${active}` : undefined
          }
          placeholder="Montpellier, Palavas-les-Flots…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setResults([]);
            setError("");
            setSearching(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && visibleResults.length) {
              e.preventDefault();
              setActive((active + 1) % visibleResults.length);
            }
            if (e.key === "ArrowUp" && visibleResults.length) {
              e.preventDefault();
              setActive(
                (active - 1 + visibleResults.length) % visibleResults.length,
              );
            }
            if (e.key === "Enter" && visibleResults[active]) {
              e.preventDefault();
              select(visibleResults[active]);
            }
            if (e.key === "Escape") {
              setQuery("");
              setResults([]);
            }
          }}
        />
        {searching ? (
          <span className="spinner small" aria-label="Recherche en cours" />
        ) : null}
      </div>
      {visibleResults.length ? (
        <ul id="city-results" role="listbox" className="search-results">
          {visibleResults.map((r, i) => (
            <li
              key={r.place_id}
              role="option"
              aria-selected={i === active}
              id={`city-result-${i}`}
            >
              <button
                className={i === active ? "active" : ""}
                onClick={() => select(r)}
              >
                {r.display_name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="field-hint" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
