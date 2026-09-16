import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHookFilesystemWatch } from "../hook-filesystem-watch.js";
import { appendHookCoverageDecision } from "./hook-coverage.js";
import { createCodexAdapter } from "../adapters/codex.js";
import { encodeHookResult } from "../../hook-entry-translation.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("daemon hook coverage delivery", () => {

    it("keeps pending coverage visible without forcing Codex Stop continuation or clearing evidence", () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-coverage-stop-output-"));
        writeFileSync(join(root, "reserved.txt"), "observed file version");
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const watcher = startHookFilesystemWatch({ root, reservations: () => ["reserved.txt"] });
        cleanups.push(watcher.stop);
        const pending = watcher.ledger.snapshot().pending;
        expect(pending.length).toBeGreaterThan(0);
        const decision = appendHookCoverageDecision({ cwd: root, hookCoverage: watcher },
            { hook_event: "Stop", session_id: "s1" }, { decision: "allow" });
        const adapter = createCodexAdapter();
        const output = encodeHookResult({ adapter, decision, dataDir: join(root, ".interlinked"),
            event: adapter.parseHookInput({ session_id: "s1" }, "Stop"), fellBack: false });
        expect(output.stdout).toBeUndefined();
        expect(output.exit_code).toBe(0);
        expect(output.stderr).toContain("[interlinked:hook-coverage] NOT CHECKED");
        expect(watcher.ledger.snapshot().pending).toEqual(pending);
    });

    it("returns native watch paths at session start and retains obligations after delivery", () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-hook-delivery-"));
        writeFileSync(join(root, "reserved.txt"), "observed file version");
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const watcher = startHookFilesystemWatch({ root, reservations: () => ["reserved.txt"] });
        cleanups.push(watcher.stop);
        const result = appendHookCoverageDecision({ cwd: root, hookCoverage: watcher }, { hook_event: "SessionStart", session_id: "s1" }, { decision: "allow" });
        expect(result.watch_paths).toContain(join(root, "reserved.txt"));
        expect(result.warnings?.join("\n")).toContain("NOT CHECKED");
        expect(watcher.ledger.snapshot().pending.length).toBeGreaterThan(0);
    });

    it("rejects runtime application of changed accepted policy without claiming rollback", () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-hook-policy-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
        cleanups.push(watcher.stop);
        watcher.ledger.acceptPolicy(watcher.ledger.policyDigest());
        writeFileSync(join(root, "package.json"), "{}");
        const result = appendHookCoverageDecision({ cwd: root, hookCoverage: watcher }, { hook_event: "ConfigChange", session_id: "s1" }, { decision: "allow" });
        expect(result.decision).toBe("block");
        expect(result.reason).toContain("runtime application");
    });

    describe("Stop throttle — positive (must fire)", () => {
        it("P1: an unchanged pending count speaks once per session on Stop, then stays quiet", () => {
            const root = mkdtempSync(join(tmpdir(), "interlinked-hook-stop-throttle-"));
            writeFileSync(join(root, "reserved.txt"), "observed file version");
            cleanups.push(() => rmSync(root, { recursive: true, force: true }));
            const watcher = startHookFilesystemWatch({ root, reservations: () => ["reserved.txt"] });
            cleanups.push(watcher.stop);
            const runtime = { cwd: root, hookCoverage: watcher };
            const stop = { hook_event: "Stop", session_id: "s1" };
            const first = appendHookCoverageDecision(runtime, stop, { decision: "allow", warnings: ["existing"] });
            expect(first.warnings).toEqual(["existing", expect.stringContaining("NOT CHECKED")]);
            const second = appendHookCoverageDecision(runtime, stop, { decision: "allow", warnings: ["existing"] });
            expect(second.warnings).toEqual(["existing"]);
            expect(watcher.ledger.snapshot().pending.length).toBeGreaterThan(0);
        });
        it("P2: the unavailable-watcher line is throttled on Stop the same way", () => {
            const root = mkdtempSync(join(tmpdir(), "interlinked-hook-stop-unavailable-"));
            cleanups.push(() => rmSync(root, { recursive: true, force: true }));
            const runtime = { cwd: root, hookCoverageUnavailable: "watcher offline" };
            const stop = { hook_event: "Stop", session_id: "s1" };
            expect(appendHookCoverageDecision(runtime, stop, { decision: "allow" }).warnings).toEqual([expect.stringContaining("watcher offline")]);
            expect(appendHookCoverageDecision(runtime, stop, { decision: "allow" }).warnings).toEqual([]);
        });
    });

    describe("Stop throttle — negative (must not fire)", () => {
        it("N1: a different session hears the nudge again", () => {
            const root = mkdtempSync(join(tmpdir(), "interlinked-hook-stop-session-"));
            writeFileSync(join(root, "reserved.txt"), "observed file version");
            cleanups.push(() => rmSync(root, { recursive: true, force: true }));
            const watcher = startHookFilesystemWatch({ root, reservations: () => ["reserved.txt"] });
            cleanups.push(watcher.stop);
            const runtime = { cwd: root, hookCoverage: watcher };
            appendHookCoverageDecision(runtime, { hook_event: "Stop", session_id: "s1" }, { decision: "allow" });
            const other = appendHookCoverageDecision(runtime, { hook_event: "Stop", session_id: "s2" }, { decision: "allow" });
            expect(other.warnings?.join("\n")).toContain("NOT CHECKED");
        });
        it("N2: non-Stop boundaries and Stops with no session id are never throttled", () => {
            const root = mkdtempSync(join(tmpdir(), "interlinked-hook-stop-boundary-"));
            writeFileSync(join(root, "reserved.txt"), "observed file version");
            cleanups.push(() => rmSync(root, { recursive: true, force: true }));
            const watcher = startHookFilesystemWatch({ root, reservations: () => ["reserved.txt"] });
            cleanups.push(watcher.stop);
            const runtime = { cwd: root, hookCoverage: watcher };
            for (const event of [{ hook_event: "SessionStart", session_id: "s1" }, { hook_event: "SessionStart", session_id: "s1" }, { hook_event: "Stop", session_id: "" }, { hook_event: "Stop", session_id: "" }]) {
                expect(appendHookCoverageDecision(runtime, event, { decision: "allow" }).warnings?.join("\n")).toContain("NOT CHECKED");
            }
        });
    });
});
