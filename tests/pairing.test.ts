import { describe, expect, it } from "bun:test";
import type { GenericMutationCtx, GenericDataModel } from "convex/server";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { hashToken } from "../shared/capture/pairing";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";

const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/captures.ts": () => import("../convex/captures"),
  "../convex/http.ts": () => import("../convex/http"),
};
async function setup() {
  const t = convexTest(schema, modules);
  const pairingToken = "a".repeat(64);
  const session = await t.mutation(internal.captures.reserve, {
    ownerId: "test|owner",
    pairingHash: await hashToken(pairingToken),
  });
  const claimId = crypto.randomUUID();
  const claim = () =>
    t.fetch("/capture/v1/claim", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pairingToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: session.sessionId, claimId }),
    });
  return { t, session, pairingToken, claimId, claim };
}

describe("capture pairing", () => {
  it("requires an authenticated web owner to create and read a session", async () => {
    const { t, session } = await setup();
    await expect(t.action(api.captures.create, {})).rejects.toThrow(
      "UNAUTHENTICATED",
    );
    expect(
      await t.query(api.captures.get, { sessionId: session.sessionId }),
    ).toBeNull();
    expect(
      await t
        .withIdentity({ tokenIdentifier: "test|other" })
        .query(api.captures.get, { sessionId: session.sessionId }),
    ).toBeNull();
    const own = await t
      .withIdentity({ tokenIdentifier: "test|owner" })
      .query(api.captures.get, { sessionId: session.sessionId });
    expect(own?.state).toBe("waiting");
    expect(own).not.toHaveProperty("pairingHash");
  });
  it("makes claiming single-use while allowing an identical retry", async () => {
    const { t, session, pairingToken, claim } = await setup();
    const first = await claim();
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(await (await claim()).json()).toEqual(body);
    const other = await t.fetch("/capture/v1/claim", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pairingToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        claimId: crypto.randomUUID(),
      }),
    });
    expect(other.status).toBe(409);
  });
  it("uploads raw JSON, retries without replacing it, and hides it from another user", async () => {
    const { t, session, claim } = await setup();
    const { uploadToken } = (await (await claim()).json()) as {
      uploadToken: string;
    };
    const key = crypto.randomUUID();
    const send = (body: string, idempotencyKey = key) =>
      t.fetch(`/capture/v1/room?sessionId=${session.sessionId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body,
      });
    expect((await send("{}")).status).toBe(422);
    const text = JSON.stringify(syntheticRoomPlan);
    expect((await send(text)).status).toBe(200);
    const firstStorage = await t.run(
      async (ctx) => (await ctx.db.get(session.sessionId))?.storageId,
    );
    expect((await send(text)).status).toBe(200);
    expect(
      await t.run(
        async (ctx) => (await ctx.db.get(session.sessionId))?.storageId,
      ),
    ).toBe(firstStorage);
    expect((await send(text, crypto.randomUUID())).status).toBe(409);
    expect(
      await t
        .withIdentity({ tokenIdentifier: "test|other" })
        .query(api.captures.get, { sessionId: session.sessionId }),
    ).toBeNull();
    const own = await t
      .withIdentity({ tokenIdentifier: "test|owner" })
      .query(api.captures.get, { sessionId: session.sessionId });
    expect(own?.state).toBe("uploaded");
    const stored = await t.run(async (ctx) =>
      (await ctx.storage.get(firstStorage!))?.text(),
    );
    expect(stored).toBe(text);
  });
  it("preserves an accepted upload when closing races the web subscription", async () => {
    const { t, session, claim } = await setup();
    const { uploadToken } = (await (await claim()).json()) as {
      uploadToken: string;
    };
    const response = await t.fetch(
      `/capture/v1/room?sessionId=${session.sessionId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(syntheticRoomPlan),
      },
    );
    expect(response.status).toBe(200);
    const owner = t.withIdentity({ tokenIdentifier: "test|owner" });
    await owner.mutation(api.captures.cancel, { sessionId: session.sessionId });
    const accepted = await owner.query(api.captures.get, {
      sessionId: session.sessionId,
    });
    expect(accepted?.state).toBe("uploaded");
    expect(accepted?.fileUrl).toBeTruthy();
    const stored = await t.run(async (ctx) => {
      const capture = await ctx.db.get(session.sessionId);
      return capture?.storageId
        ? (await ctx.storage.get(capture.storageId))?.text()
        : null;
    });
    expect(stored).toBe(JSON.stringify(syntheticRoomPlan));
  });
  it("rejects expired and canceled capabilities", async () => {
    const { t, session, claim } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(session.sessionId, {
        pairingExpiresAt: Date.now() - 1,
      });
    });
    expect((await claim()).status).toBe(410);
    const next = await setup();
    const { uploadToken } = (await (await next.claim()).json()) as {
      uploadToken: string;
    };
    await next.t
      .withIdentity({ tokenIdentifier: "test|owner" })
      .mutation(api.captures.cancel, { sessionId: next.session.sessionId });
    const result = await next.t.fetch(
      `/capture/v1/room?sessionId=${next.session.sessionId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(syntheticRoomPlan),
      },
    );
    expect(result.status).toBe(410);
  });
  it("rejects unauthorized requests before accepting scan data", async () => {
    const { t, session } = await setup();
    const result = await t.fetch(
      `/capture/v1/room?sessionId=${session.sessionId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"b".repeat(64)}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(syntheticRoomPlan),
      },
    );
    expect(result.status).toBe(401);
  });
});

