import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedHookEvent } from "./harness/unified-event.js";
import { attemptSelfHealOnStop } from "./hook-entry-stop-self-heal.js";

function stopEvent(overrides: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	// SAFETY: the gate only reads `.phase`, `.action.kind`, and `.context.cwd` —
	// the rest of the real UnifiedHookEvent shape is irrelevant to this test.
	return {
		phase: "stop",
		action: { kind: "other" },
		context: {},
		raw: {},
		...overrides,
	} as UnifiedHookEvent;
}

let root: string;

beforeEach(() => {
	root = mkdtempRoot();
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	writeFileSync(join(root, ".interlinked", "config.json"), "{}");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function mkdtempRoot(): string {
	return mkdtempSync(join(tmpdir(), "stop-self-heal-"));
}

const NOW_MS = 1_800_000_000_000;

describe("attemptSelfHealOnStop — positive (must fire)", () => {
	// P1: a configured repo with no daemon pid at all, down past the bound.
	it("P1: fires self-heal when configured but no daemon has ever started, past the bound", () => {
		const spawnDaemon = vi.fn(() => process.pid);
		const result = attemptSelfHealOnStop(stopEvent({ context: { cwd: root } }), root, {}, { spawnDaemon, resolveServerPath: () => "/fake/server.js" }, {
			now: () => NOW_MS,
			lastLedgerEventAt: () => 0, // "down forever" — well past the 60s bound
		});
		expect(result).toBe("spawned");
		expect(spawnDaemon).toHaveBeenCalledTimes(1);
	});

	// P2: a dead-but-present pid, down past the bound.
	it("P2: fires self-heal for a dead pidfile down past the bound", () => {
		writeFileSync(join(root, ".interlinked", "harness.pid"), "999999999");
		const spawnDaemon = vi.fn(() => process.pid);
		const result = attemptSelfHealOnStop(stopEvent({ context: { cwd: root } }), root, {}, { spawnDaemon, resolveServerPath: () => "/fake/server.js" }, {
			now: () => NOW_MS,
			lastLedgerEventAt: () => NOW_MS - 120_000,
		});
		expect(result).toBe("spawned");
		expect(spawnDaemon).toHaveBeenCalledTimes(1);
	});
});

describe("attemptSelfHealOnStop — negative (must NOT fire)", () => {
	// N1: wrong phase — the reactive PreToolUse gate already covers pre-tool.
	it("N1: not-applicable on a pre-tool event", () => {
		const spawnDaemon = vi.fn();
		const result = attemptSelfHealOnStop(
			stopEvent({ phase: "pre-tool", context: { cwd: root } }),
			root,
			{},
			{ spawnDaemon, resolveServerPath: () => "/fake/server.js" },
			{ now: () => NOW_MS, lastLedgerEventAt: () => 0 },
		);
		expect(result).toBe("not-applicable");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	// N2: down for less than the bound — an ordinary graceful handover.
	it("N2: not-applicable when the outage is younger than the bound", () => {
		const spawnDaemon = vi.fn();
		const result = attemptSelfHealOnStop(stopEvent({ context: { cwd: root } }), root, {}, { spawnDaemon, resolveServerPath: () => "/fake/server.js" }, {
			now: () => NOW_MS,
			lastLedgerEventAt: () => NOW_MS - 5_000, // only 5s down
		});
		expect(result).toBe("not-applicable");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	// N3: a live pid + present socket (alive but slow) — never self-heal a healthy daemon.
	it("N3: not-applicable when the daemon is alive but merely slow", () => {
		writeFileSync(join(root, ".interlinked", "harness.pid"), String(process.pid));
		writeFileSync(join(root, ".interlinked", "harness.sock"), "");
		const spawnDaemon = vi.fn();
		const result = attemptSelfHealOnStop(stopEvent({ context: { cwd: root } }), root, {}, { spawnDaemon, resolveServerPath: () => "/fake/server.js" }, {
			now: () => NOW_MS,
			lastLedgerEventAt: () => 0,
		});
		expect(result).toBe("not-applicable");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	// N4: an operator-disabled repo (`interlinked disable`) must never be resurrected.
	it("N4: not-applicable when the repo was intentionally stood down", () => {
		writeFileSync(join(root, ".interlinked", "guard-disabled.json"), JSON.stringify({ disabled: true }));
		const spawnDaemon = vi.fn();
		const result = attemptSelfHealOnStop(stopEvent({ context: { cwd: root } }), root, {}, { spawnDaemon, resolveServerPath: () => "/fake/server.js" }, {
			now: () => NOW_MS,
			lastLedgerEventAt: () => 0,
		});
		expect(result).toBe("not-applicable");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});
});

describe("attemptSelfHealOnStop — default ledger clock (no lastLedgerEventAt override)", () => {
	// P3: with no `lastLedgerEventAt` override, the gate falls back to reading
	// `.interlinked/daemon-events.jsonl` itself; a stale newest row past the
	// bound must still self-heal.
	it("P3: self-heals off the real daemon-events.jsonl ledger when its newest row is past the bound", () => {
		writeFileSync(
			join(root, ".interlinked", "daemon-events.jsonl"),
			`${JSON.stringify({ at: NOW_MS - 120_000, pid: 111, event: "exit" })}\n`,
		);
		const spawnDaemon = vi.fn(() => process.pid);
		const result = attemptSelfHealOnStop(
			stopEvent({ context: { cwd: root } }),
			root,
			{},
			{ spawnDaemon, resolveServerPath: () => "/fake/server.js" },
			{ now: () => NOW_MS },
		);
		expect(result).toBe("spawned");
		expect(spawnDaemon).toHaveBeenCalledTimes(1);
	});

	// N5: a fresh ledger row (within the bound) must read as "too recent to
	// distinguish from a normal handover" — this only holds if the default
	// reader actually returns the row's real timestamp rather than always 0
	// (which would read as "down forever" and wrongly self-heal).
	it("N5: does not self-heal off the real ledger when its newest row is within the bound", () => {
		writeFileSync(
			join(root, ".interlinked", "daemon-events.jsonl"),
			`${JSON.stringify({ at: NOW_MS - 5_000, pid: 111, event: "exit" })}\n`,
		);
		const spawnDaemon = vi.fn();
		const result = attemptSelfHealOnStop(
			stopEvent({ context: { cwd: root } }),
			root,
			{},
			{ spawnDaemon, resolveServerPath: () => "/fake/server.js" },
			{ now: () => NOW_MS },
		);
		expect(result).toBe("not-applicable");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});
});
