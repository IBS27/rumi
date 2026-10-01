import { afterEach, beforeEach, expect, it } from "bun:test";
import { convexTest } from "convex-test";
import { v } from "convex/values";
import { internalAction } from "../convex/_generated/server";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { importRoomPlan, roomPlanSchema } from "../shared/capture/roomplan";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";
import { FILE_CHUNK_BYTES } from "../shared/files";
import {
  downloadFile,
  saveWorkspaceFiles,
} from "../src/features/workspace/cloudFiles";
import {
  workspaceSchema,
  type Workspace,
} from "../src/features/workspace/sessions";

// The browser client and the HTTP actions together: save on one device, then
// restore the room source and original scan with nothing cached locally.
const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/projects.ts": () => import("../convex/projects"),
  "../convex/messages.ts": () => import("../convex/messages"),
  "../convex/files.ts": () => import("../convex/files"),
  "../convex/http.ts": () => import("../convex/http"),
  "../convex/agent.ts": async () => ({
    runForProject: internalAction({
      args: { projectId: v.id("projects"), messageId: v.id("messages") },
      handler: async () => null,
    }),
  }),
};
const site = "https://test.convex.site";
const originalFetch = globalThis.fetch;
const originalSite = process.env.CONVEX_SITE_URL;
let t: ReturnType<typeof convexTest>;
beforeEach(() => {
  process.env.CONVEX_SITE_URL = site;
  t = convexTest(schema, modules);
  globalThis.fetch = (async (input: string | URL | Request, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== site) throw new Error(`Unexpected fetch: ${url}`);
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

it("restores a saved room source and multi-chunk scan on another device", async () => {
  const owner = t.withIdentity({ tokenIdentifier: "test|owner" });
  const room = importRoomPlan(syntheticRoomPlan, "Saved room", true);
  const projectId = await owner.mutation(api.projects.create, {
    title: "Saved room",
    room,
  });
  const workspace: Workspace = {
    format: "rumi.room",
    version: 1,
    room,
    original: roomPlanSchema.passthrough().parse(syntheticRoomPlan),
    scanId: "b".repeat(32),
    reconstructionObjectIds: ["photo-lamp"],
    cloudProjectId: projectId,
  };
  const scanBytes = new Uint8Array(FILE_CHUNK_BYTES * 2 + 1234);
  for (let i = 0; i < scanBytes.length; i += 4096) scanBytes[i] = i % 251;
  const scan = new Blob([scanBytes]);
  const begin = (
    args: Parameters<typeof owner.mutation<typeof api.files.begin>>[1],
  ) => owner.mutation(api.files.begin, args);
  const publish = (
    args: Parameters<typeof owner.mutation<typeof api.files.publish>>[1],
  ) => owner.mutation(api.files.publish, args);
  const first = await saveWorkspaceFiles(projectId, workspace, begin, publish, {
    loadScan: async () => scan,
    published: { generation: 0 },
    withoutScan: "remove",
  });
  expect(first.generation).toBe(1);

  // Another device has only the account session.
  const source = await owner.mutation(api.files.ticket, {
    projectId,
    kind: "workspace",
  });
  const restored = workspaceSchema.parse(
    JSON.parse(await (await downloadFile(source!)).text()),
  );
  // JSON stores -0 as 0; compare what was actually saved.
  const saved = JSON.parse(JSON.stringify(workspace)) as Workspace;
  expect(restored.room).toEqual(saved.room);
  expect(restored.original).toEqual(saved.original);
  expect(restored.reconstructionObjectIds).toEqual(["photo-lamp"]);
  const scanTicket = await owner.mutation(api.files.ticket, {
    projectId,
    kind: "scan",
  });
  expect(scanTicket?.chunks).toBe(3);
  const downloaded = new Uint8Array(
    await (await downloadFile(scanTicket!)).arrayBuffer(),
  );
  expect(downloaded).toEqual(scanBytes);

  // A metadata update reuses the saved scan instead of uploading it again.
  const scans = await t.run((ctx) => ctx.db.query("files").collect());
  await saveWorkspaceFiles(
    projectId,
    { ...workspace, reconstructionObjectIds: [] },
    begin,
    publish,
    {
      loadScan: async () => {
        throw new Error("An unchanged scan must not be reloaded.");
      },
      published: { roomId: room.id, scanId: workspace.scanId, generation: 1 },
      withoutScan: "remove",
    },
  );
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.finishInProgressScheduledFunctions();
  }
  const files = await t.run((ctx) => ctx.db.query("files").collect());
  expect(files).toHaveLength(2);
  expect(files.find((file) => file.kind === "scan")?._id).toBe(
    scans.find((file) => file.kind === "scan")?._id,
  );
  const latest = await owner.mutation(api.files.ticket, {
    projectId,
    kind: "workspace",
  });
  expect(
    workspaceSchema.parse(
      JSON.parse(await (await downloadFile(latest!)).text()),
    ).reconstructionObjectIds,
  ).toEqual([]);
});
