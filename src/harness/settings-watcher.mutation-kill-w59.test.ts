import { nonNull } from "../lib/non-null.js";
// Mutation-kill suite for wave pass1_w59 survivors in settings-watcher.ts.
// The companion `../lib/settings-validator.js` module is fully mocked so
// every assertion targets the debounce/guard/wiring logic in this file
// only, with zero real filesystem writes (a tmpdir is still used for the
// `cwd` value passed through to mocked calls, for hygiene).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stripMalformedRulesAuditedMock = vi.fn();
const appendStripAuditLogMock = vi.fn();
const autoStripAllScopesMock = vi.fn();
const defaultSettingsPathsMock = vi.fn();
const defaultStripAuditLogPathMock = vi.fn();

vi.mock("../lib/settings-validator.js", () => ({
	stripMalformedRulesAudited: (...args: unknown[]) => stripMalformedRulesAuditedMock(...args),
	appendStripAuditLog: (...args: unknown[]) => appendStripAuditLogMock(...args),
	autoStripAllScopes: (...args: unknown[]) => autoStripAllScopesMock(...args),
	defaultSettingsPaths: (...args: unknown[]) => defaultSettingsPathsMock(...args),
	defaultStripAuditLogPath: (...args: unknown[]) => defaultStripAuditLogPathMock(...args),
}));

type WatchFile = (path: fs.PathLike, options: fs.WatchFileOptions, listener: (current: fs.Stats, previous: fs.Stats) => void) => void;
const watchFileMock = vi.fn<WatchFile>();
const unwatchFileMock = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watchFile: (...args: Parameters<WatchFile>) => watchFileMock(...args),
		unwatchFile: (...args: unknown[]) => unwatchFileMock(...args),
	};
});

import { createStripDebouncer, watchSettingsFiles } from "./settings-watcher.js";

function stripEntry(rule: string) {
	return { timestamp: "t", file: "/tmp/fileA", bucket: "allow", index: 0, rule, reason: "empty_rule" };
}

let tmpDir: string;

beforeEach(() => {
	vi.clearAllMocks();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-watcher-w59-"));
	stripMalformedRulesAuditedMock.mockReturnValue({ stripped: 0, entries: [] });
	appendStripAuditLogMock.mockReturnValue(undefined);
	autoStripAllScopesMock.mockReturnValue({ totalStripped: 0, entries: [] });
	defaultSettingsPathsMock.mockReturnValue([]);
	defaultStripAuditLogPathMock.mockReturnValue("/fake/audit.jsonl");
	watchFileMock.mockReturnValue(undefined);
	unwatchFileMock.mockReturnValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createStripDebouncer — runStrip in-flight guard", () => {
	it("blocks a synchronous re-entrant strip triggered from inside onStrip", () => {
		let callCount = 0;
		stripMalformedRulesAuditedMock.mockImplementation(() => {
			callCount++;
			return { stripped: 1, entries: [stripEntry(`bad-${callCount}`)] };
		});
		const seenAt: number[] = [];
		let debouncer: ReturnType<typeof createStripDebouncer>;
		const onStrip = vi.fn(() => {
			seenAt.push(callCount);
			if (seenAt.length === 1) debouncer.trigger();
		});
		debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip,
			paths: ["/tmp/fileA"],
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 0,
		});
		debouncer.trigger();
		expect(onStrip).toHaveBeenCalledTimes(1);
	});

	it("resets the in-flight guard so a fresh trigger after completion runs again", () => {
		stripMalformedRulesAuditedMock.mockReturnValue({ stripped: 1, entries: [stripEntry("bad")] });
		const onStrip = vi.fn();
		const debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip,
			paths: ["/tmp/fileA"],
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 0,
		});
		debouncer.trigger();
		expect(onStrip).toHaveBeenCalledTimes(1);
		debouncer.trigger();
		expect(onStrip).toHaveBeenCalledTimes(2);
	});

	it("routes to autoStripAllScopes only when paths is undefined", () => {
		autoStripAllScopesMock.mockReturnValue({ totalStripped: 0, entries: [] });
		const debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip: vi.fn(),
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 0,
		});
		debouncer.trigger();
		expect(autoStripAllScopesMock).toHaveBeenCalledTimes(1);
		expect(autoStripAllScopesMock).toHaveBeenCalledWith(tmpDir, "/tmp/audit.jsonl");
		expect(stripMalformedRulesAuditedMock).not.toHaveBeenCalled();
	});
});

