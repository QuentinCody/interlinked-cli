import { describe, expect, it } from "vitest";
import { testLaneOf, laneFromConfig } from "./test-lane.js";

describe("test lane evidence", () => {
    it.each([
        ["npm run test:e2e -- --run", "e2e"], ["npx vitest run --config vitest.e2e.config.ts", "e2e"],
        ["npm run test:e2e:coverage", "e2e"],
        ["npm run test:unit", "unit"], ["npm run test:integration", "integration"],
        ["npm test", "base"], ["npx vitest run", "base"],
        ["echo 'npm run test:e2e'", "unknown"], ["cat vitest.e2e.config.ts", "unknown"],
        ["npx vitest --config custom.config.ts", "unknown"],
    ])("%s records %s", (command, expected) => expect(testLaneOf(command)).toBe(expected));
    it("labels the reporter from its resolved config", () => {
        expect(laneFromConfig("/repo/vitest.e2e.config.ts")).toBe("e2e");
        expect(laneFromConfig("/repo/vitest.config.ts")).toBe("base");
        expect(laneFromConfig(undefined)).toBe("unknown");
    });
});
