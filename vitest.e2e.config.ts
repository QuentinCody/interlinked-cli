import { defineConfig } from "vitest/config";
import baseConfig, { E2E_EXCLUDE } from "./vitest.config";

export default defineConfig({
    ...baseConfig,
    test: {
        ...baseConfig.test,
        include: ["src/**/*.e2e.test.ts"],
        exclude: (baseConfig.test?.exclude ?? []).filter((pattern) => pattern !== E2E_EXCLUDE),
        pool: "forks",
        fileParallelism: false,
        testTimeout: 60_000,
        hookTimeout: 60_000,
        retry: 0,
        reporters: ["default", "./src/lib/viz/reporter-vitest.ts"],
    },
});
