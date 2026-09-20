import { v } from "convex/values";
import { z } from "zod";
import { zodToConvex } from "convex-helpers/server/zod4";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  briefSchema,
  roomSchema,
  proposalSchema,
  wantSchema,
  type RoomSnapshot,
} from "../shared/contracts";
import schema from "./schema";
import { applyProposal } from "../shared/geometry";

export const getRoom = internalQuery({
  returns: v.union(
    v.null(),
    v.object({
      ...schema.tables.rooms.validator.fields,
      _id: v.id("rooms"),
      _creationTime: v.number(),
    }),
  ),
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => await ctx.db.get(roomId),
});

export const patchBrief = internalMutation({
  returns: zodToConvex(briefSchema),
  args: {
    roomId: v.id("rooms"),
    prompt: v.optional(v.string()),
    styles: v.optional(v.array(v.string())),
    budgetCents: v.optional(v.number()),
    restrictions: v.optional(v.array(v.string())),
    palette: v.optional(v.array(v.string())),
    materials: v.optional(v.array(v.string())),
    wants: v.optional(zodToConvex(z.array(wantSchema))),
    inspiration: v.optional(v.string()),
  },
  handler: async (ctx, { roomId, ...patch }) => {
    const doc = await ctx.db.get(roomId);
    if (!doc) throw new Error("This room does not exist.");
    const brief = briefSchema.parse({
      ...doc.brief,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
    });
    await ctx.db.patch(roomId, { brief });
    return brief;
  },
});

export const applyDesignProposal = internalMutation({
  returns: zodToConvex(roomSchema),
  args: {
    roomId: v.id("rooms"),
    proposal: zodToConvex(proposalSchema),
  },
  handler: async (ctx, args): Promise<RoomSnapshot> => {
    const proposal = proposalSchema.parse(args.proposal);
    const doc = await ctx.db.get(args.roomId);
    if (!doc) throw new Error("This room does not exist.");
    const productIds = proposal.additions
      .map((object) => object.productId)
      .filter((id): id is string => id !== null);
    const products = await ctx.runQuery(internal.products.getByIds, {
      ids: productIds,
    });
    const next = applyProposal(
      doc.snapshot,
      proposal,
      products,
      briefSchema.parse(doc.brief),
    );
    await ctx.db.patch(doc._id, { snapshot: next });
    await ctx.db.insert("proposals", { ownerId: doc.ownerId, proposal });
    return next;
  },
});
