import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleFile, warnPacket } from "../harness/packets/fixtures.js";
import { createFixture, type E2eFixture } from "./fixture.js";

it("delivers released text once per session when the CLI hook has no daemon", async () => {
    const fixture = await createFixture();
    try {
        await fixture.stopDaemon();
        const text = "Inspect one bounded page of results.";
        const release = { text, released_at: "2026-01-01T00:00:00Z", span_hash: createHash("sha256").update(text).digest("hex") };
        fixture.file(".interlinked/instruction-packets.json", JSON.stringify(sampleFile([warnPacket({ release })])));
        const start = await fixture.hook({ cold: true, runtime: "entry", sessionId: "cold-first", event: "SessionStart" });
        expect(start.receipt.outcome).toBe("cold");
        expect(start.stdout).toContain(text);
        const after = (sessionId: string) => fixture.hook({ cold: true, runtime: "entry", sessionId, event: "PostToolUse",
            tool: "Read", input: { file_path: "README.md" }, payload: { tool_response: "read complete" } });
        const newSession = await after("cold-second");
        expect(newSession.receipt.outcome).toBe("cold");
        expect(newSession.stdout).toContain(text);
        expect((await after("cold-second")).stdout).not.toContain(text);
        expect((await after("cold-first")).stdout).not.toContain(text);
    } finally { await fixture.close(); }
});

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
        if (runtime === "generated") {
            expect(result.stderr).toContain("standalone cold fallback has no AST oracle");
            expect(result.stderr).toContain("[interlinked:file-size:not-measured]");
        }
        else expect(result.stderr).toContain("advisory");
    });
});
