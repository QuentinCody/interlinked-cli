// The supervisor owns the application and fronts it with its recording proxy;
// INTERLINKED_E2E_BASE_URL is that proxy. The reporter and worker count are
// forced by the supervisor's command line, not configured here.
import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "tests",
    retries: 0,
    use: { baseURL: process.env.INTERLINKED_E2E_BASE_URL, headless: true },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
