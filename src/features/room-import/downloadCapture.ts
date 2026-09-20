import {
  MAX_ROOM_BYTES,
  MAX_SCAN_BYTES,
} from "../../../shared/capture/pairing";

/** Bound downloads before allocating the ZIP or starting the import worker. */
export async function downloadCapture(
  response: Response,
  format: "json" | "zip",
  signal: AbortSignal,
  progress: (bytes: number, total: number | null) => void,
): Promise<File> {
  signal.throwIfAborted();
  if (!response.ok || !response.body)
    throw new Error("The uploaded scan could not be downloaded.");
  const maximum = format === "zip" ? MAX_SCAN_BYTES : MAX_ROOM_BYTES;
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > maximum)
    throw new Error("The uploaded scan exceeds its size limit.");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum)
        throw new Error("The uploaded scan exceeds its size limit.");
      parts.push(part.value.slice());
      progress(size, declared > 0 ? declared : null);
    }
    if (!size || (declared > 0 && declared !== size))
      throw new Error("The scan download was incomplete. Try again.");
    return new File(parts, `iPhone scan.${format}`, {
      type: format === "zip" ? "application/zip" : "application/json",
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
