import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { request } from "node:https";
import { isPublicAddress, publicUrl } from "./policy";

/** Node-only ingestion transport. DNS is resolved once, checked, then pinned to the socket. */
export const safeFetch: (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> = async (input, init = {}) => {
  if (input instanceof Request)
    throw new Error("Pass a URL to the ingestion transport.");
  if (init.method && init.method !== "GET" && init.method !== "HEAD")
    throw new Error("Ingestion only supports read requests.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(15000),
    ...(init.signal ? [init.signal] : []),
  ]);
  let url = publicUrl(String(input));
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    const addresses = await resolveDestination(url, signal);
    signal.throwIfAborted();
    const target =
      addresses.find((address) => address.family === 4) ?? addresses[0];
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    // No caller-controlled Host, credentials, or compression. TLS verifies the original hostname.
    for (const key of [
      "host",
      "authorization",
      "cookie",
      "proxy-authorization",
      "accept-encoding",
    ])
      delete headers[key];
    const response = await new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method: init.method ?? "GET",
          headers: { ...headers, "accept-encoding": "identity" },
          signal,
          // We already chose a validated address; Node's family autoselection
          // otherwise asks lookup for an array instead of this pinned address.
          family: target.family,
          lookup: (_hostname, _options, callback) =>
            callback(null, target.address, target.family),
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined)
              responseHeaders.set(
                key,
                Array.isArray(value) ? value.join(", ") : value,
              );
          const status = res.statusCode ?? 502;
          if ([301, 302, 303, 307, 308].includes(status)) {
            res.destroy();
            resolve(new Response(null, { status, headers: responseHeaders }));
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          const limit = 5 * 1024 * 1024;
          if (Number(responseHeaders.get("content-length")) > limit) {
            res.destroy();
            reject(new Error("Response exceeds its size limit."));
            return;
          }
          res.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > limit) {
              res.destroy(new Error("Response exceeds its size limit."));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const body =
              [204, 205, 304].includes(status) || init.method === "HEAD"
                ? null
                : new Uint8Array(Buffer.concat(chunks));
            const result = new Response(body, {
              status,
              headers: responseHeaders,
            });
            Object.defineProperty(result, "url", { value: url.toString() });
            resolve(result);
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location)
      return response;
    url = publicUrl(new URL(location, url).toString());
  }
  throw new Error("Too many redirects.");
};

export async function resolveDestination(
  url: URL,
  signal: AbortSignal,
  resolver: (
    hostname: string,
    options: LookupAllOptions,
  ) => Promise<LookupAddress[]> = lookup,
) {
  signal.throwIfAborted();
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    resolver(url.hostname.replace(/^\[|\]$/g, ""), {
      all: true,
      verbatim: true,
    })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
  const all = Array.isArray(addresses) ? addresses : [addresses];
  if (!all.length || all.some(({ address }) => !isPublicAddress(address)))
    throw new Error(
      "The destination resolves to a private or reserved address.",
    );
  return all;
}
