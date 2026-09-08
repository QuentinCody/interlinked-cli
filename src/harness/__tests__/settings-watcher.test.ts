import { parseWire, wireArray, wireObject, wireString } from "../../lib/value-validation.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoStripResult } from "../../lib/settings-validator.js";
import { createStripDebouncer, watchSettingsFiles } from "../settings-watcher.js";

describe("createStripDebouncer — fake-timer unit tests", () => {
	let tmp: string;
	let settingsPath: string;
	let auditPath: string;

	beforeEach(() => {
		vi.useFakeTimers();
		tmp = mkdtempSync(join(tmpdir(), "interlinked-strip-debouncer-"));
		settingsPath = join(tmp, "settings.json");
		auditPath = join(tmp, "audit.jsonl");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs strip after the debounce window when a malformed rule is present", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{ permissions: { allow: ["Bash(ls *)", "Bash(PID=$(cat *)"] } },
				null,
				2,
			)}\n`,
		);
		const calls: AutoStripResult[] = [];
		const d = createStripDebouncer({
			cwd: tmp,
			paths: [settingsPath],
			auditLogPath: auditPath,
			debounceMs: 100,
			onStrip: (r: AutoStripResult) => calls.push(r),
		});

		d.trigger();
		// Before the window elapses: nothing.
		vi.advanceTimersByTime(50);
		expect(calls).toHaveLength(0);
		// After the window elapses: strip runs.
		vi.advanceTimersByTime(60);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.totalStripped).toBe(1);
		expect(calls[0]?.entries[0]?.rule).toBe("Bash(PID=$(cat *)");

		const after = parseWire(JSON.parse(readFileSync(settingsPath, "utf-8")), wireObject({ "permissions": wireObject({ "allow": wireArray(wireString) }) }), "test JSON value");
		expect(after.permissions.allow).toEqual(["Bash(ls *)"]);
	});

	it("coalesces rapid triggers into a single strip", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{
					permissions: {
						allow: ["Bash(A=$(x *)", "Bash(B=$(y *)", "Bash(C=$(z *)"],
					},
				},
				null,
				2,
			)}\n`,
		);
		const calls: AutoStripResult[] = [];
		const d = createStripDebouncer({
			cwd: tmp,
			paths: [settingsPath],
			auditLogPath: auditPath,
			debounceMs: 100,
			onStrip: (r: AutoStripResult) => calls.push(r),
		});

		// Three triggers inside the window — only one strip should run.
		d.trigger();
		vi.advanceTimersByTime(30);
		d.trigger();
		vi.advanceTimersByTime(30);
		d.trigger();
		vi.advanceTimersByTime(150);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.totalStripped).toBe(3);
	});

	it("does not invoke onStrip when no malformed rules are present", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{ permissions: { allow: ["Bash(ls *)", "Bash(DEMO_CWD=$(ls *))"] } },
				null,
				2,
			)}\n`,
		);
		const calls: AutoStripResult[] = [];
		const d = createStripDebouncer({
			cwd: tmp,
			paths: [settingsPath],
			auditLogPath: auditPath,
			debounceMs: 50,
			onStrip: (r: AutoStripResult) => calls.push(r),
		});

		d.trigger();
		vi.advanceTimersByTime(200);

		expect(calls).toHaveLength(0);
	});

	it("cancel() drops the pending strip", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{ permissions: { allow: ["Bash(X=$(y *)"] } },
				null,
				2,
			)}\n`,
		);
		const calls: AutoStripResult[] = [];
		const d = createStripDebouncer({
			cwd: tmp,
			paths: [settingsPath],
			auditLogPath: auditPath,
			debounceMs: 100,
			onStrip: (r: AutoStripResult) => calls.push(r),
		});

		d.trigger();
		vi.advanceTimersByTime(50);
		d.cancel();
		vi.advanceTimersByTime(200);

		expect(calls).toHaveLength(0);
		// File still has the malformed rule — strip never ran.
		const after = parseWire(JSON.parse(readFileSync(settingsPath, "utf-8")), wireObject({ "permissions": wireObject({ "allow": wireArray(wireString) }) }), "test JSON value");
		expect(after.permissions.allow).toEqual(["Bash(X=$(y *)"]);
	});

	it("appends one JSONL line per stripped rule to the audit log", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{
					permissions: {
						allow: ["Bash(PID=$(cat *)", "Bash(SESSIONS=$(find *)"],
					},
				},
				null,
				2,
			)}\n`,
		);
		const d = createStripDebouncer({
			cwd: tmp,
			paths: [settingsPath],
			auditLogPath: auditPath,
			debounceMs: 50,
			onStrip: () => {},
		});

		d.trigger();
		vi.advanceTimersByTime(100);

		const lines = readFileSync(auditPath, "utf-8")
			.split("\n")
			.filter((l: string) => l.trim().length > 0);
		expect(lines).toHaveLength(2);
		const records = lines.map((l: string) => JSON.parse(l));
		expect(records.map((r: { rule: string }) => r.rule)).toEqual([
			"Bash(PID=$(cat *)",
			"Bash(SESSIONS=$(find *)",
		]);
	});
});

describe("watchSettingsFiles — file-watching integration", () => {
	let tmp: string;
	let settingsPath: string;
	let auditPath: string;
	let cleanup: (() => void) | null;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-settings-watcher-"));
		settingsPath = join(tmp, "settings.json");
		auditPath = join(tmp, "audit.jsonl");
		cleanup = null;
	});

	afterEach(() => {
		cleanup?.();
		cleanup = null;
	});

	it("strips a malformed rule the moment Claude Code's UI writes it", async () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify({ permissions: { allow: ["Bash(ls *)"] } }, null, 2)}\n`,
		);
		const stripped: AutoStripResult[] = [];
		cleanup = watchSettingsFiles({
			cwd: tmp,
			paths: [settingsPath],
			auditLogPath: auditPath,
			pollIntervalMs: 50,
			debounceMs: 25,
			onStrip: (r: AutoStripResult) => stripped.push(r),
		});

		// Simulate Claude Code's "Always allow" UI writing a malformed
		// rule. `Bash(PID=$(cat *)` has 2 opens and 1 close — same
		// shape as audit log entries already on disk today.
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{ permissions: { allow: ["Bash(ls *)", "Bash(PID=$(cat *)"] } },
				null,
				2,
			)}\n`,
		);

		await vi.waitFor(
			() => {
				expect(stripped.length).toBeGreaterThan(0);
			},
			{ timeout: 3_000, interval: 25 },
		);

		expect(stripped[0]?.totalStripped).toBe(1);
		expect(stripped[0]?.entries[0]?.rule).toBe("Bash(PID=$(cat *)");
		expect(stripped[0]?.entries[0]?.reason).toBe("paren_imbalance");

		const after = parseWire(JSON.parse(readFileSync(settingsPath, "utf-8")), wireObject({ "permissions": wireObject({ "allow": wireArray(wireString) }) }), "test JSON value");
		expect(after.permissions.allow).toEqual(["Bash(ls *)"]);
	});
});
