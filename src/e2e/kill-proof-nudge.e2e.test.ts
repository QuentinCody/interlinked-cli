import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isJsonObject } from "../lib/json-types.js";
import { createFixture, PROJECT_ROOT, type E2eFixture, type HookResult } from "./fixture.js";

// The PostToolUse `[interlinked:kill-proof]` nudge (evaluator/post-tool-kill-proof.ts)
// exists because Stop-time stderr is invisible to the model. This proves, through the
// built hook entry and a real daemon, that the nudge lands in the claude-code
// model-context channel (hookSpecificOutput.additionalContext on stdout), and that a
// fresh `killed` receipt from the real `tests prove-kill` command silences it.

const SOURCE = "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n";
const KILL_TEST = 'import { expect, it } from "vitest";\nimport { add } from "./x";\n\nit("adds", () => {\n\texpect(add(2, 3)).toBe(5);\n});\n';

function modelContext(result: HookResult): string {
    const line = result.stdout.trim();
    if (!line) return "";
    const parsed: unknown = JSON.parse(line);
    if (!isJsonObject(parsed) || !isJsonObject(parsed.hookSpecificOutput)) return "";
    const context = parsed.hookSpecificOutput.additionalContext;
    return typeof context === "string" ? context : "";
}

describe("kill-proof nudge through the real hook (claude-code)", () => {
    let fixture: E2eFixture;
    beforeAll(async () => {
        fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false } },
            prepare: (cwd) => symlinkSync(join(PROJECT_ROOT, "node_modules"), join(cwd, "node_modules")) });
        fixture.file("src/x.ts", SOURCE);
    }, 30_000);
    afterAll(async () => { await fixture?.close(); });

    async function postWrite(path: string, content: string): Promise<HookResult> {
        const result = await fixture.hook({ sessionId: `${fixture.sessionPrefix}-${path.replaceAll("/", "-")}`, event: "PostToolUse", tool: "Write",
            input: { file_path: fixture.file(path, content), content }, payload: { tool_response: "success" } });
        fixture.assertServed(result);
        expect(result.code).toBe(0);
        return result;
    }

    it("P1: a mutation-directed test write puts the kill-proof nudge in hookSpecificOutput.additionalContext", async () => {
        const result = await postWrite("src/x.mutation-kill.test.ts", KILL_TEST);
        const context = modelContext(result);
        expect(context, JSON.stringify(result)).toContain("[interlinked:kill-proof] src/x.mutation-kill.test.ts: no executed kill proof covers");
        expect(context).toContain("interlinked tests prove-kill --mutant <id> --test src/x.mutation-kill.test.ts");
    }, 30_000);

    it("N1: an ordinary test write carries no kill-proof text on any channel", async () => {
        const result = await postWrite("src/x.test.ts", KILL_TEST);
        expect(result.stdout + result.stderr).not.toContain("[interlinked:kill-proof]");
    }, 30_000);

    it("P2: a fresh killed receipt silences the nudge; a source edit makes it stale again", async () => {
        const proof = await fixture.cli(["tests", "prove-kill", "--cwd", fixture.cwd, "--file", "src/x.ts",
            "--find", "a + b", "--replace", "a - b", "--test", "src/x.mutation-kill.test.ts", "--timeout", "40000"]);
        expect(proof.code, proof.stdout + proof.stderr).toBe(0);
        expect(proof.stdout).toContain("verdict: KILLED");

        const silenced = await postWrite("src/x.mutation-kill.test.ts", KILL_TEST);
        expect(silenced.stdout + silenced.stderr).not.toContain("[interlinked:kill-proof]");

        fixture.file("src/x.ts", `${SOURCE}// touched after the proof\n`);
        const stale = await postWrite("src/x.mutation-kill.test.ts", KILL_TEST);
        expect(modelContext(stale), JSON.stringify(stale)).toContain("[interlinked:kill-proof] src/x.mutation-kill.test.ts: 1 kill proof(s) went stale");
    }, 60_000);
});
