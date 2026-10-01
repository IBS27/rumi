import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { importRoomPlan, roomPlanSchema } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { FILE_CHUNK_BYTES } from "../shared/files";
import {
  saveWorkspaceFiles,
  uploadFile,
  type PublishedSource,
} from "../src/features/workspace/cloudFiles";
import type { Workspace } from "../src/features/workspace/sessions";
import { hashToken } from "../shared/capture/pairing";

// Publishing through the real browser helper and HTTP upload handlers.
const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/projects.ts": () => import("../convex/projects"),
  "../convex/files.ts": () => import("../convex/files"),
  "../convex/http.ts": () => import("../convex/http"),
};
const site = "https://test.convex.site";
const originalFetch = globalThis.fetch;
const originalSite = process.env.CONVEX_SITE_URL;
let t: ReturnType<typeof convexTest>;
// Set to fail a specific upload request, counted from 1.
let failUpload: number | undefined;
let uploads = 0;
beforeEach(() => {
  process.env.CONVEX_SITE_URL = site;
  t = convexTest(schema, modules);
  failUpload = undefined;
  uploads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== site) throw new Error(`Unexpected fetch: ${url}`);
    if (url.pathname === "/files/upload" && ++uploads === failUpload)
      throw new TypeError("Network connection lost");
    const { signal: _signal, ...rest } = init ?? {};
    void _signal;
    return t.fetch(url.pathname + url.search, rest);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSite === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = originalSite;
});

const room = importRoomPlan(syntheticRoomPlan, "Saved room", true);
const scanId = "c".repeat(32);
const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  format: "rumi.room",
  version: 1,
  room,
  original: roomPlanSchema.passthrough().parse(syntheticRoomPlan),
  ...overrides,
});
const scanBlob = () => new Blob([new Uint8Array(FILE_CHUNK_BYTES * 2 + 10)]);

async function savedProject() {
  const owner = t.withIdentity({ tokenIdentifier: "test|owner" });
  const projectId = await owner.mutation(api.projects.create, {
    title: "Saved room",
    room,
  });
  const begin = (args: {
    projectId: Id<"projects">;
    kind: "workspace" | "scan";
    size: number;
  }) => owner.mutation(api.files.begin, args);
  const publish = (
    args: Parameters<typeof owner.mutation<typeof api.files.publish>>[1],
  ) => owner.mutation(api.files.publish, args);
  const save = (
    next: Workspace,
    options: Partial<Parameters<typeof saveWorkspaceFiles>[4]> = {},
  ) =>
    saveWorkspaceFiles(projectId, next, begin, publish, {
      loadScan: async () => scanBlob(),
      withoutScan: "remove",
      ...options,
    });
  await save(workspace({ scanId }), { published: { generation: 0 } });
  const state = () =>
    t.run(async (ctx) => {
      const project = (await ctx.db.get(projectId))!;
      const current = (await ctx.db.get(project.roomId!))!.snapshot;
      const scan = project.scanFileId
        ? await ctx.db.get(project.scanFileId)
        : null;
      return {
        roomId: current.id,
        revision: current.revision,
        workspaceFileId: project.workspaceFileId,
        scanFileId: project.scanFileId,
        source: {
          roomId: project.sourceRoomId,
          scanId: project.sourceScanId,
          generation: project.sourceGeneration,
        },
        scanBlobs: scan
          ? await Promise.all(
              scan.chunks.map(
                async (chunk: Id<"_storage">) =>
                  (await ctx.storage.get(chunk)) !== null,
              ),
            )
          : [],
      };
    });
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await t.finishInProgressScheduledFunctions();
    }
  };
  const published = async (): Promise<PublishedSource> => {
    const { source } = await state();
    return { ...source, generation: source.generation ?? 0 };
  };
  return { owner, projectId, begin, publish, save, state, settle, published };
}

