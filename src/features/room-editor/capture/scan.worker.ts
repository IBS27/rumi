import { exportPackage, readPackage } from "../../../../shared/capture/package";
import { textureCapture } from "../../../../shared/capture/texture";
import type { SavedRoom } from "../../../../shared/capture/roomplan";

type Request =
  | { kind: "import"; bytes: ArrayBuffer }
  | { kind: "export"; bytes: ArrayBuffer; saved: SavedRoom };
self.onmessage = (event: MessageEvent<Request>) => {
  try {
    const request = event.data;
    const bytes = new Uint8Array(request.bytes);
    if (request.kind === "export") {
      const result = exportPackage(bytes, request.saved);
      self.postMessage(
        { kind: "export", bytes: result.buffer },
        { transfer: [result.buffer] },
      );
      return;
    }
    const capture = readPackage(bytes);
    const scan = textureCapture(capture);
    // ZIP entries share their parent archive's buffer. Copy photos before transferring.
    scan.images = scan.images.map((image) => ({
      ...image,
      bytes: image.bytes.slice(),
    }));
    const transfer: ArrayBuffer[] = scan.batches.flatMap((batch) => [
      batch.positions.buffer as ArrayBuffer,
      batch.uvs.buffer as ArrayBuffer,
    ]);
    transfer.push(
      ...scan.images.map((image) => image.bytes.buffer as ArrayBuffer),
    );
    self.postMessage(
      { kind: "import", saved: capture.saved, scan },
      { transfer },
    );
  } catch (error) {
    self.postMessage({
      kind: "error",
      message:
        error instanceof Error ? error.message : "Could not process this scan.",
    });
  }
};
