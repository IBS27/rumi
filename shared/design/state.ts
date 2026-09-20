import { z } from "zod";
import {
  assetSchema,
  briefSchema,
  productSchema,
  reservedZoneSchema,
  roomSchema,
} from "../contracts";

export const recommendationSchema = z.object({
  product: productSchema,
  zone: reservedZoneSchema.nullable(),
});
export const designStateSchema = z.object({
  room: roomSchema,
  brief: briefSchema,
  products: z.array(productSchema),
  assets: z.array(assetSchema),
  recommendations: z.array(recommendationSchema),
  canUndo: z.boolean(),
});
export type DesignState = z.infer<typeof designStateSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
