import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1, // desktop specs share one live window
  webServer: { command: "npm run dev", url: "http://localhost:1420", reuseExistingServer: true },
  use: { baseURL: "http://localhost:1420" },
});
