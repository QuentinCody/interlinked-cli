import { expect, it } from "vitest";
import { laneFromConfig, testLaneOf } from "./test-lane.js";

// test-contract: public-api — the integration config is a named lane, not "unknown"
it("labels the integration vitest config as the integration lane", () => {
    expect(laneFromConfig("/repo/vitest.integration.config.ts")).toBe("integration");
});

// test-contract: invariant — a direct vitest run with the integration config records the integration lane
it("records a vitest run with --config vitest.integration.config.ts as integration", () => {
    expect(testLaneOf("npx vitest run --config vitest.integration.config.ts")).toBe("integration");
});
