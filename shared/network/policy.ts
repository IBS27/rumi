import ipaddr from "ipaddr.js";

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address.replace(/^\[|\]$/g, ""));
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export function publicUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (!host.includes(".") && !ipaddr.isValid(host)) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
    (ipaddr.isValid(host) && !isPublicAddress(host))
  )
    throw new Error("Only public HTTPS destinations are allowed.");
  return url;
}

export async function boundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response exceeds its size limit.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("Response exceeds its size limit.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}
