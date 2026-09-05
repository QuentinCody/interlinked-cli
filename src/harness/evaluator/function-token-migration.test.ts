import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareFunctionTokens, checkFunctionTokenWrite, resetFunctionTokenWarningsForTesting } from "./function-token-write-guard.js";
import { checkCommitFunctionTokenGate } from "./commit-function-token-gate.js";
import type { HarnessEvent } from "../types.js";

// v1's uncontextualized scanner consumes the trailing body as a template token.
function templateDebt(padding = 520, name = "target"): string {
    return "function " + name + "(x){return `a${x}b`;" + ";".repeat(padding) + "}";
}

function sizedBody(size: number): string {
    return "{" + ";".repeat(size) + "}";
}

describe("function-token migration ratchet", () => {
    let cwd: string;
    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "interlinked-token-migration-"));
        resetFunctionTokenWarningsForTesting();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        rmSync(cwd, { recursive: true, force: true });
    });

    it("grandfathers migration-created debt by recounting both source versions", () => {
        const before = templateDebt();
        expect(compareFunctionTokens(before, before + "\n// unrelated", "src/a.ts", cwd)).toEqual([]);
        expect(compareFunctionTokens(before, templateDebt(519), "src/a.ts", cwd)).toEqual([]);
        expect(compareFunctionTokens(before, templateDebt(521), "src/a.ts", cwd)?.[0]).toContain("raised from 532");
        expect(compareFunctionTokens("", before, "src/a.ts", cwd)?.[0]).toContain("new over-cap function");
    });

    it("uses the corrected count on both edit and commit paths without a model runtime", () => {
        vi.stubEnv("PATH", "");
        vi.stubEnv("INTERLINKED_MODEL_CACHE", join(cwd, "absent-models"));
        const file = join(cwd, "a.ts");
        writeFileSync(file, templateDebt());
        expect(checkFunctionTokenWrite({ file_path: file, content: templateDebt() }, cwd)).toBeNull();
        expect(checkFunctionTokenWrite({ file_path: file, content: templateDebt(521) }, cwd)?.block).toContain("533");
        const event: HarnessEvent = { hook_event: "PreToolUse", tool_name: "Bash",
            tool_input: { command: "git commit -m migration" }, cwd, session_id: "migration",
            agent_source: "codex", timestamp: "2026-09-05T00:00:00Z" };
        const deps = { resolveRepoRoot: () => cwd, changedFiles: () => ["a.ts"],
            gitShow: (_root: string, ref: string) => ref.startsWith("HEAD:") ? templateDebt() : templateDebt(521),
            readFile: () => templateDebt(521) };
        expect(checkCommitFunctionTokenGate(event, deps)?.reason).toContain("raised from 532");
    });

    it("honors a stricter cap under the corrected measurement", () => {
        mkdirSync(join(cwd, ".interlinked"));
        writeFileSync(join(cwd, ".interlinked/metric-caps.json"), JSON.stringify({ max_function_tokens: 250 }));
        expect(compareFunctionTokens("", templateDebt(238), "a.ts", cwd)).toEqual([]);
        expect(compareFunctionTokens("", templateDebt(239), "a.ts", cwd)?.[0]).toContain("251");
    });

    it.each([["function bad( {", templateDebt()], [templateDebt(), "function bad( {"]])(
        "reports an unmeasured comparison when either source needs parser recovery", (before, after) => {
            const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
            expect(compareFunctionTokens(before, after, "a.ts", cwd)).toBeNull();
            expect(stderr).toHaveBeenCalledWith(expect.stringContaining("not-measured"));
        },
    );

    it("blocks moving debt to a newly named oversized helper", () => {
        const after = templateDebt(100) + templateDebt(550, "helper");
        expect(compareFunctionTokens(templateDebt(1000), after, "a.ts", cwd)?.[0]).toContain("helper");
    });

    it("preserves rank comparisons for anonymous functions and repeated names", () => {
        const callbacks = (a: number, b: number) => `consume(() => ${sizedBody(a)}, () => ${sizedBody(b)});`;
        expect(compareFunctionTokens(callbacks(700, 600), callbacks(600, 700), "a.ts", cwd)).toEqual([]);
        expect(compareFunctionTokens(callbacks(700, 600), callbacks(600, 701), "a.ts", cwd)?.length).toBe(1);
        const methods = (a: number, b: number) => `class A { run()${sizedBody(a)} } class B { run()${sizedBody(b)} }`;
        expect(compareFunctionTokens(methods(700, 600), methods(600, 700), "a.ts", cwd)).toEqual([]);
        expect(compareFunctionTokens(methods(700, 600), methods(600, 701), "a.ts", cwd)?.length).toBe(1);
    });
});
