import { z } from "zod";

export const pairingPayloadSchema = z.object({
  type: z.literal("rumi.capture"),
  version: z.literal(1),
  baseUrl: z.url().refine((url) => new URL(url).protocol === "https:"),
  sessionId: z.string().min(1).max(200),
  pairingToken: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
});
export const claimBodySchema = z.object({
  sessionId: z.string().min(1).max(200),
  claimId: z.uuid(),
});
export const MAX_ROOM_BYTES = 10 * 1024 * 1024;
export const PAIRING_TTL = 10 * 60 * 1000;
export const UPLOAD_TTL = 60 * 60 * 1000;
export async function hashToken(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
