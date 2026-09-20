import { describe, expect, it, spyOn } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import type { GenericDatabaseWriter, SystemDataModel } from "convex/server";
import { hashToken, scanContentType } from "../shared/capture/pairing";
import { syntheticCaptureZip } from "./fixtures/capture-package";
import { readPackage } from "../shared/capture/package";
import { syntheticRoomPlan } from "../shared/fixtures/roomplan";

const modules = {
  "../convex/_generated/server.js": () =>
    import("../convex/_generated/server.js"),
  "../convex/capturePackages.ts": () => import("../convex/capturePackages"),
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

describe("complete scan transfer", () => {
  async function scanSetup(bytes = syntheticCaptureZip()) {
    const context = await setup();
    const grant = (await (await context.claim()).json()) as {
      uploadToken: string;
      maxScanBytes: number;
    };
    const headers = {
      Authorization: `Bearer ${grant.uploadToken}`,
      "Content-Type": "application/json",
    };
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
    ).toString("base64");
    const body = {
      sessionId: context.session.sessionId,
      idempotencyKey: crypto.randomUUID(),
      digest,
      size: bytes.length,
    };
    const start = () =>
      context.t.fetch("/capture/v1/scan/start", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const complete = (storageId: string) =>
      context.t.fetch("/capture/v1/scan/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: body.sessionId,
          idempotencyKey: body.idempotencyKey,
          storageId,
        }),
      });
    const store = () =>
      context.t.run(async (ctx) => {
        const contentType = scanContentType(context.session.sessionId);
        const id = await ctx.storage.store(
          new Blob([bytes.slice().buffer], { type: contentType }),
        );
        // convex-test's storeBlob currently drops contentType. Reproduce the real
        // storage service metadata so expiry tests cover lost upload responses.
        const system =
          ctx.db as unknown as GenericDatabaseWriter<SystemDataModel>;
        await system.patch(id, { contentType });
        return id;
      });
    return { ...context, body, start, complete, store, grant, headers, bytes };
  }
  it("delivers all original geometry, photos and depth; retries never delete the accepted file", async () => {
    const c = await scanSetup();
    expect(c.grant.maxScanBytes).toBe(128 * 1024 * 1024);
    const ticket = await (await c.start()).json();
    expect(ticket.uploadUrl).toContain("/api/storage/upload");
    const storageId = await c.store();
    expect((await c.complete(storageId)).status).toBe(200);
    expect((await c.complete(storageId)).status).toBe(200);
    expect((await (await c.start()).json()).uploaded).toBe(true);
    const owner = c.t.withIdentity({ tokenIdentifier: "test|owner" });
    const result = await owner.query(api.captures.get, {
      sessionId: c.body.sessionId,
    });
    expect(result?.format).toBe("zip");
    expect(result?.fileUrl).toBeTruthy();
    const stored = await c.t.run(async (ctx) =>
      (await ctx.storage.get(storageId))!.arrayBuffer(),
    );
    expect(new Uint8Array(stored)).toEqual(c.bytes);
    expect(readPackage(new Uint8Array(stored)).manifest.frames).toHaveLength(1);
    await owner.mutation(api.captures.cancel, { sessionId: c.body.sessionId });
    expect(
      await c.t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null),
    ).toBe(true);
    expect(
      await c.t
        .withIdentity({ tokenIdentifier: "test|other" })
        .query(api.captures.get, { sessionId: c.body.sessionId }),
    ).toBeNull();
  });
  it("resumes validation after attaching a file without uploading it again", async () => {
    const c = await scanSetup();
    await c.start();
    const storageId = await c.store();
    await c.t.mutation(internal.captures.attachScanUpload, {
      sessionId: c.body.sessionId,
      uploadHash: await hashToken(c.grant.uploadToken),
      idempotencyKey: c.body.idempotencyKey,
      storageId,
    });
    expect(await (await c.start()).json()).toEqual({
      uploaded: false,
      uploadUrl: null,
      contentType: scanContentType(c.body.sessionId),
      storageId,
    });
    expect((await c.complete(storageId)).status).toBe(200);
  });
  it("rejects malformed packages and leaves the browser waiting for a valid scan", async () => {
    const c = await scanSetup(new TextEncoder().encode("not a scan ZIP"));
    await c.start();
    const storageId = await c.store();
    expect((await c.complete(storageId)).status).toBe(422);
    const result = await c.t
      .withIdentity({ tokenIdentifier: "test|owner" })
      .query(api.captures.get, { sessionId: c.body.sessionId });
    expect(result?.state).toBe("paired");
    expect(result?.fileUrl).toBeNull();
  });
  it("rejects content substitution, stale files and changed retry keys without deleting unowned files", async () => {
    const c = await scanSetup();
    const old = await c.store();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await c.start();
    expect((await c.complete(old)).status).toBe(422);
    const wrong = await c.t.run((ctx) =>
      ctx.storage.store(
        new Blob(["wrong content"], { type: "application/zip" }),
      ),
    );
    expect((await c.complete(wrong)).status).toBe(422);
    expect(
      await c.t.run(async (ctx) => (await ctx.storage.get(wrong)) !== null),
    ).toBe(true);
    c.body.idempotencyKey = crypto.randomUUID();
    expect((await c.start()).status).toBe(409);
  });
  it("rejects oversized, unauthorized and canceled uploads", async () => {
    const c = await scanSetup();
    c.body.size = 128 * 1024 * 1024 + 1;
    expect((await c.start()).status).toBe(400);
    c.body.size = c.bytes.length;
    c.headers.Authorization = `Bearer ${"c".repeat(64)}`;
    expect((await c.start()).status).toBe(401);
    c.headers.Authorization = `Bearer ${c.grant.uploadToken}`;
    await c.start();
    const storageId = await c.store();
    await c.t
      .withIdentity({ tokenIdentifier: "test|owner" })
      .mutation(api.captures.cancel, { sessionId: c.body.sessionId });
    expect((await c.complete(storageId)).status).toBe(410);
  });
  it("expires accepted scans and unregistered uploads without deleting unrelated files", async () => {
    const c = await scanSetup();
    await c.start();
    const storageId = await c.store();
    await c.complete(storageId);
    const orphan = await c.store();
    const unrelated = await c.t.run((ctx) =>
      ctx.storage.store(new Blob(["unrelated"], { type: "application/zip" })),
    );
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60 * 1000);
    try {
      await c.t.mutation(internal.captures.removeExpired, {
        sessionId: c.body.sessionId,
      });
    } finally {
      clock.mockRestore();
    }
    expect(await c.t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
    expect(await c.t.run((ctx) => ctx.storage.get(orphan))).toBeNull();
    expect(
      await c.t.run(async (ctx) => (await ctx.storage.get(unrelated)) !== null),
    ).toBe(true);
  });
});
