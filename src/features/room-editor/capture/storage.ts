const DATABASE = "rumi.scan-assets.v1";
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("scans");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Rumi tabs to save this scan."));
  });
}
export async function saveScan(identity: string, id: string, blob: Blob) {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("scans", "readwrite");
      transaction.objectStore("scans").put(blob, [identity, id]);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
export async function readScan(identity: string, id: string): Promise<Blob> {
  const db = await openDatabase();
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const request = db
        .transaction("scans", "readonly")
        .objectStore("scans")
        .get([identity, id]);
      request.onsuccess = () =>
        request.result instanceof Blob
          ? resolve(request.result)
          : reject(
              new Error(
                "The detailed scan is no longer stored in this browser. Import your scan ZIP again to restore it.",
              ),
            );
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
