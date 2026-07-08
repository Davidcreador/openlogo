import { type LogoDocument, parseDocument } from "@openlogo/core";

const DB_NAME = "openlogo";
const STORE_NAME = "documents";
const CURRENT_KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveDocument(document: LogoDocument): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(
      JSON.parse(JSON.stringify(document)),
      CURRENT_KEY,
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadDocument(): Promise<LogoDocument | null> {
  const db = await openDatabase();
  const data = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(CURRENT_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();

  if (!data) {
    return null;
  }

  try {
    return parseDocument(data);
  } catch (error) {
    console.warn("Stored document failed validation; starting fresh.", error);
    return null;
  }
}

export function createAutosave(
  getDocument: () => LogoDocument,
  delayMs = 800,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void saveDocument(getDocument()).catch((error) => {
        console.warn("Autosave failed", error);
      });
    }, delayMs);
  };
}
