import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const { RUMI_PREVIEW_HOST } = loadEnv(mode, process.cwd(), "RUMI_");
  const previewRedirect: Plugin = {
    name: "preview-host-redirect",
    configureServer(server) {
      if (!RUMI_PREVIEW_HOST) return;
      server.middlewares.use((request, response, next) => {
        const address = server.httpServer?.address();
        if (!address || typeof address === "string") return next();
        const host = address.address.includes(":")
          ? `[${address.address}]`
          : address.address;
        if (
          request.headers.host !== `${host}:${address.port}` ||
          (request.method !== "GET" && request.method !== "HEAD")
        )
          return next();
        const path = request.url?.startsWith("/") ? request.url : "/";
        response.writeHead(307, {
          Location: `http://${RUMI_PREVIEW_HOST}:${address.port}${path}`,
          "Cache-Control": "no-store",
        });
        response.end();
      });
    },
  };
  return {
    plugins: [react(), tailwindcss(), previewRedirect],
    server: {
      allowedHosts: RUMI_PREVIEW_HOST ? [RUMI_PREVIEW_HOST] : [],
    },
  };
});
