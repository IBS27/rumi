import { z } from "zod";
import {
  idSchema,
  reservedZoneSchema,
  roomObjectSchema,
  vectorSchema,
} from "../contracts";

/** Explicit commands keep agent and pointer edits on the same transactional path. */
export const designCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    productId: idSchema,
    instanceId: idSchema,
    zone: reservedZoneSchema.optional(),
    position: vectorSchema.optional(),
    rotationY: z.number().finite().optional(),
    nearObjectId: idSchema.optional(),
  }),
  z.object({
    type: z.literal("arrange"),
    objectId: idSchema,
    nearObjectId: idSchema.optional(),
  }),
  z.object({
    type: z.literal("move"),
    objectId: idSchema,
    position: vectorSchema,
    rotationY: z.number().finite(),
  }),
  z.object({ type: z.literal("remove"), objectId: idSchema }),
  z.object({
    type: z.literal("replace"),
    objectId: idSchema,
    productId: idSchema,
  }),
  z.object({
    type: z.literal("lock"),
    objectId: idSchema,
    productLocked: z.boolean(),
    placementLocked: z.boolean(),
  }),
  // Scan correction is available to the user, never to the agent.
  z.object({ type: z.literal("correct"), object: roomObjectSchema }),
  z.object({ type: z.literal("discover"), object: roomObjectSchema }),
]);
export const designCommandsSchema = z.array(designCommandSchema).min(1).max(40);
export type DesignCommand = z.infer<typeof designCommandSchema>;
