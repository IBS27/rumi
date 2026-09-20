import { expect, test } from "bun:test";
import { downloadCapture } from "../src/features/room-import/downloadCapture";
import { syntheticCaptureZip } from "./fixtures/capture-package";
import { readPackage } from "../shared/capture/package";
import { MAX_SCAN_BYTES } from "../shared/capture/pairing";

test("phone downloads preserve the full package for the existing importer", async () => {
  const bytes = syntheticCaptureZip();
  const updates: number[] = [];
  const response = new Response(bytes, {
    headers: { "Content-Length": String(bytes.length) },
  });
  const file = await downloadCapture(
    response,
    "zip",
    new AbortController().signal,
    (n) => updates.push(n),
  );
  expect(file.name).toEndWith(".zip");
  expect(file.type).toBe("application/zip");
  expect(updates.at(-1)).toBe(bytes.length);
  const received = new Uint8Array(await file.arrayBuffer());
  expect(received).toEqual(bytes);
  expect(readPackage(received).manifest.meshes.length).toBe(1);
});

test("phone download rejects oversized declarations, truncated bodies and canceled reads", async () => {
  const signal = new AbortController().signal;
  await expect(
    downloadCapture(
      new Response("x", {
        headers: { "Content-Length": String(MAX_SCAN_BYTES + 1) },
      }),
      "zip",
      signal,
      () => {},
    ),
  ).rejects.toThrow("size limit");
  await expect(
    downloadCapture(
      new Response("x", { headers: { "Content-Length": "2" } }),
      "zip",
      signal,
      () => {},
    ),
  ).rejects.toThrow("incomplete");
  const abort = new AbortController();
  const pending = downloadCapture(
    new Response(new ReadableStream({ start() {} })),
    "zip",
    abort.signal,
    () => {},
  );
  abort.abort();
  await expect(pending).rejects.toThrow();
});

test("old phone layout uploads remain importable JSON files", async () => {
  const file = await downloadCapture(
    new Response('{"walls":[]}'),
    "json",
    new AbortController().signal,
    () => {},
  );
  expect(file.name).toEndWith(".json");
  expect(await file.text()).toBe('{"walls":[]}');
});
