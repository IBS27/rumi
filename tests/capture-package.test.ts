import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { Matrix4, Vector3 } from "three";
import { exportPackage, readPackage } from "../shared/capture/package";
import { projectPoint, textureCapture } from "../shared/capture/texture";
import {
  identityMatrix,
  syntheticCaptureFiles,
  syntheticCaptureZip,
} from "./fixtures/capture-package";

function altered(
  change: (fixture: ReturnType<typeof syntheticCaptureFiles>) => void,
) {
  const fixture = syntheticCaptureFiles();
  change(fixture);
  fixture.files["manifest.json"] = strToU8(JSON.stringify(fixture.manifest));
  return zipSync(fixture.files, { level: 0 });
}
describe("single-scan package", () => {
  test("reads native STORE layout and projects a photograph without mirroring or flipping it", () => {
    const capture = readPackage(syntheticCaptureZip());
    const scan = textureCapture(capture);
    expect(
      capture.saved.room.shape === "polygon" &&
        capture.saved.room.capture.synthetic,
    ).toBe(true);
    expect(scan.faceCount).toBe(1);
    expect(scan.texturedFaceCount).toBe(1);
    expect([...scan.batches[0].uvs]).toEqual([
      0.25, 0.75, 0.75, 0.75, 0.5, 0.25,
    ]);
    expect(scan.images[0].bytes[0]).toBe(255);
  });
  test("occlusion, missing confidence and nonfinite depth leave surfaces untextured", () => {
    for (const variant of [
      "occluded",
      "uncertain",
      "nan",
      "missing",
    ] as const) {
      const bytes = altered(({ files, manifest }) => {
        if (variant === "occluded")
          files["depth.bin"] = new Uint8Array(
            new Float32Array(64).fill(1).buffer,
          );
        if (variant === "nan")
          files["depth.bin"] = new Uint8Array(
            new Float32Array(64).fill(NaN).buffer,
          );
        if (variant === "uncertain") files["confidence.bin"].fill(0);
        if (variant === "missing") manifest.frames = [];
      });
      const result = textureCapture(readPackage(bytes));
      expect(result.faceCount).toBe(1);
      expect(result.texturedFaceCount).toBe(0);
      expect(result.batches[0].image).toBeNull();
    }
  });
  test("applies mesh anchor transforms and the room's floor origin exactly once", () => {
    const capture = readPackage(syntheticCaptureZip());
    capture.manifest.meshes[0].transform[12] = 10;
    capture.manifest.frames[0].cameraTransform[12] += 10;
    const raw = capture.saved.original;
    for (const list of [
      raw.walls,
      raw.floors ?? [],
      raw.doors ?? [],
      raw.windows ?? [],
      raw.objects,
    ]) {
      for (const item of list) item.transform[12] += 10;
    }
    const result = textureCapture(capture);
    expect(result.texturedFaceCount).toBe(1);
    expect([...result.batches[0].positions]).toEqual([
      1, 0, 2, 3, 0, 2, 2, 2, 2,
    ]);
  });
  test("camera projection rejects points behind the camera and honors rotated poses", () => {
    const frame = syntheticCaptureFiles().manifest.frames[0];
    const inverse = new Matrix4().fromArray(frame.cameraTransform).invert();
    expect(projectPoint(new Vector3(2, 1, 5), frame, inverse)).toBeNull();
    expect(projectPoint(new Vector3(50, 1, 2), frame, inverse)).toBeNull();
    const pose = new Matrix4().makeRotationY(Math.PI / 2);
    frame.cameraTransform = pose.toArray();
    const point = new Vector3(0, 0, -2).applyMatrix4(pose);
    expect(projectPoint(point, frame, pose.clone().invert())).toEqual({
      u: 0.5,
      v: 0.5,
      depth: 2,
    });
  });
  test("retains raw capture and photos through editing, download and reimport", () => {
    const bytes = syntheticCaptureZip();
    const original = readPackage(bytes);
    const saved = structuredClone(original.saved);
    saved.room.objects[0].name = "My renamed sofa";
    saved.room.objects[0].position.x += 1;
    saved.room.revision++;
    const reopened = readPackage(exportPackage(bytes, saved));
    expect(reopened.saved.room.objects[0].name).toBe("My renamed sofa");
    expect(reopened.saved.original).toEqual(original.saved.original);
    expect(reopened.files["photo.jpg"]).toEqual(original.files["photo.jpg"]);
    expect(textureCapture(reopened).batches[0].positions).toEqual(
      textureCapture(original).batches[0].positions,
    );
  });
  test("rejects broken geometry, calibration, paths and package versions", () => {
    const variants: ((
      fixture: ReturnType<typeof syntheticCaptureFiles>,
    ) => void)[] = [
      ({ files }) => {
        files["mesh.bin"] = files["mesh.bin"].slice(1);
      },
      ({ files }) => {
        files["indices.bin"] = new Uint8Array(
          new Uint32Array([0, 1, 99]).buffer,
        );
      },
      ({ files }) => {
        files["mesh.bin"] = new Uint8Array(
          new Float32Array(9).fill(Infinity).buffer,
        );
      },
      ({ files }) => {
        files["../photo.jpg"] = files["photo.jpg"];
      },
      ({ files }) => {
        delete files["depth.bin"];
      },
      ({ files }) => {
        files["confidence.bin"].fill(255);
      },
      ({ manifest }) => {
        manifest.frames[0].cx = 500;
      },
      ({ manifest }) => {
        manifest.frames[0].width = 128;
      },
      ({ manifest }) => {
        manifest.frames.push(structuredClone(manifest.frames[0]));
      },
      ({ manifest }) => {
        manifest.meshes[0].transform[12] = 1e308;
      },
      ({ manifest }) => {
        manifest.frames[0].cameraTransform = [...identityMatrix].fill(1);
      },
      ({ manifest }) => {
        Object.assign(manifest, { version: 2 });
      },
    ];
    for (const variant of variants)
      expect(() => readPackage(altered(variant))).toThrow();
  });
  test("rejects oversized decompressed entries before allocating them", () => {
    const bytes = syntheticCaptureZip();
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length - 4; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 129 * 1024 * 1024, true);
        break;
      }
    }
    expect(() => readPackage(bytes)).toThrow("size limit");
  });
  test("rejects edits whose original geometry belongs to another capture", () => {
    const bytes = syntheticCaptureZip();
    const saved = readPackage(bytes).saved;
    saved.original.objects[0].dimensions[0] += 1;
    expect(() => exportPackage(bytes, saved)).toThrow("another room");
  });
});
