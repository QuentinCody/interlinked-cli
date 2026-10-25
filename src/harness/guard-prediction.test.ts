import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { driveGuardPrediction as runGuardPrediction, guardPredictionMode, guardProposal, guardReceiptPath, type GuardPredictionMode } from "./guard-prediction.js";
import { evaluateGraphPrediction, type PreToolCtx } from "./evaluator/pre-tool-decision-phases.js";
import type { HarnessEvent } from "./types.js";

// Existing protocol cases exercise explicit enforcement. The ordinary default
// must advise without demanding an agent-authored declaration of intent.
function driveGuardPrediction(event: HarnessEvent, mode: GuardPredictionMode = "enforced") {
    return runGuardPrediction(event, mode);
}

describe("predict, reveal, reconcile guard changes", () => {
    let cwd: string;
    const before = "function f(){if(ready)return result;}";
    const after = "function f(){if(ready)log();return result;}";
    const changes = [{ owner: "f", statement: "return result ;", before: [{ condition: "ready", branch: "then" }], after: [] }];
    beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "guard-prediction-")); writeFileSync(join(cwd, "a.ts"), before); });
    afterEach(() => rmSync(cwd, { recursive: true, force: true }));
    function event(content = after, session = "agent-1", id = "edit-1"): HarnessEvent {
        return { cwd, hook_event: "PreToolUse", session_id: session, tool_use_id: id, agent_source: "codex",
            timestamp: "2026-09-25T00:00:00Z", tool_name: "Write", tool_input: { file_path: "a.ts", content } };
    }
    function receipt(extra: Record<string, unknown> = {}, content = after): void {
        const proposal = guardProposal("a.ts", before, content);
        const path = guardReceiptPath(cwd, "agent-1", proposal.id);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ version: 1, session: "agent-1", ...proposal, changes, nonce: "intent-1", ...extra }));
    }
    it("blocks an undeclared scope change without any graph shards, before touching the source", () => {
        expect(driveGuardPrediction(event())).toMatchObject({ decision: "block", rule_id: "guard-prediction-protocol" });
        expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe(before);
    });
    it("runs in the real prediction phase even with graph prediction disabled", () => {
        const context: PreToolCtx = { escalation: undefined, contentScan: undefined, graphPredAdditionalContext: undefined };
        const config = { version: 1 as const, server_url: "", harness: { guard_prediction: { mode: "enforced" } } };
        expect(evaluateGraphPrediction(event(), undefined, config, [], context)?.rule_id).toBe("guard-prediction-protocol");
        expect(guardPredictionMode(null)).toBe("shadow");
        expect(guardPredictionMode({ version: 1, server_url: "", harness: { guard_prediction: { mode: "shadow" } } })).toBe("shadow");
    });
    it("accepts an exact prior prediction and permits identical retries after unrelated gates", () => {
        receipt();
        expect(driveGuardPrediction(event())).toBeNull();
        expect(driveGuardPrediction(event())).toBeNull(); // duplicate delivery
        expect(driveGuardPrediction(event(after, "agent-1", "edit-2"))).toBeNull();
    });
    it("defaults to concise advice while retaining the exact scope change for review", () => {
        const result = runGuardPrediction(event());
        expect(result?.decision).toBe("allow");
        expect(result?.warnings?.join(" ")).toContain("no declaration receipt is required");
        expect(result?.warnings?.join(" ")).not.toContain("Receipt fields");
        expect(readFileSync(join(cwd, ".interlinked/predictions/guard-events.jsonl"), "utf8")).toContain('"kind":"reveal"');
        const context: PreToolCtx = { escalation: undefined, contentScan: undefined, graphPredAdditionalContext: undefined };
        const warnings: string[] = [];
        expect(evaluateGraphPrediction(event(), undefined, null, warnings, context)).toBeNull();
        expect(warnings.join(" ")).toContain("Advisory");
    });
    it("requires explicit reconciliation after reveal and preserves the surprise", () => {
        driveGuardPrediction(event());
        receipt();
        expect(driveGuardPrediction(event())?.decision).toBe("block");
        receipt({ reconcile: guardProposal("a.ts", before, after).id, rationale: "Return is intentionally unconditional; the caller now requires this result." });
        expect(driveGuardPrediction(event())).toBeNull();
        const ledger = readFileSync(join(cwd, ".interlinked/predictions/guard-events.jsonl"), "utf8");
        expect(ledger).toContain('"kind":"reveal"');
        expect(ledger).toContain('"kind":"reconciled"');
    });
    it("allows a corrected edit that preserves the original scope", () => {
        driveGuardPrediction(event());
        expect(driveGuardPrediction(event("function f(){if(ready){log();return result;}}"))).toBeNull();
    });
    it("rejects stale bytes, another session, a blanket declaration and a wrong guard", () => {
        for (const extra of [{ beforeSha256: "stale" }, { changes: "*" }, { changes: [{ ...changes[0], after: changes[0]?.before }] }]) {
            receipt(extra);
            expect(driveGuardPrediction(event())?.decision).toBe("block");
        }
        receipt();
        expect(driveGuardPrediction(event(after, "agent-2"))?.decision).toBe("block");
        expect(driveGuardPrediction(event(after + "\n"))?.decision).toBe("block");
    });
    it("keeps shadow mode advisory, off mode inactive and dry runs free of persistent reveals", () => {
        expect(driveGuardPrediction(event(), "shadow")?.decision).toBe("allow");
        expect(driveGuardPrediction(event(), "off")).toBeNull();
        const dry = { ...event(), dry_run: true };
        receipt({ reconcile: guardProposal("a.ts", before, after).id, rationale: "Intentional." });
        expect(driveGuardPrediction(dry)?.decision).not.toBe("block");
    });
    it("reports parser and ambiguous-projection limitations instead of claiming preservation", () => {
        expect(driveGuardPrediction(event("function f( {"))).toMatchObject({ decision: "allow", warnings: [expect.stringContaining("NOT CHECKED")] });
        writeFileSync(join(cwd, "a.ts"), before + before);
        const ambiguous = { ...event(), tool_name: "Edit", tool_input: { file_path: "a.ts", old_string: "if(ready)", new_string: "" } };
        expect(driveGuardPrediction(ambiguous)).toMatchObject({ decision: "allow", warnings: [expect.stringContaining("NOT CHECKED")] });
    });
    it("never persists a dry-run reveal or consumes its prediction", () => {
        expect(driveGuardPrediction({ ...event(), dry_run: true })?.decision).toBe("block");
        expect(existsSync(join(cwd, ".interlinked"))).toBe(false);
        receipt();
        expect(driveGuardPrediction({ ...event(), dry_run: true })).toBeNull();
        expect(driveGuardPrediction(event())).toBeNull();
    });
    it("bounds parser work by UTF-8 bytes, including multibyte source comments", () => {
        const comment = `/*${"π".repeat(600_000)}*/`;
        writeFileSync(join(cwd, "a.ts"), comment + before);
        expect(driveGuardPrediction(event(comment + after))).toMatchObject({
            decision: "allow", warnings: [expect.stringContaining("source exceeds the bounded guard analysis budget")],
        });
    });
    it("checks every patch section and does not consume earlier predictions when a later file blocks", () => {
        writeFileSync(join(cwd, "b.ts"), before + "\n");
        writeFileSync(join(cwd, "a.ts"), before + "\n");
        const proposal = guardProposal("a.ts", before + "\n", after + "\n");
        const path = guardReceiptPath(cwd, "agent-1", proposal.id);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ version: 1, session: "agent-1", ...proposal, changes, nonce: "patch-intent" }));
        const patch = ["*** Begin Patch", "*** Update File: a.ts", "@@", `-${before}`, `+${after}`, "*** Update File: b.ts", "@@", `-${before}`, `+${after}`, "*** End Patch"].join("\n");
        const result = driveGuardPrediction({ ...event(), tool_name: "apply_patch", tool_input: { command: patch } });
        expect(result?.decision).toBe("block");
        expect(result?.reason).toContain("b.ts");
        expect(readFileSync(join(cwd, ".interlinked/predictions/guard-events.jsonl"), "utf8")).not.toContain('"kind":"predicted"');
    });
    it("treats a named Write as source even when it contains a patch example", () => {
        const example = "\nconst docs = `*** Begin Patch\n*** Add File: one.ts\n+x\n*** Add File: two.ts\n+y\n*** End Patch`;";
        writeFileSync(join(cwd, "a.ts"), before + example);
        expect(driveGuardPrediction(event(after + example))?.decision).toBe("block");
    });
});

