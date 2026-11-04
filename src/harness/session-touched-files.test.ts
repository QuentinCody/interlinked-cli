import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTouchedFiles, readTouchedLedger, touchedLedgerPath, touchedTargets, TOUCHED_LEDGER_MAX_BYTES } from "./session-touched-files.js";
import { summaryCoverageWarnings } from "./server/summary-coverage.js";
import type { HarnessEvent } from "./types.js";

const roots: string[] = [];
function root(): string {
    const path = mkdtempSync(join(tmpdir(), "il-touch-")); roots.push(path);
    mkdirSync(join(path, "src")); writeFileSync(join(path, "src/a.ts"), "export const a = 1;\n"); return path;
}
function event(cwd: string, extra: Partial<HarnessEvent> = {}): HarnessEvent {
    return { hook_event: "PostToolUse", agent_source: "codex", session_id: "s", tool_use_id: "w1", timestamp: "2026-10-28T10:00:01Z",
        tool_name: "Write", tool_input: { file_path: "src/a.ts" }, cwd, ...extra } as HarnessEvent;
}
function start(cwd: string): void { captureTouchedFiles(event(cwd, { hook_event: "SessionStart", timestamp: "2026-10-28T10:00:00Z" }), cwd); }
function stop(cwd: string, message: string): string[] {
    return summaryCoverageWarnings(event(cwd, { hook_event: "Stop", timestamp: "2026-10-28T10:01:00Z", last_assistant_message: message }), cwd);
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("completed-write ledger", () => {
    it("persists metadata across fresh reads, deduplicates tool IDs, isolates sessions and honors time", () => {
        const cwd = root(); start(cwd); captureTouchedFiles(event(cwd), cwd); captureTouchedFiles(event(cwd), cwd);
        expect(readTouchedLedger(cwd, "s")).toMatchObject({ available: true, complete: true, rows: [{ session_id: "s", tool_use_id: "w1", path: "src/a.ts", bytes: 20 }] });
        expect(readTouchedLedger(cwd, "other").available).toBe(false);
        expect(readTouchedLedger(cwd, "s", Date.parse("2026-10-28T10:00:00Z")).rows).toEqual([]);
        expect(readTouchedLedger(cwd, "s", Date.parse("2026-10-27T10:00:00Z")).available).toBe(false);
        expect(readFileSync(touchedLedgerPath(cwd, "s"), "utf8")).not.toContain("export const");
    });
    it("MUST-NOT-CAPTURE dry runs, errors, read tools and PreToolUse", () => {
        const cwd = root();
        for (const extra of [{ dry_run: true }, { tool_outcome: "error" }, { tool_name: "Read" }, { hook_event: "PreToolUse" }]) {
            captureTouchedFiles(event(cwd, extra as Partial<HarnessEvent>), cwd);
        }
        expect(readTouchedLedger(cwd, "s").available).toBe(false);
    });
    it("captures Write/Edit/MultiEdit, multi-file patches and resolved shell destinations", () => {
        const cwd = root();
        for (const tool_name of ["Write", "Edit", "MultiEdit"]) expect(touchedTargets(event(cwd, { tool_name }), cwd)).toEqual(["src/a.ts"]);
        expect(touchedTargets(event(cwd, { tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+b\n*** End Patch" } }), cwd)).toEqual(["src/a.ts", "src/b.ts"]);
        expect(touchedTargets(event(cwd, { tool_name: "Bash", tool_input: { command: "cd src && printf x > a.ts" } }), cwd)).toEqual(["src/a.ts"]);
        expect(touchedTargets(event(cwd, { tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/renamed.ts\n@@\n-a\n+b\n*** End Patch" } }), cwd)).toEqual(["src/renamed.ts", "src/a.ts"]);
        expect(touchedTargets(event(cwd, { tool_input: { file_path: "../other.ts" } }), cwd)).toEqual([]);
    });
    it("bounded overflow is unavailable, never silently clean", () => {
        const cwd = root(); start(cwd); writeFileSync(touchedLedgerPath(cwd, "s"), "x".repeat(TOUCHED_LEDGER_MAX_BYTES + 1));
        expect(readTouchedLedger(cwd, "s").available).toBe(false);
    });
});

describe("Stop summary against captured touches", () => {
    it("MUST-FIRE omitted touched file and mentioned untouched file", () => {
        const cwd = root(); start(cwd); captureTouchedFiles(event(cwd), cwd);
        const warnings = stop(cwd, "Updated src/b.ts.");
        expect(warnings).toHaveLength(2); expect(warnings.join("\n")).toContain("src/a.ts"); expect(warnings.join("\n")).toContain("src/b.ts");
    });
    it("MUST-NOT-FIRE exact match and fenced example paths", () => {
        const cwd = root(); start(cwd); captureTouchedFiles(event(cwd), cwd);
        expect(stop(cwd, "Updated `src/a.ts`.\nExample:\n```ts\nimport x from 'src/example.ts';\n```\n~~~text\nsrc/another.ts\n~~~")).toEqual([]);
    });
    it("partial capture can prove an omission but cannot prove an extra mention is untouched", () => {
        const cwd = root(); captureTouchedFiles(event(cwd), cwd);
        expect(stop(cwd, "Updated src/b.ts.")).toHaveLength(1);
        expect(stop(cwd, "Updated src/a.ts and src/b.ts.")).toEqual([]);
    });
});
