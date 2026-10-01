import { describe, expect, it } from "bun:test";
import {
  publicUrl,
  isPublicAddress,
  boundedBody,
} from "../shared/network/policy";
import { resolveDestination, safeFetch } from "../shared/network/server";

describe("untrusted merchant transport", () => {
  it("rejects credentials, private address encodings, non-HTTPS and local names", () => {
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://127.1",
      "https://2130706433",
      "https://[::ffff:127.0.0.1]",
      "https://[::1]",
      "https://169.254.169.254/latest",
      "https://10.0.0.1",
      "https://localhost.",
      "https://service.internal.",
      "https://example.com:444",
    ])
      expect(() => publicUrl(url)).toThrow();
    expect(publicUrl("https://example.com/path").hostname).toBe("example.com");
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
  });
  it("rejects mixed public/private DNS answers before opening a socket", async () => {
    await expect(
      resolveDestination(
        new URL("https://merchant.example"),
        new AbortController().signal,
        async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      ),
    ).rejects.toThrow("private");
    await expect(safeFetch("https://127.0.0.1/")).rejects.toThrow(
      "public HTTPS",
    );
  });
  it("bounds slow DNS by the caller deadline", async () => {
    await expect(
      resolveDestination(
        new URL("https://example.com"),
        AbortSignal.timeout(10),
        () => new Promise(() => undefined),
      ),
    ).rejects.toThrow();
  });
  it("cancels oversized bodies without trusting Content-Length", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(9));
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-length": "1" } },
    );
    await expect(boundedBody(response, 8)).rejects.toThrow("size limit");
    expect(canceled).toBe(true);
    expect(await boundedBody(new Response("okay"), 4)).toEqual(
      new TextEncoder().encode("okay"),
    );
  });
});