describe("detailed scan transfer", () => {
  async function packageSession() {
    const setupResult = await setup();
    const grant = (await (await setupResult.claim()).json()) as {
      uploadToken: string;
      maxPackageBytes: number;
    };
    const key = crypto.randomUUID();
    const call = (step: string, fields: Record<string, string> = {}) =>
      setupResult.t.fetch(`/capture/v1/package/${step}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grant.uploadToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: setupResult.session.sessionId,
          idempotencyKey: key,
          ...fields,
        }),
      });
    const start = await call("begin");
    expect(start.status).toBe(200);
    const ticket = (await start.json()) as {
      contentType: string;
      uploadUrl: string;
      maxBytes: number;
    };
    const store = (blob: Blob, size = blob.size) =>
      setupResult.t.run(async (ctx) => {
        const id = await ctx.storage.store(blob);
        // convex-test 0.0.59 omits contentType in storage metadata. Simulate the
        // metadata the real upload endpoint writes; application code stays strict.
        await (ctx as GenericMutationCtx<GenericDataModel>).db.patch(id, {
          contentType: blob.type,
          size,
        });
        return id;
      });
    return { ...setupResult, call, ticket, grant, store };
  }
  it("transfers a ZIP, preserves accepted files on retry, and exposes format only to the owner", async () => {
    const { t, session, call, ticket, grant, store } = await packageSession();
    expect(grant.maxPackageBytes).toBe(128 * 1024 * 1024);
    const { syntheticCaptureZip } = await import("./fixtures/capture-package");
    const blob = new Blob([syntheticCaptureZip().slice().buffer], {
      type: ticket.contentType,
    });
    const storageId = await store(blob);
    expect((await call("complete", { storageId })).status).toBe(200);
    expect((await call("complete", { storageId })).status).toBe(200);
    expect(
      await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null),
    ).toBe(true);
    const repeated = (await (await call("begin")).json()) as {
      uploaded: boolean;
      uploadUrl: string | null;
    };
    expect(repeated).toMatchObject({ uploaded: true, uploadUrl: null });
    const copy = await store(blob);
    expect((await call("complete", { storageId: copy })).status).toBe(200);
    expect(
      await t.run(async (ctx) => (await ctx.storage.get(copy)) !== null),
    ).toBe(false);
    const owner = t.withIdentity({ tokenIdentifier: "test|owner" });
    await owner.mutation(api.captures.cancel, { sessionId: session.sessionId });
    const accepted = await owner.query(api.captures.get, {
      sessionId: session.sessionId,
    });
    expect(accepted?.format).toBe("zip");
    expect(accepted?.fileUrl).toBeTruthy();
    expect(accepted).not.toHaveProperty("packageContentType");
    expect(
      await t.query(api.captures.get, { sessionId: session.sessionId }),
    ).toBeNull();
  });
  it("rejects other storage objects without reading or deleting them", async () => {
    const { t, call } = await packageSession();
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["private"], { type: "application/zip" })),
    );
    expect((await call("complete", { storageId })).status).toBe(422);
    expect(
      await t.run(async (ctx) => (await ctx.storage.get(storageId))?.text()),
    ).toBe("private");
    expect((await call("complete", { storageId: "invalid" })).status).toBe(422);
  });
  it("rejects canceled, oversized, changed-key and changed-payload transfers", async () => {
    const { t, call, ticket, session, store } = await packageSession();
    expect(
      (await call("begin", { idempotencyKey: crypto.randomUUID() })).status,
    ).toBe(409);
    const oversized = await store(
      new Blob(["first"], { type: ticket.contentType }),
      129 * 1024 * 1024,
    );
    expect((await call("complete", { storageId: oversized })).status).toBe(413);
    const storageId = await store(
      new Blob(["first"], { type: ticket.contentType }),
    );
    expect((await call("complete", { storageId })).status).toBe(200);
    const other = await store(
      new Blob(["different"], { type: ticket.contentType }),
    );
    expect((await call("complete", { storageId: other })).status).toBe(409);
    await t.run((ctx) =>
      ctx.db.patch(session.sessionId, { state: "canceled" }),
    );
    expect((await call("begin")).status).toBe(410);
    expect((await call("complete", { storageId })).status).toBe(410);
  });
  it("removes abandoned scan uploads while retaining attached files and unrelated storage", async () => {
    const { t, call, ticket, store } = await packageSession();
    const attached = await store(
      new Blob(["scan"], { type: ticket.contentType }),
    );
    expect((await call("complete", { storageId: attached })).status).toBe(200);
    const abandoned = await store(
      new Blob(["scan"], { type: ticket.contentType }),
    );
    const unrelated = await t.run((ctx) =>
      ctx.storage.store(new Blob(["image"], { type: "image/jpeg" })),
    );
    await t.mutation(internal.captures.sweepPackages, {
      before: Date.now() + 1000,
    });
    expect(
      await t.run(async (ctx) => (await ctx.storage.get(abandoned)) !== null),
    ).toBe(false);
    expect(
      await t.run(async (ctx) => (await ctx.storage.get(attached)) !== null),
    ).toBe(true);
    expect(
      await t.run(async (ctx) => (await ctx.storage.get(unrelated)) !== null),
    ).toBe(true);
  });
});
