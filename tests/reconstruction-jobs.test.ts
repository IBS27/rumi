import { describe, expect, it } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";

import { buildReconstructionEvidence } from "../shared/reconstruction/evidence";
import { readPackage } from "../shared/capture/package";
import { syntheticCaptureZip } from "./fixtures/capture-package";

const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/roomReconstruction.ts": () =>
    import("../convex/roomReconstruction"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const inputId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["{}"], { type: "application/json" })),
  );
  const args = {
    ownerId: "test|owner",
    digest: "a".repeat(64),
    inputId,
    total: 4,
  };
  const { id } = await t.mutation(internal.roomReconstruction.enqueue, args);
  return {
    t,
    id,
    args,
    owner: t.withIdentity({ tokenIdentifier: "test|owner" }),
  };
}
describe("reconstruction jobs", () => {
  it("finalizes a resumed job directly from persisted models without calling the provider", async () => {
    const t = convexTest(schema, modules);
    const input = await buildReconstructionEvidence(
      readPackage(syntheticCaptureZip()),
      async () => ({ jpeg: "/9j/2Q==", width: 32, height: 32 }),
    );
    const plan = {
      surfaces: [],
      notes: [],
      discoveredObjects: [],
      objects: input.room.objects.map((object) => ({
        objectId: object.id,
        description: "Observed furniture",
        photoIndices: [0],
      })),
    };
    const objects = input.room.objects.map((object) => ({
      objectId: object.id,
      label: object.name,
      confidence: 0.8,
      parts: [
        {
          id: "body",
          name: "Body",
          shape: "box",
          position: { x: 0, y: 0.5, z: 0 },
          size: { x: 1, y: 1, z: 1 },
          rotation: { x: 0, y: 0, z: 0 },
          color: "#987654",
          material: "wood",
        },
      ],
    }));
    const id = await t.run(async (ctx) => {
      const store = (value: unknown) =>
        ctx.storage.store(
          new Blob([JSON.stringify(value)], { type: "application/json" }),
        );
      return ctx.db.insert("roomReconstructions", {
        ownerId: "test|owner",
        digest: "resume",
        inputId: await store(input),
        planId: await store(plan),
        batches: [
          {
            storageId: await store(objects),
            objectIds: objects.map((object) => object.objectId),
          },
        ],
        stage: "queued",
        attempt: 2,
        step: 0,
        completed: objects.length,
        total: objects.length,
      });
    });
    await t.action(internal.roomReconstruction.run, { id, attempt: 2 });
    const result = await t
      .withIdentity({ tokenIdentifier: "test|owner" })
      .query(api.roomReconstruction.get, { id });
    expect(result?.stage).toBe("ready");
    expect(JSON.parse(result!.sceneJson!).objects).toHaveLength(objects.length);
    expect(result?.completed).toBe(objects.length);
  });
  it("checkpoints batches, fences old deadlines, and resumes after timeout", async () => {
    const { t, id, owner } = await setup();
    const stage = { id, attempt: 1 };
    const store = () => t.run((ctx) => ctx.storage.store(new Blob(["{}"])));
    expect(
      await t.mutation(internal.roomReconstruction.claim, stage),
    ).not.toBeNull();
    expect(
      await t.mutation(internal.roomReconstruction.claim, stage),
    ).toBeNull();
    const planId = await store();
    await t.mutation(internal.roomReconstruction.checkpoint, {
      ...stage,
      storageId: planId,
      total: 24,
    });
    await t.mutation(internal.roomReconstruction.continueJob, stage);
    await t.mutation(internal.roomReconstruction.expire, stage);
    expect((await owner.query(api.roomReconstruction.get, { id }))?.stage).toBe(
      "queued",
    );
    const next = { ...stage, step: 1 };
    expect(
      await t.mutation(internal.roomReconstruction.claim, next),
    ).toMatchObject({ planId, batchIds: [] });
    const storageId = await store();
    await t.mutation(internal.roomReconstruction.checkpoint, {
      ...next,
      storageId,
      objectIds: ["bed", "table", "chair"],
    });
    const duplicateId = await store();
    await t.mutation(internal.roomReconstruction.checkpoint, {
      ...next,
      storageId: duplicateId,
      objectIds: ["bed"],
    });
    expect(await t.run((ctx) => ctx.storage.get(duplicateId))).toBeNull();
    await t.mutation(internal.roomReconstruction.expire, next);
    await owner.mutation(api.roomReconstruction.retry, { id });
    expect(await owner.query(api.roomReconstruction.get, { id })).toMatchObject(
      { completed: 3, total: 24, stage: "queued", attempt: 2 },
    );
    expect(
      await t.mutation(internal.roomReconstruction.claim, { id, attempt: 2 }),
    ).toMatchObject({ planId, batchIds: [storageId] });
    const stale = await store();
    await t.mutation(internal.roomReconstruction.checkpoint, {
      ...next,
      storageId: stale,
      objectIds: ["lamp"],
    });
    expect(await t.run((ctx) => ctx.storage.get(stale))).toBeNull();
    await t.mutation(internal.roomReconstruction.continueJob, next);
    await t.mutation(internal.roomReconstruction.expire, next);
    expect((await owner.query(api.roomReconstruction.get, { id }))?.stage).toBe(
      "modeling",
    );
  });
  it("requires authentication and denies another owner's reads and retries", async () => {
    const { t, id } = await setup();
    await expect(t.query(api.roomReconstruction.get, { id })).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    const other = t.withIdentity({ tokenIdentifier: "test|other" });
    expect(await other.query(api.roomReconstruction.get, { id })).toBeNull();
    await expect(
      other.mutation(api.roomReconstruction.retry, { id }),
    ).rejects.toThrow("not found");
    await expect(
      t.action(api.roomReconstruction.start, { inputJson: "{}" }),
    ).rejects.toThrow("UNAUTHENTICATED");
  });
  it("deduplicates repeated imports and retains completed results", async () => {
    const { t, id, args, owner } = await setup();
    expect(await t.mutation(internal.roomReconstruction.enqueue, args)).toEqual(
      { id, created: false },
    );
    await t.mutation(internal.roomReconstruction.update, {
      id,
      attempt: 1,
      stage: "ready",
      sceneJson: '{"version":1}',
      completed: 4,
    });
    await t.mutation(internal.roomReconstruction.expire, { id, attempt: 1 });
    expect((await owner.query(api.roomReconstruction.get, { id }))?.stage).toBe(
      "ready",
    );
    expect(
      await t.query(internal.roomReconstruction.find, {
        ownerId: args.ownerId,
        digest: args.digest,
      }),
    ).toBe(id);
  });
  it("times out stuck jobs and ignores stale completions after a retry", async () => {
    const { t, id, owner } = await setup();
    await t.mutation(internal.roomReconstruction.expire, { id, attempt: 1 });
    expect((await owner.query(api.roomReconstruction.get, { id }))?.stage).toBe(
      "failed",
    );
    await owner.mutation(api.roomReconstruction.retry, { id });
    await t.mutation(internal.roomReconstruction.update, {
      id,
      attempt: 1,
      stage: "ready",
      sceneJson: "stale",
    });
    await t.mutation(internal.roomReconstruction.expire, { id, attempt: 1 });
    expect(await owner.query(api.roomReconstruction.get, { id })).toMatchObject(
      { stage: "queued", attempt: 2, sceneJson: null },
    );
    await t.mutation(internal.roomReconstruction.update, {
      id,
      attempt: 2,
      stage: "modeling",
      completed: 3,
    });
    expect(
      (await owner.query(api.roomReconstruction.get, { id }))?.completed,
    ).toBe(3);
  });
  it("bounds concurrent generation and failed retries", async () => {
    const { t, id, args, owner } = await setup();
    await t.mutation(internal.roomReconstruction.enqueue, {
      ...args,
      digest: "b".repeat(64),
    });
    await expect(
      t.mutation(internal.roomReconstruction.enqueue, {
        ...args,
        digest: "c".repeat(64),
      }),
    ).rejects.toThrow("Two rooms");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await t.mutation(internal.roomReconstruction.expire, { id, attempt });
      if (attempt < 3)
        await owner.mutation(api.roomReconstruction.retry, { id });
    }
    await expect(
      owner.mutation(api.roomReconstruction.retry, { id }),
    ).rejects.toThrow("three times");
  });
  it("applies the active-room limit to retries too", async () => {
    const { t, id, args, owner } = await setup();
    await t.mutation(internal.roomReconstruction.expire, { id, attempt: 1 });
    await t.mutation(internal.roomReconstruction.enqueue, {
      ...args,
      digest: "b".repeat(64),
    });
    await t.mutation(internal.roomReconstruction.enqueue, {
      ...args,
      digest: "c".repeat(64),
    });
    await expect(
      owner.mutation(api.roomReconstruction.retry, { id }),
    ).rejects.toThrow("Two rooms");
    expect(
      (await owner.query(api.roomReconstruction.get, { id }))?.attempt,
    ).toBe(1);
  });
});
