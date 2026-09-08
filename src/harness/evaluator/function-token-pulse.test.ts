import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FunctionTokenEntry } from "../function-tokens/types.js";
import type { HarnessEvent } from "../types.js";
import {
    collectFunctionTokenPulseWarnings,
    formatFunctionTokenPulse,
    recordFunctionTokenPulse,
    resetFunctionTokenPulseForTesting,
} from "./function-token-pulse.js";

function entry(name: string, canonicalTokens: number): FunctionTokenEntry {
    return {
        name,
        qualifiedName: name,
        declarationKind: "function",
        language: "typescript",
        startOffset: 0,
        endOffset: 10,
        line: 1,
        endLine: 2,
        canonicalTokens,
        identityKind: "named",
    };
}

function postEvent(cwd: string, file: string): HarnessEvent {
    return {
        hook_event: "PostToolUse",
        session_id: "function-token-pulse",
        agent_source: "codex",
        timestamp: "2026-08-30T00:00:00.000Z",
        cwd,
        tool_name: "Write",
        tool_input: { file_path: file },
    };
}

let temporary = "";

beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "function-token-pulse-"));
    resetFunctionTokenPulseForTesting();
});

afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
});

describe("function-token PostToolUse pulse", () => {
    it("reports maximum movement, the review band, and active cap", () => {
        const line = formatFunctionTokenPulse(
            "src/a.ts",
            [entry("alpha", 240)],
            [entry("alpha", 300), entry("beta", 100)],
            500,
        );
        expect(line).toContain("[interlinked:function-tokens] src/a.ts");
        expect(line).toContain("max alpha=300 (Δ+60), cap 500");
        expect(line).toContain("review band 1");
    });

    it("reuses a hash-matched PreToolUse snapshot without reparsing", () => {
        const file = join(temporary, "a.ts");
        const content = "export function alpha() { return 1; }\n";
        writeFileSync(file, content);
        recordFunctionTokenPulse(
            "function-token-pulse",
            file,
            [entry("alpha", 20)],
            [entry("alpha", 30)],
            content,
        );
        const warnings = collectFunctionTokenPulseWarnings(postEvent(temporary, file));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("Δ+10");
    });

    it("drops a stale snapshot when projected bytes did not land", () => {
        const file = join(temporary, "a.ts");
        const projected = "export function alpha() { return 1; }\n";
        writeFileSync(file, "export function beta() { return 2; }\n");
        recordFunctionTokenPulse(
            "function-token-pulse",
            file,
            [entry("alpha", 20)],
            [entry("alpha", 30)],
            projected,
        );
        const warnings = collectFunctionTokenPulseWarnings(postEvent(temporary, file));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).not.toContain("Δ");
        expect(warnings[0]).toContain("beta");
    });

    it("reports an unsupported language instead of silently omitting the pulse", () => {
        const file = join(temporary, "script.sh");
        writeFileSync(file, "main() { echo ok; }\n");

        const warnings = collectFunctionTokenPulseWarnings(postEvent(temporary, file));

        expect(warnings).toEqual([
            "[interlinked:function-tokens:not-measured] script.sh: sh exact adapter unavailable",
        ]);
    });

    it("evicts the oldest stash entry once the cache exceeds its cap, forcing a reparse", () => {
        // MAX_STASH_ENTRIES is 256; the very first recorded snapshot below is
        // the oldest by insertion order, so it must be the one evicted once the
        // 257th entry is stashed. The recorded afterContent MATCHES the bytes
        // written to disk (same pattern as the hash-matched-reuse test above)
        // so a hash mismatch can never explain a missing snapshot on its own —
        // only eviction can.
        const file = join(temporary, "a.ts");
        const content = "export function evictedProbe() { return 42; }\n";
        writeFileSync(file, content);
        recordFunctionTokenPulse(
            "function-token-pulse",
            file,
            [entry("phantom", 20)],
            [entry("phantom", 30)],
            content,
        );
        for (let i = 0; i < 256; i++) {
            recordFunctionTokenPulse("function-token-pulse", join(temporary, `filler-${i}.ts`), [], [], "");
        }

        const warnings = collectFunctionTokenPulseWarnings(postEvent(temporary, file));

        expect(warnings).toHaveLength(1);
        // Evicted: no stashed snapshot to reuse (even though the hash would
        // have matched), so before is null (no "Δ") and the pulse reflects
        // the real function parsed off disk, not the stale "phantom" entry
        // the evicted snapshot carried.
        expect(warnings[0]).not.toContain("Δ");
        expect(warnings[0]).toContain("max evictedProbe=");
    });
});