describe("publishing a source pair", () => {
  it("never lets a source without a scan discard the saved scan for its room", async () => {
    const app = await savedProject();
    const before = await app.state();
    expect(before.source).toEqual({ roomId: room.id, scanId, generation: 1 });
    expect(before.scanBlobs).toEqual([true, true, true]);

    // The pre-release migration helper uploaded the workspace and published
    // it with no scan argument at all.
    const legacy = workspace();
    const blob = new Blob([JSON.stringify(legacy)]);
    const upload = await app.begin({
      projectId: app.projectId,
      kind: "workspace",
      size: blob.size,
    });
    await uploadFile(blob, upload);
    await expect(
      app.publish({
        projectId: app.projectId,
        workspaceFileId: upload.fileId,
        roomId: room.id,
      }),
    ).rejects.toThrow("SCAN_WOULD_BE_LOST");
    // The current helper with migration intent refuses the same downgrade.
    await expect(
      app.save(workspace(), {
        published: await app.published(),
        withoutScan: "preserve",
      }),
    ).rejects.toThrow("SCAN_WOULD_BE_LOST");
    await app.settle();
    expect(await app.state()).toEqual(before);
  });

  it("keeps, replaces or deliberately removes the scan", async () => {
    const app = await savedProject();
    const before = await app.state();
    // Same room and scan: keep it without uploading or reloading it.
    await app.save(workspace({ scanId, reconstructionObjectIds: ["lamp"] }), {
      published: await app.published(),
      loadScan: async () => {
        throw new Error("An unchanged scan must not be reloaded.");
      },
    });
    const kept = await app.state();
    expect(kept.scanFileId).toBe(before.scanFileId);
    expect(kept.workspaceFileId).not.toBe(before.workspaceFileId);
    expect(kept.source.generation).toBe(2);

    // A different scan for the same room replaces the old one.
    const newScan = "d".repeat(32);
    await app.save(workspace({ scanId: newScan }), {
      published: await app.published(),
    });
    await app.settle();
    const replaced = await app.state();
    expect(replaced.scanFileId).not.toBe(before.scanFileId);
    expect(replaced.source.scanId).toBe(newScan);
    expect(await t.run((ctx) => ctx.db.get(before.scanFileId!))).toBeNull();

    // An explicit JSON-only save removes it.
    await app.save(workspace(), {
      published: await app.published(),
      withoutScan: "remove",
    });
    await app.settle();
    const removed = await app.state();
    expect(removed.scanFileId).toBeUndefined();
    expect(removed.source.scanId).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(replaced.scanFileId!))).toBeNull();
  });

  it("binds a kept scan to its recorded room, scan and generation", async () => {
    const app = await savedProject();
    const before = await app.state();
    const blob = new Blob(["{}"]);
    const upload = await app.begin({
      projectId: app.projectId,
      kind: "workspace",
      size: blob.size,
    });
    await uploadFile(blob, upload);
    const keep = (keepScanId: string, expectedGeneration = 1) =>
      app.publish({
        projectId: app.projectId,
        workspaceFileId: upload.fileId,
        roomId: room.id,
        scan: { action: "keep", scanId: keepScanId },
        expectedGeneration,
      });
    await expect(keep("e".repeat(32))).rejects.toThrow("does not match");
    await expect(keep(scanId, 0)).rejects.toThrow("another tab");
    await app.settle();
    expect(await app.state()).toEqual(before);
    // A retry of the same save after a lost response is fenced the same way.
    await keep(scanId);
    await expect(keep(scanId)).rejects.toThrow("another tab");
  });

  it("rejects files that belong to another owner or project", async () => {
    const app = await savedProject();
    const other = t.withIdentity({ tokenIdentifier: "test|other" });
    const otherProject = await other.mutation(api.projects.create, {
      title: "Other",
      room,
    });
    const foreign = await other.mutation(api.files.begin, {
      projectId: otherProject,
      kind: "scan",
      size: 3,
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["abc"])),
    );
    await t.mutation(internal.files.append, {
      fileId: foreign.fileId,
      tokenHash: await hashToken(foreign.token),
      index: 0,
      storageId,
    });
    const before = await app.state();
    const blob = new Blob(["{}"]);
    const upload = await app.begin({
      projectId: app.projectId,
      kind: "workspace",
      size: blob.size,
    });
    await uploadFile(blob, upload);
    await expect(
      app.publish({
        projectId: app.projectId,
        workspaceFileId: upload.fileId,
        roomId: room.id,
        scan: { action: "replace", fileId: foreign.fileId, scanId },
        expectedGeneration: 1,
      }),
    ).rejects.toThrow("incomplete");
    await expect(
      other.mutation(api.files.publish, {
        projectId: app.projectId,
        workspaceFileId: upload.fileId,
        roomId: room.id,
      }),
    ).rejects.toThrow("not found");
    expect(await app.state()).toEqual(before);
  });

  describe("replacing the room", () => {
    const newRoom = { ...room, id: "new-room", name: "Replacement room" };
    const replacement = () =>
      workspace({ room: newRoom, scanId: "f".repeat(32) });

    it("leaves the previous room and source when an upload fails", async () => {
      const app = await savedProject();
      const before = await app.state();
      const options = async () => ({
        published: await app.published(),
        room: { expectedRevision: before.revision },
      });
      // Before any upload starts.
      await expect(
        saveWorkspaceFiles(
          app.projectId,
          replacement(),
          async () => {
            throw new Error("Upload service unavailable");
          },
          app.publish,
          {
            ...(await options()),
            loadScan: async () => scanBlob(),
            withoutScan: "remove",
          },
        ),
      ).rejects.toThrow("Upload service unavailable");
      // Midway through the three-chunk scan.
      uploads = 0;
      failUpload = 3;
      await expect(app.save(replacement(), await options())).rejects.toThrow(
        "Network connection lost",
      );
      failUpload = undefined;
      await app.settle();
      expect(await app.state()).toEqual(before);
    });

    it("rejects the publish after a concurrent room edit", async () => {
      const app = await savedProject();
      const before = await app.state();
      const stale = {
        published: await app.published(),
        room: { expectedRevision: before.revision },
      };
      await app.owner.mutation(api.projects.attachRoom, {
        projectId: app.projectId,
        room: { ...room, name: "Renamed elsewhere" },
        expectedRevision: before.revision,
      });
      const edited = await app.state();
      await expect(app.save(replacement(), stale)).rejects.toThrow("changed");
      await app.settle();
      expect(await app.state()).toEqual(edited);
    });

    it("commits the room and its source together", async () => {
      const app = await savedProject();
      const before = await app.state();
      await app.save(replacement(), {
        published: await app.published(),
        room: { expectedRevision: before.revision },
      });
      await app.settle();
      const after = await app.state();
      expect(after.roomId).toBe("new-room");
      expect(after.revision).toBe(before.revision + 1);
      expect(after.source).toEqual({
        roomId: "new-room",
        scanId: "f".repeat(32),
        generation: 2,
      });
      expect(after.scanFileId).not.toBe(before.scanFileId);
      expect(await t.run((ctx) => ctx.db.get(before.scanFileId!))).toBeNull();
    });
  });
});
