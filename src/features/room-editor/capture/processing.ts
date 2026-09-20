import type { SavedRoom } from "../../../../shared/capture/roomplan";
import type { TexturedScan } from "../../../../shared/capture/texture";

type ImportResult = { kind: "import"; saved: SavedRoom; scan: TexturedScan };
type ExportResult = { kind: "export"; bytes: ArrayBuffer };
async function process(
  blob: Blob,
  saved?: SavedRoom,
  signal?: AbortSignal,
): Promise<ImportResult | ExportResult> {
  signal?.throwIfAborted();
  const bytes = await blob.arrayBuffer();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan.worker.ts", import.meta.url), {
      type: "module",
    });
    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Scan processing canceled.", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Scan processing took too long. Try a smaller scan."));
    }, 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = () => {
      cleanup();
      reject(
        new Error(
          "Could not start scan processing. Reload and try importing again.",
        ),
      );
    };
    worker.onmessage = (
      event: MessageEvent<
        ImportResult | ExportResult | { kind: "error"; message: string }
      >,
    ) => {
      cleanup();
      if (event.data.kind === "error") reject(new Error(event.data.message));
      else resolve(event.data);
    };
    worker.postMessage(
      saved ? { kind: "export", bytes, saved } : { kind: "import", bytes },
      [bytes],
    );
  });
}
export async function processScan(blob: Blob, signal?: AbortSignal) {
  const result = await process(blob, undefined, signal);
  if (result.kind !== "import") throw new Error("Unexpected scan result.");
  return result;
}
export async function downloadScan(blob: Blob, saved: SavedRoom) {
  const result = await process(blob, saved);
  if (result.kind !== "export") throw new Error("Unexpected export result.");
  return new Blob([result.bytes], { type: "application/zip" });
}
