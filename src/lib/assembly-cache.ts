import type { MapDataResponse } from "@/types/osm";
import {
  cellKey,
  validateAssemblyCell,
  validateAssemblyData,
  validateAssemblyId,
  type AssemblyCell,
} from "@/lib/assembly-project";

const DATABASE = "printmap-assembly-v1",
  STORE = "cells";
let opening: Promise<IDBDatabase> | null = null;

/** Lazy browser access: importing this module is also safe during SSR. */
function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(
      new Error(
        "Le stockage local des plaques est indisponible dans ce navigateur.",
      ),
    );
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        opening = null;
        reject(error);
      }
    };
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            "Le stockage des plaques est bloqué. Fermez les anciens onglets puis réessayez.",
          ),
        ),
      10000,
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: ["projectId", "col", "row"],
        });
        store.createIndex("projectId", "projectId", { unique: false });
      }
    };
    request.onerror = () =>
      fail(
        new Error("Impossible d’ouvrir le stockage local des plaques.", {
          cause: request.error,
        }),
      );
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      db.onclose = () => {
        opening = null;
      };
      resolve(db);
    };
  });
  return opening;
}

function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, result: (value: T) => void) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const transaction = db.transaction(STORE, mode);
    let result: T;
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        /* The transaction has already settled. */
      }
    };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    transaction.oncomplete = () => {
      cleanup();
      resolve(result);
    };
    transaction.onerror = transaction.onabort = () => {
      cleanup();
      reject(
        signal?.aborted
          ? signal.reason
          : new Error(
              "Lecture ou sauvegarde de plaque impossible (stockage local indisponible ou plein).",
              { cause: transaction.error },
            ),
      );
    };
    try {
      operation(transaction.objectStore(STORE), (value) => {
        result = value;
      });
    } catch (error) {
      cleanup();
      abort();
      reject(error);
    }
  });
}

function key(projectId: string, cell: AssemblyCell): [string, number, number] {
  const position = validateAssemblyCell(cell);
  return [validateAssemblyId(projectId), position.col, position.row];
}

export async function readAssemblyCell(
  projectId: string,
  cell: AssemblyCell,
): Promise<MapDataResponse | null> {
  const id = key(projectId, cell),
    db = await database();
  const entry = await transact<{ data: unknown } | undefined>(
    db,
    "readonly",
    (store, result) => {
      const request = store.get(id);
      request.onsuccess = () => result(request.result);
    },
  );
  return entry ? validateAssemblyData(entry.data) : null;
}

export async function saveAssemblyCell(
  projectId: string,
  cell: AssemblyCell,
  data: MapDataResponse,
  signal?: AbortSignal,
): Promise<void> {
  const [id, col, row] = key(projectId, cell),
    validated = validateAssemblyData(data),
    db = await database();
  await transact<void>(
    db,
    "readwrite",
    (store) => {
      store.put({ projectId: id, col, row, data: validated });
    },
    signal,
  );
}

/** Query keys only: listing a project never materializes its large parcel data. */
export async function listAssemblyCells(projectId: string): Promise<string[]> {
  const id = validateAssemblyId(projectId),
    db = await database();
  const keys = await transact<IDBValidKey[]>(
    db,
    "readonly",
    (store, result) => {
      const request = store.index("projectId").getAllKeys(IDBKeyRange.only(id));
      request.onsuccess = () => result(request.result);
    },
  );
  return keys
    .map((value) => {
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== id)
        throw new Error("Index des plaques invalide.");
      return validateAssemblyCell({ col: value[1], row: value[2] });
    })
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map(cellKey);
}

export async function deleteAssemblyCell(
  projectId: string,
  cell: AssemblyCell,
): Promise<void> {
  const id = key(projectId, cell),
    db = await database();
  await transact<void>(db, "readwrite", (store) => {
    store.delete(id);
  });
}

export async function deleteAssemblyProjectCells(
  projectId: string,
): Promise<void> {
  const id = validateAssemblyId(projectId),
    db = await database();
  await transact<void>(db, "readwrite", (store) => {
    const request = store
      .index("projectId")
      .openKeyCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
}