// 2026-10-22: state, receipts and file keys followed the session's current folder. From `scratch/probe` an edit to
// `src/a.ts` was skipped as "outside the project" (`../../src/a.ts`), and the ledger went to a new
// `scratch/probe/.interlinked/` — a stray folder that later made every hook call below it skip the daemon.
describe("guard prediction keys to the project root, not the session folder", () => {
    let root: string;
    const before = "function f(){if(ready)return result;}";
    const after = "function f(){if(ready)log();return result;}";
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "guard-prediction-root-"));
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(join(root, ".interlinked", "config.json"), "{}");
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "a.ts"), before);
        mkdirSync(join(root, "scratch", "probe"), { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("P: an edit outside the session folder is inspected and recorded under the project root", () => {
        const result = runGuardPrediction({ cwd: join(root, "scratch", "probe"), hook_event: "PreToolUse", session_id: "agent-1", tool_use_id: "edit-1",
            agent_source: "claude", timestamp: "2026-10-22T00:00:00Z", tool_name: "Write", tool_input: { file_path: join(root, "src", "a.ts"), content: after } });
        expect(result?.warnings?.join(" ")).toContain("src/a.ts");
        expect(readFileSync(join(root, ".interlinked/predictions/guard-events.jsonl"), "utf8")).toContain('"kind":"reveal"');
    });

    it("N: no `.interlinked/` is created in the session folder", () => {
        runGuardPrediction({ cwd: join(root, "scratch", "probe"), hook_event: "PreToolUse", session_id: "agent-1", tool_use_id: "edit-1",
            agent_source: "claude", timestamp: "2026-10-22T00:00:00Z", tool_name: "Write", tool_input: { file_path: "../../src/a.ts", content: after } });
        expect(existsSync(join(root, "scratch", "probe", ".interlinked"))).toBe(false);
    });
});
