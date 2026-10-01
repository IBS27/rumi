import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/smoke.ts",
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:5175", trace: "retain-on-failure" },
  webServer: {
    command: "bun run dev --host 127.0.0.1 --port 5175 --strictPort",
    url: "http://127.0.0.1:5175",
    reuseExistingServer: false,
  },
});
