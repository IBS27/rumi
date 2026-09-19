import { describe, expect, it } from "bun:test";
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
