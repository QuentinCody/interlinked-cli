import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { driveGuardPrediction, guardPredictionMode, guardProposal, guardReceiptPath } from "./guard-prediction.js";
import { evaluateGraphPrediction, type PreToolCtx } from "./evaluator/pre-tool-decision-phases.js";
import type { HarnessEvent } from "./types.js";

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
        expect(evaluateGraphPrediction(event(), undefined, null, [], context)?.rule_id).toBe("guard-prediction-protocol");
        expect(guardPredictionMode(null)).toBe("enforced");
        expect(guardPredictionMode({ version: 1, server_url: "", harness: { guard_prediction: { mode: "shadow" } } })).toBe("shadow");
    });
    it("accepts an exact prior prediction and permits identical retries after unrelated gates", () => {
        receipt();
        expect(driveGuardPrediction(event())).toBeNull();
        expect(driveGuardPrediction(event())).toBeNull(); // duplicate delivery
        expect(driveGuardPrediction(event(after, "agent-1", "edit-2"))).toBeNull();
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
