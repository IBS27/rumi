import { exportPackage, readPackage } from "../../../../shared/capture/package";
import { blendCapture } from "../../../../shared/capture/texture-atlas";
import type { SavedRoom } from "../../../../shared/capture/roomplan";
import { buildReconstructionEvidence } from "../../../../shared/reconstruction/evidence";
import type { ReconstructionInput } from "../../../../shared/reconstruction/contracts";

type Request =
  | { kind: "import"; bytes: ArrayBuffer }
  | { kind: "export"; bytes: ArrayBuffer; saved: SavedRoom };
self.onmessage = async (event: MessageEvent<Request>) => {
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
    let evidence: ReconstructionInput | undefined;
    let evidenceError: string | undefined;
    try {
      evidence = await buildReconstructionEvidence(
        capture,
        async (bytes, frame) => {
          const scale = Math.min(1, 1024 / Math.max(frame.width, frame.height));
          const bitmap = await createImageBitmap(
            new Blob([bytes.slice().buffer], { type: "image/jpeg" }),
            {
              resizeWidth: Math.max(1, Math.round(frame.width * scale)),
              resizeHeight: Math.max(1, Math.round(frame.height * scale)),
              resizeQuality: "high",
            },
          );
          try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Photo processing is unavailable.");
            context.drawImage(bitmap, 0, 0);
            const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
            const blob = await canvas.convertToBlob({
              type: "image/jpeg",
              quality: 0.8,
            });
            const data = new Uint8Array(await blob.arrayBuffer());
            let binary = "";
            for (let i = 0; i < data.length; i += 8192)
              binary += String.fromCharCode(...data.subarray(i, i + 8192));
            canvas.width = canvas.height = 0;
            return {
              jpeg: btoa(binary),
              width: bitmap.width,
              height: bitmap.height,
              pixels: { data: pixels.data, width: pixels.width, height: pixels.height },
            };
          } finally {
            bitmap.close();
          }
        },
      );
    } catch (error) {
      // A reconstruction problem must not destroy a valid measured scan.
      evidenceError =
        error instanceof Error
          ? error.message
          : "Could not prepare room reconstruction.";
    }
    const frames = new Map(
      capture.manifest.frames.map((frame) => [frame.image, frame]),
    );
    const scan = await blendCapture(
      capture,
      async (name, thumbnail) => {
        const frame = frames.get(name);
        if (!frame) throw new Error("A surface references a missing photo.");
        const scale = Math.min(1, 128 / Math.max(frame.width, frame.height));
        const bitmap = await createImageBitmap(
          new Blob([capture.files[name].slice().buffer], {
            type: "image/jpeg",
          }),
          thumbnail
            ? {
                resizeWidth: Math.max(1, Math.round(frame.width * scale)),
                resizeHeight: Math.max(1, Math.round(frame.height * scale)),
                resizeQuality: "high",
              }
            : {},
        );
        try {
          if (
            !thumbnail &&
            (bitmap.width !== frame.width || bitmap.height !== frame.height)
          )
            throw new Error(
              "A scan photo does not match its camera calibration.",
            );
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context)
            throw new Error("Photo processing is unavailable in this browser.");
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            bitmap.width,
            bitmap.height,
          );
          canvas.width = canvas.height = 0;
          return pixels;
        } finally {
          bitmap.close();
        }
      },
      async (pixels) => {
        const canvas = new OffscreenCanvas(pixels.width, pixels.height);
        const context = canvas.getContext("2d");
        if (!context)
          throw new Error("Texture processing is unavailable in this browser.");
        context.putImageData(
          new ImageData(
            new Uint8ClampedArray(pixels.data),
            pixels.width,
            pixels.height,
          ),
          0,
          0,
        );
        const blob = await canvas.convertToBlob({ type: "image/png" });
        canvas.width = canvas.height = 0;
        return new Uint8Array(await blob.arrayBuffer());
      },
    );
    const transfer: ArrayBuffer[] = scan.batches.flatMap((batch) => [
      batch.positions.buffer as ArrayBuffer,
      batch.uvs.buffer as ArrayBuffer,
    ]);
    transfer.push(
      ...scan.images.map((image) => image.bytes.buffer as ArrayBuffer),
    );
    self.postMessage(
      { kind: "import", saved: capture.saved, scan, evidence, evidenceError },
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
