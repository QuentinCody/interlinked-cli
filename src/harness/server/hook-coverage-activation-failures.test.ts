import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ReservationEntry } from "../types.js";
import { activateHookCoverage, appendHookCoverageDecision } from "./hook-coverage.js";
import { makeServerRuntime } from "./__tests__/fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "coverage-activation-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return { root, runtime: makeServerRuntime({ cwd: root }) };
}

it("reports a corrupt durable ledger as unmeasured and preserves its bytes for recovery", () => {
    const { root, runtime } = fixture();
    mkdirSync(join(root, ".interlinked"));
    const path = join(root, ".interlinked/hook-coverage.json"), corrupt = '{"schema":1,';
    writeFileSync(path, corrupt);
    cleanups.push(activateHookCoverage(runtime));
    expect(runtime.hookCoverage).toBeUndefined();
    expect(runtime.hookCoverageUnavailable).toContain("SyntaxError");
    expect(runtime.logAlways).toHaveBeenCalledWith(expect.stringContaining("NOT MEASURED"));
    const decision = appendHookCoverageDecision(runtime, { hook_event: "Stop", session_id: "failed-observer" }, { decision: "allow" });
    expect(decision).toMatchObject({ decision: "allow", warnings: [expect.stringContaining("NOT MEASURED")] });
    expect(readFileSync(path, "utf8")).toBe(corrupt);
});

it("closes an initialized observer when reservation subscription fails", () => {
    const { runtime } = fixture();
    let observer: typeof runtime.hookCoverage;
    runtime.reservations.onChange = () => {
        observer = runtime.hookCoverage;
        throw new Error("reservation subscription unavailable");
    };
    cleanups.push(activateHookCoverage(runtime));
    expect(observer).toBeDefined();
    expect(observer?.status().readiness).toBe("unmeasured");
    expect(runtime.hookCoverage).toBeUndefined();
    expect(runtime.hookCoverageUnavailable).toContain("reservation subscription unavailable");
});

it("observes a new reservation immediately and unsubscribes on shutdown", () => {
    const { root, runtime } = fixture();
    const reservations: ReservationEntry[] = [];
    let changed = () => {};
    const unsubscribe = vi.fn();
    runtime.reservations.getAll = () => reservations;
    runtime.reservations.onChange = listener => { changed = listener; return unsubscribe; };
    const stop = activateHookCoverage(runtime);
    cleanups.push(stop);
    const path = join(root, "new.ts");
    writeFileSync(path, "export const changed = true;\n");
    reservations.push({ file_pattern: path, agent_name: "peer", cohort: "local",
        reserved_at: "2026-10-06T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" });
    changed();
    expect(runtime.hookCoverage?.ledger.observation().pending).toEqual([expect.objectContaining({ path, writer: "unknown" })]);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(runtime.hookCoverage?.status().readiness).toBe("unmeasured");
});