describe("createStripDebouncer — trigger() timer bookkeeping", () => {
	it("does not call clearTimeout on the very first trigger (no pending timer yet)", () => {
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
		const debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip: vi.fn(),
			paths: ["/tmp/fileA"],
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 50,
		});
		try {
			debouncer.trigger();
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
		} finally {
			debouncer.cancel();
			clearTimeoutSpy.mockRestore();
		}
	});

	it("clears the previous timer so a rapid second trigger does not double-run the strip", () => {
		vi.useFakeTimers();
		stripMalformedRulesAuditedMock.mockReturnValue({ stripped: 1, entries: [stripEntry("bad")] });
		const onStrip = vi.fn();
		const debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip,
			paths: ["/tmp/fileA"],
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 50,
		});
		debouncer.trigger();
		debouncer.trigger();
		vi.advanceTimersByTime(100);
		expect(onStrip).toHaveBeenCalledTimes(1);
	});

	it("runs the strip synchronously when debounceMs is 0", () => {
		stripMalformedRulesAuditedMock.mockReturnValue({ stripped: 1, entries: [stripEntry("bad")] });
		const onStrip = vi.fn();
		const debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip,
			paths: ["/tmp/fileA"],
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 0,
		});
		debouncer.trigger();
		expect(onStrip).toHaveBeenCalledTimes(1);
	});

});

describe("createStripDebouncer — cancel()", () => {
	it("is a no-op when there is no pending timer", () => {
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
		const debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip: vi.fn(),
			paths: ["/tmp/fileA"],
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 50,
		});
		try {
			debouncer.cancel();
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
		} finally {
			clearTimeoutSpy.mockRestore();
		}
	});
});

describe("createStripDebouncer — scoped-paths aggregation edge cases", () => {
	it("does not append audit log entries when nothing was stripped", () => {
		stripMalformedRulesAuditedMock.mockReturnValue({ stripped: 0, entries: [] });
		const onStrip = vi.fn();
		const debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip,
			paths: ["/tmp/fileA"],
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 0,
		});
		debouncer.trigger();
		expect(appendStripAuditLogMock).not.toHaveBeenCalled();
		expect(onStrip).not.toHaveBeenCalled();
	});

	it("ignores stray entries reported alongside a zero stripped count", () => {
		stripMalformedRulesAuditedMock.mockReturnValue({ stripped: 0, entries: [stripEntry("stray")] });
		const debouncer = createStripDebouncer({
			cwd: tmpDir,
			onStrip: vi.fn(),
			paths: ["/tmp/fileA"],
			auditLogPath: "/tmp/audit.jsonl",
			debounceMs: 0,
		});
		debouncer.trigger();
		expect(appendStripAuditLogMock).not.toHaveBeenCalled();
	});
});

describe("watchSettingsFiles — watchFile wiring", () => {
	it("passes {interval: default} to watchFile for every path when pollIntervalMs is omitted", () => {
		stripMalformedRulesAuditedMock.mockReturnValue({ stripped: 0, entries: [] });
		const cleanup = watchSettingsFiles({
			cwd: tmpDir,
			onStrip: vi.fn(),
			paths: ["/tmp/fileA", "/tmp/fileB"],
			debounceMs: 5,
		});
		try {
			expect(watchFileMock).toHaveBeenCalledTimes(2);
			expect(watchFileMock).toHaveBeenNthCalledWith(1, "/tmp/fileA", { interval: 500 }, expect.any(Function));
			expect(watchFileMock).toHaveBeenNthCalledWith(2, "/tmp/fileB", { interval: 500 }, expect.any(Function));
		} finally {
			cleanup();
		}
	});

	it("invoking the watchFile change callback schedules another debounced strip", () => {
		vi.useFakeTimers();
		stripMalformedRulesAuditedMock.mockReturnValue({ stripped: 1, entries: [stripEntry("bad")] });
		const onStrip = vi.fn();
		const cleanup = watchSettingsFiles({
			cwd: tmpDir,
			onStrip,
			paths: ["/tmp/fileA"],
			debounceMs: 10,
		});
		vi.advanceTimersByTime(10);
		expect(onStrip).toHaveBeenCalledTimes(1);

		const onChange = nonNull(watchFileMock.mock.calls[0])[2];
		const stats = fs.statSync(tmpDir);
		onChange(stats, stats);
		vi.advanceTimersByTime(10);
		expect(onStrip).toHaveBeenCalledTimes(2);

		cleanup();
	});

	it("cleanup unwatches every path exactly once even if called twice", () => {
		const cleanup = watchSettingsFiles({
			cwd: tmpDir,
			onStrip: vi.fn(),
			paths: ["/tmp/fileA", "/tmp/fileB"],
			debounceMs: 0,
		});
		cleanup();
		expect(unwatchFileMock).toHaveBeenCalledTimes(2);
		expect(unwatchFileMock.mock.calls).toEqual([
			["/tmp/fileA", watchFileMock.mock.calls[0]?.[2]],
			["/tmp/fileB", watchFileMock.mock.calls[1]?.[2]],
		]);
		cleanup();
		expect(unwatchFileMock).toHaveBeenCalledTimes(2);
	});
});
