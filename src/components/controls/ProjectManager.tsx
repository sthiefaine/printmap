"use client";
import { useEffect, useRef, useState } from "react";
import { useSceneStore } from "@/store/use-scene-store";
import { useMapStore } from "@/store/use-map-store";
import { downloadBlob } from "@/lib/export/download";
import { useAssemblyStore } from "@/store/use-assembly-store";
export function ProjectManager() {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  useEffect(() => {
    if (!message || isError) return;
    const timer = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(timer);
  }, [message, isError]);
  const save = () => {
    const assembly = useAssemblyStore.getState().project;
    if (assembly) {
      downloadBlob(
        new Blob(
          [
            JSON.stringify(
              { kind: "assembly-project", version: 1, project: assembly },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
        `printmap-${assembly.id}.printmap.json`,
      );
      setIsError(false);
      setMessage(
        "Plan enregistré. Les données des plaques restent dans ce navigateur ; sauvegardez-les plaque par plaque.",
      );
      return;
    }
    const { bbox, selectedCity, osmData, elevationGrid, report, isDemo } =
      useMapStore.getState();
    const name = selectedCity?.name.split(",")[0] || "printmap-projet";
    const json = useSceneStore
      .getState()
      .saveProject(
        { bbox, selectedCity, osmData, elevationGrid, report, isDemo },
        name,
      );
    downloadBlob(
      new Blob([json], { type: "application/json" }),
      `${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.printmap.json`,
    );
    setIsError(false);
    setMessage("Projet enregistré avec sa zone et ses données.");
  };
  const load = async (file: File) => {
    setIsError(false);
    setMessage("");
    try {
      if (file.size > 100 * 1024 * 1024)
        throw new Error("Le fichier dépasse 100 Mo.");
      const text = await file.text();
      const content = JSON.parse(text);
      if (content?.kind === "assembly-project") {
        if (content.version !== 1)
          throw new Error("Version de plan non prise en charge.");
        await useAssemblyStore.getState().open(content.project);
        setMessage(
          "Plan restauré. Choisissez une plaque pour charger ses données.",
        );
        return;
      }
      if (content?.kind === "assembly-cell") {
        await useAssemblyStore.getState().importCell(content);
        setMessage("Données de cette plaque restaurées sans collecte.");
        return;
      }
      const snapshot = useSceneStore.getState().loadProject(text);
      if (useAssemblyStore.getState().project)
        useAssemblyStore.getState().close();
      if (snapshot) {
        await useMapStore.getState().importProject(snapshot);
        setMessage("Projet restauré, données disponibles hors ligne.");
      } else {
        useMapStore.getState().reset();
        setMessage(
          "Ancien projet : paramètres restaurés. Sélectionnez une zone pour récupérer ses données.",
        );
      }
    } catch (err) {
      setIsError(true);
      setMessage(
        err instanceof Error ? err.message : "Impossible de lire ce projet.",
      );
    }
  };
  return (
    <div className="project-manager">
      <button
        className="button button-quiet"
        onClick={() => input.current?.click()}
      >
        Ouvrir un projet
      </button>
      <button className="button button-quiet" onClick={save}>
        Enregistrer
      </button>
      <input
        ref={input}
        type="file"
        accept=".json"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void load(file);
        }}
      />
      {message ? (
        <p className="project-message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
