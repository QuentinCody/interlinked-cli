import { describe, expect, it } from "vitest";
import { DEFAULT_DAEMON_HEAP_MB } from "../harness/memory-ceiling.js";
import { downBranchBash, pidDiscoveryBash, resolveReviveBakes } from "./statusline-revive.js";

/**
 * The statusline's daemon-down branch is DISPLAY-ONLY (2026-08-16): it renders
 * grace → "hook recovery active" → offline alarm, and never spawns a
 * daemon itself. It used to be a second, unmutexed supervisor — every render
 * raced a raw `node server.js` against the hook supervisor's mutexed
 * self-heal, and the losers' stale pid files painted "restarting" forever.
 * One daemon, ONE supervisor — the hook's. These tests pin that contract.
 */
const BAKES = { nodeBin: "/opt/node/bin/node", serverJs: "/repo/dist/harness/server.js", heapMb: 1536 };

describe("downBranchBash — positive (must render truthfully)", () => {
	it("P1: debounces the transient window before any alarm", () => {
		const b = downBranchBash(BAKES);
		expect(b).toContain('DOWN_MARK="$ID/.statusline-down-since"');
		expect(b).toContain("DOWN_GRACE_SECS=6");
		expect(b).toContain("harness restarting…");
	});

	it("P2: shows the calm supervisor row under the alarm threshold, alarm past it", () => {
		const b = downBranchBash(BAKES);
		expect(b).toContain("REVIVE_ALARM_SECS=45");
		expect(b).toContain("harness down — hook recovery active");
		expect(b).toContain("harness offline — recovery not verified");
	});

	it("P3: the offline alarm hands the human the diagnostic command", () => {
		const b = downBranchBash(BAKES);
		expect(b).toContain("interlinked harness status");
		expect(b).toContain("degraded mode: inline deterministic gates only");
		expect(b).not.toContain("edits blocked");
		expect(b).not.toContain("bypassing guardrails");
	});

	it("P4: clears both marker files once the daemon is back", () => {
		expect(downBranchBash(BAKES)).toContain('rm -f "$DOWN_MARK" "$REVIVE_MARK"');
	});
});

describe("downBranchBash — negative (display-only: must NOT manage processes)", () => {
	it("N1: bakes no spawn machinery — no node/server/heap/gc, no throttle, no background spawn", () => {
		const b = downBranchBash(BAKES);
		expect(b).not.toContain("REVIVE_NODE=");
		expect(b).not.toContain("REVIVE_SERVER=");
		expect(b).not.toContain("--max-old-space-size");
		expect(b).not.toContain("--expose-gc");
		expect(b).not.toContain("REVIVE_THROTTLE_SECS");
		expect(b).not.toContain(">/dev/null 2>&1 &");
	});

	it("N2: resolveReviveBakes never throws and always yields this process's node", () => {
		const bakes = resolveReviveBakes();
		expect(bakes.nodeBin).toBe(process.execPath);
		expect(bakes.heapMb).toBeGreaterThan(0);
	});

	it("N4: a throwing path resolver still yields bakes with an empty serverJs, not an unhandled throw", () => {
		// resolveReviveBakes's catch clears nothing but also propagates
		// nothing: serverJs stays at its pre-assignment "" and the function
		// still returns normally. Without the catch this injected throw would
		// escape resolveReviveBakes and fail the test on an uncaught error.
		const bakes = resolveReviveBakes(() => {
			throw new Error("probe failed");
		});
		expect(bakes.serverJs).toBe("");
		expect(bakes.nodeBin).toBe(process.execPath);
		expect(bakes.heapMb).toBe(DEFAULT_DAEMON_HEAP_MB);
	});
});

describe("pidDiscoveryBash — first LIVE pid wins over stale litter", () => {
	it("P5: probes liveness per candidate and breaks on the first live one", () => {
		const b = pidDiscoveryBash();
		expect(b).toContain('"$IL"/harness.pid "$IL"/harness-*.pid');
		expect(b).toContain('ps -p "$CAND"');
		expect(b).toContain("break");
	});

	it("N3: keeps a dead first pid only as fallback and rejects non-numeric content", () => {
		const b = pidDiscoveryBash();
		expect(b).toContain('[ -z "$PID" ] && PID="$CAND"');
		expect(b).toContain("*[!0-9]*");
	});
});
