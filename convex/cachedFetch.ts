"use node";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { safeFetch } from "../shared/network/server";
import { boundedBody, publicUrl } from "../shared/network/policy";
import { digest } from "../shared/catalog/identity";
import { z } from "zod";
const cachedResponse = z.object({
  url: z.string(),
  contentType: z.string(),
  text: z.string(),
});

/** Five-minute public merchant cache. Ranking and private room data never enter it. */
export function cachedFetch(ctx: ActionCtx): typeof safeFetch {
  return async (input, init) => {
    if (input instanceof Request || (init?.method && init.method !== "GET"))
      return safeFetch(input, init);
    const url = publicUrl(String(input)).toString();
    const key = digest(
      JSON.stringify([url, new Headers(init?.headers).get("accept"), 1]),
    );
    const token = crypto.randomUUID();
    for (let wait = 0; wait < 20; wait++) {
      init?.signal?.throwIfAborted();
      const entry = await ctx.runMutation(internal.sourceCache.acquire, {
        key,
        token,
      });
      if (entry.storageId) {
        const blob = await ctx.storage.get(entry.storageId);
        if (blob) {
          const record = cachedResponse.parse(JSON.parse(await blob.text()));
          const response = new Response(record.text, {
            headers: { "content-type": record.contentType },
          });
          Object.defineProperty(response, "url", { value: record.url });
          return response;
        }
      }
      if (!entry.acquired) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      try {
        const response = await safeFetch(url, init);
        const contentType = response.headers.get("content-type") ?? "";
        if (
          !response.ok ||
          !/text\/html|application\/(json|xhtml\+xml)/i.test(contentType)
        )
          return response;
        const text = new TextDecoder().decode(
          await boundedBody(response, 2 * 1024 * 1024),
        );
        const storageId = await ctx.storage.store(
          new Blob(
            [JSON.stringify({ url: response.url || url, contentType, text })],
            { type: "application/x-rumi-public-cache" },
          ),
        );
        try {
          await ctx.runMutation(internal.sourceCache.finish, {
            key,
            token,
            storageId,
          });
        } catch (error) {
          await ctx.storage.delete(storageId);
          throw error;
        }
        const result = new Response(text, {
          headers: { "content-type": contentType },
        });
        Object.defineProperty(result, "url", { value: response.url || url });
        return result;
      } finally {
        await ctx.runMutation(internal.sourceCache.finish, { key, token });
      }
    }
    throw new Error("The merchant page is still loading. Retry shortly.");
  };
}
