import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendTscStopHistory, firstTscInvocations, classifyTscOutcome, parseTscHistoryRow, readTscStopHistory, summarizeTscHistory, tscStopHistoryAddendum, TSC_HISTORY_MAX_BYTES } from "./session-tsc-stop-history.js";
import { checkUnverifiedCode } from "./server/lifecycle-stop-warnings-code-file-verification.js";
import { makeEvent, makeSession } from "./__tests__/fixtures/evaluator.js";
import { getDefaultConfig } from "./rules-loader.js";
import type { ServerRuntime } from "./server/runtime-context.js";
const now = Date.parse("2026-10-28T12:00:00Z");
const dirs: string[] = [];
function row(i: number, status = "finding", over: Record<string, unknown> = {}) { return { schema: "check-results.v2", session: "test-session", ts: new Date(now - 60000 + i * 1000).toISOString(), tool_use_id: `call-${i}`, execution: [{ id: "typescript", status }], ...over }; }
function fixture(rows: unknown[], tail = "") { const dir = mkdtempSync(join(tmpdir(), "stop-history-")); dirs.push(dir); mkdirSync(join(dir, ".interlinked")); writeFileSync(join(dir, ".interlinked/check-results.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n" + tail); return dir; }
function add(cwd: string, enabled = true, session = "test-session") { return appendTscStopHistory("BASE", { enabled, cwd, session, now }); }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe("MUST-FIRE advisory", () => {
    it("fires with 3 prior findings and reports accurate target", () => { const result = add(fixture([row(1), row(2), row(3)])); expect(result).toContain("findings in 3 of 3"); expect(result).toContain("does not establish"); });
    it("fires at exact R=.5 boundary with latest finding", () => { const dir = fixture([row(1, "completed_no_reported_findings"), row(2), row(3, "completed_no_reported_findings"), row(4)]); expect(add(dir)).toContain("2 of 4"); });
    it("runs through the wired Stop warning entry and real formatter", () => {
        const cwd = fixture([row(1), row(2), row(3)]), rules = getDefaultConfig();
        if (!rules.verification_stop_checks) throw new Error("missing default config");
        expect(rules.verification_stop_checks.session_tsc_history).toBe(false);
        rules.verification_stop_checks.session_tsc_history = true;
        const ctx = { cwd, rules, log: () => {} } as unknown as ServerRuntime;
        const session = makeSession(); session.files_written = new Set(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]);
        const event = makeEvent({ hook_event: "Stop", cwd, timestamp: new Date(now).toISOString() });
        const warning = checkUnverifiedCode(ctx, session, new Set(), event);
        expect(warning).toContain("[interlinked:verify-before-stop]"); expect(warning).toContain("3 of 3");
        console.log(JSON.stringify({ runtimeDemo: "wired Stop code-file-warning entry", warning }));
        rules.verification_stop_checks.session_tsc_history = false;
        expect(checkUnverifiedCode(ctx, session, new Set(), event)).not.toContain("3 of 3");
        rules.verification_stop_checks.session_tsc_history = true;
        expect(checkUnverifiedCode(ctx, session, new Set(), { ...event, hook_event: "SessionEnd" })).not.toContain("3 of 3");
        expect(checkUnverifiedCode(ctx, session, new Set(["verify-suite"]), event)).toBeNull();
    });
});
describe("MUST-NOT-FIRE", () => {
    it("off and missing flag preserve warning, null base stays null", () => { const cwd=fixture([row(1),row(2),row(3)]);expect(add(cwd,false)).toBe("BASE");expect(appendTscStopHistory("BASE",{cwd,session:"test-session",now})).toBe("BASE");expect(appendTscStopHistory(null,{enabled:true,cwd,session:"test-session",now})).toBeNull(); });
    it.each([[],[row(1)],[row(1),row(2)]])("requires three observations", (...rows) => { expect(add(fixture(rows))).toBe("BASE"); });
    it("does not borrow other sessions",()=>expect(add(fixture([row(1),row(2),row(3)]),true,"other")).toBe("BASE"));
    it("future and equal-time evidence never enters history",()=>expect(add(fixture([1,2,3].map(i=>row(i,"finding",{ts:new Date(now+i-1).toISOString()}))))).toBe("BASE"));
    it("stale evidence excluded",()=>expect(add(fixture([1,2,3].map(i=>row(i,"finding",{ts:new Date(now-3600001).toISOString()}))))).toBe("BASE"));
    it("later no-findings evidence suppresses high R",()=>expect(add(fixture([row(1),row(2),row(3),row(4,"completed_no_reported_findings")]))).toBe("BASE"));
    it("latest tied clean wins",()=>expect(add(fixture([row(1),row(2),row(3,"completed_no_reported_findings"),row(3,"finding",{tool_use_id:"other"})]))).toBe("BASE"));
    it("duplicates and repeated call identities do not inflate n",()=>expect(add(fixture([row(1),row(1),row(2,"finding",{tool_use_id:"call-1"})]))).toBe("BASE"));
    it("partial tail, malformed and missing metadata do not count",()=>{const dir=fixture([row(1),row(2),{...row(3),session:undefined},{...row(4),ts:"invalid"}],JSON.stringify(row(5)));expect(add(dir)).toBe("BASE");});
    it("own call excluded",()=>{const dir=fixture([row(1),row(2),row(3)]);expect(readTscStopHistory(dir,"test-session",now,"call-3").runs).toBe(2);});
    it.each(["deferred","skipped","error","unsupported_configuration","timeout","resource_busy","unknown"])("%s does not become clean",status=>{expect(add(fixture([row(1),row(2),row(3,status)]))).toBe("BASE");});
    it("dry runs and conflicting execution remain unknown",()=>{expect(parseTscHistoryRow(row(1,"finding",{dry_run:true}))).toBeNull();expect(classifyTscOutcome(row(1,"finding",{execution:[{id:"typescript",status:"finding"},{id:"typescript",status:"error"}]}))).toBe("unknown");});
    it.each([["Timed out","timeout"],["JavaScript heap limit","resource_failure"],["spawn tsc ENOENT","process_failure"]])("operational %s is separate",(reason,outcome)=>{expect(classifyTscOutcome(row(1,"finding",{execution:[{id:"typescript",status:"finding",reason}]}))).toBe(outcome);});
    it("byte bounded tail excludes old rows",()=>{const dir=fixture([row(1),row(2),row(3)],"x".repeat(TSC_HISTORY_MAX_BYTES)+"\n");expect(add(dir)).toBe("BASE");});
    it("no history or malformed time cannot fire",()=>{expect(tscStopHistoryAddendum(summarizeTscHistory([],"s",now))).toBeNull();expect(add(fixture([]))).toBe("BASE");});
});

it("MUST-NOT-FIRE without nonempty invocation IDs", () => {
    for (const call of ["", "   "]) expect(add(fixture([1,2,3].map(i => row(i, "finding", {tool_use_id:call}))))).toBe("BASE");
});
it("deduplicates unknown-first invocation records before outcome selection", () => {
    const rows = [row(1,"skipped"),row(2,"finding",{tool_use_id:"call-1"}),row(3),row(4)];
    expect(add(fixture(rows))).toBe("BASE");
    const parsed = rows.map(parseTscHistoryRow).filter(r => r !== null);
    const valid = firstTscInvocations(parsed).filter(r => r.outcome === "finding");
    expect(valid.map(r=>r.call)).toEqual(["call-3","call-4"]);
});
