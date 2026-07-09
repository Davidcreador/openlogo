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

  if (!data) {
    db.close();
    return null;
  }

  try {
    return parseDocument(data);
  } catch (error) {
    // Never destroy the user's data: the very next autosave overwrites
    // CURRENT_KEY, so park the rejected payload under a backup key first.
    const backupKey = `backup-${new Date().toISOString()}`;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(data, backupKey);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      console.warn(
        `Stored document failed validation; it was preserved in IndexedDB ("${DB_NAME}" › "${STORE_NAME}" › "${backupKey}") and a fresh document was started.`,
        error,
      );
    } catch (backupError) {
      console.warn("Stored document failed validation AND could not be backed up.", error, backupError);
    }
    return null;
  } finally {
    db.close();
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
