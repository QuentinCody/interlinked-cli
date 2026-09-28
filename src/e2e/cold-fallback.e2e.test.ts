import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe.each(["entry", "generated"] as const)("%s cold fallback", (runtime) => {
    let fixture: E2eFixture;
    beforeAll(async () => {
        fixture = await createFixture({ rules: { graph_prediction: { enabled: true } } });
        await fixture.stopDaemon();
    });
    afterAll(async () => { await fixture?.close(); });
    it.each([
        ["Bash", { command: "rm -rf /" }],
        ["Bash", { command: "npm install unapproved-e2e-package@1.0.0" }],
        ["Write", { file_path: "src/conflict.ts", content: "<<<<<<< ours\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> theirs\n" }],
    ] as const)("blocks %s while recording cold provenance", async (tool, input) => {
        const result = await fixture.hook({ runtime, cold: true, tool, input });
        expect(result.receipt.outcome).toBe("cold");
        expect(result.fellBack).toBe(true);
        expect(result.stdout).toContain('"deny"');
    });
    it("fails closed for a fresh graph sidecar", async () => {
        const file_path = fixture.graphSource("cold");
        const result = await fixture.hook({ runtime, cold: true, tool: "Edit", input: { file_path, old_string: "SENTINEL_OLD", new_string: "SENTINEL_NEW" } });
        expect(result.receipt.outcome).toBe("cold");
        expect(result.stdout).toContain('"deny"');
        expect(result.stdout).toMatch(/offline|unavailable|graph/i);
    });
    it("keeps physical size advisory and reports missing standalone guard evidence", async () => {
        const result = await fixture.hook({ runtime, cold: true, tool: "Write", input: {
            file_path: "src/large.ts", content: "export const value = 1;\n".repeat(700),
        } });
        expect(result.receipt.outcome).toBe("cold");
        expect(result.stdout).not.toContain('"deny"');
        if (runtime === "generated") expect(result.stderr).toContain("standalone cold fallback has no AST oracle");
        else expect(result.stderr).toContain("advisory");
    });
});
