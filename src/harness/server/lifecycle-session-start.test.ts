import { afterEach, describe, expect, it, vi } from "vitest";
import { autoStripAllScopes, defaultStripAuditLogPath } from "../../lib/settings-validator.js";
import { refreshPriorityIfStale } from "../file-priority.js";
import { findRipgrep } from "../grep-accelerator.js";
import { resetProjectSetupWarningsCache } from "../evaluator/pre-tool.js";
import {
	autoStripSessionStartPermissions,
	refreshFilePriorityOnSessionStart,
	refreshTrigramIndexOnSessionStart,
} from "./lifecycle-session-start.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("../../lib/settings-validator.js", () => ({
	autoStripAllScopes: vi.fn(() => ({ totalStripped: 0, entries: [] })),
	defaultStripAuditLogPath: vi.fn(() => "/repo/.interlinked/permission-rule-strips.jsonl"),
	describeReason: vi.fn((r: string) => `reason:${r}`),
}));
vi.mock("../file-priority.js", () => ({
	refreshPriorityIfStale: vi.fn(() => new Map()),
}));
vi.mock("../grep-accelerator.js", () => ({
	findRipgrep: vi.fn(() => "/usr/bin/rg"),
}));
vi.mock("../evaluator/pre-tool.js", () => ({
	resetProjectSetupWarningsCache: vi.fn(),
}));

const mAutoStrip = vi.mocked(autoStripAllScopes);
const mDefaultAudit = vi.mocked(defaultStripAuditLogPath);
const mRefreshPriority = vi.mocked(refreshPriorityIfStale);
const mFindRipgrep = vi.mocked(findRipgrep);
const mResetSetupCache = vi.mocked(resetProjectSetupWarningsCache);

const bLog: string[] = [];
const bLogAlways: string[] = [];

function bCtx(over: Partial<ServerRuntime> = {}): ServerRuntime {
	return {
		cwd: "/repo",
		filePriorityMap: new Map(),
		trigramIndex: null,
		log: (msg: string) => {
			bLog.push(msg);
		},
		logAlways: (msg: string) => {
			bLogAlways.push(msg);
		},
		...over,
	} as unknown as ServerRuntime;
}

afterEach(() => {
	vi.clearAllMocks();
	bLog.length = 0;
	bLogAlways.length = 0;
	mDefaultAudit.mockReturnValue("/repo/.interlinked/permission-rule-strips.jsonl");
});

describe("refreshFilePriorityOnSessionStart", () => {
	it("assigns the refreshed map and logs when non-empty", () => {
		const refreshed = new Map([["a.ts", { score: 1 } as never]]);
		mRefreshPriority.mockReturnValue(refreshed);
		const ctx = bCtx();
		refreshFilePriorityOnSessionStart(ctx, ctx.log);
		expect(ctx.filePriorityMap).toBe(refreshed);
		expect(bLog.some((l) => l.includes("File-priority map refreshed: 1 entries"))).toBe(true);
	});

	it("does not reassign the map when the refresh is empty", () => {
		mRefreshPriority.mockReturnValue(new Map());
		const ctx = bCtx();
		const before = ctx.filePriorityMap;
		refreshFilePriorityOnSessionStart(ctx, ctx.log);
		expect(ctx.filePriorityMap).toBe(before);
	});

	it("swallows a refresh error non-fatally", () => {
		mRefreshPriority.mockImplementation(() => {
			throw new Error("git boom");
		});
		const ctx = bCtx();
		expect(() => refreshFilePriorityOnSessionStart(ctx, ctx.log)).not.toThrow();
		expect(bLog.some((l) => l.includes("File-priority refresh failed (non-fatal)"))).toBe(true);
	});
});

describe("refreshTrigramIndexOnSessionStart", () => {
	it("refreshes the index and logs when files were updated", () => {
		const trigramIndex = { incrementalUpdate: vi.fn(() => 7) };
		const ctx = bCtx({ trigramIndex: trigramIndex as never });
		refreshTrigramIndexOnSessionStart(ctx, ctx.log);
		expect(trigramIndex.incrementalUpdate).toHaveBeenCalled();
		expect(bLog.some((l) => l.includes("Trigram index refreshed: 7 files updated"))).toBe(true);
	});

	it("does not log a refresh when zero files updated", () => {
		const ctx = bCtx({ trigramIndex: { incrementalUpdate: vi.fn(() => 0) } as never });
		refreshTrigramIndexOnSessionStart(ctx, ctx.log);
		expect(bLog.some((l) => l.includes("Trigram index refreshed"))).toBe(false);
	});

	it("swallows an incrementalUpdate error non-fatally", () => {
		const trigramIndex = {
			incrementalUpdate: vi.fn(() => {
				throw new Error("index boom");
			}),
		} as never;
		const ctx = bCtx({ trigramIndex });
		expect(() => refreshTrigramIndexOnSessionStart(ctx, ctx.log)).not.toThrow();
		expect(bLog.some((l) => l.includes("Trigram index refresh failed (non-fatal)"))).toBe(true);
	});

	it("warns via logAlways when an index exists but ripgrep is missing", () => {
		mFindRipgrep.mockReturnValue(null);
		const ctx = bCtx({ trigramIndex: { incrementalUpdate: vi.fn(() => 0) } as never });
		refreshTrigramIndexOnSessionStart(ctx, ctx.log);
		expect(bLogAlways.some((l) => l.includes("ripgrep (rg) not found"))).toBe(true);
	});

	it("does NOT warn about ripgrep when rg is present", () => {
		mFindRipgrep.mockReturnValue("/usr/bin/rg");
		const ctx = bCtx({ trigramIndex: { incrementalUpdate: vi.fn(() => 0) } as never });
		refreshTrigramIndexOnSessionStart(ctx, ctx.log);
		expect(bLogAlways.some((l) => l.includes("ripgrep"))).toBe(false);
	});

	it("does NOT touch the trigram path when trigramIndex is null", () => {
		const ctx = bCtx({ trigramIndex: null });
		refreshTrigramIndexOnSessionStart(ctx, ctx.log);
		expect(mFindRipgrep).not.toHaveBeenCalled();
	});
});

describe("autoStripSessionStartPermissions", () => {
	it("returns null and does nothing when nothing was stripped", () => {
		mAutoStrip.mockReturnValue({ totalStripped: 0, entries: [] } as never);
		const ctx = bCtx();
		const out = autoStripSessionStartPermissions(ctx, ctx.log, []);
		expect(out).toBeNull();
		expect(mResetSetupCache).not.toHaveBeenCalled();
	});

	it("returns an allow decision, resets the setup cache, and logs when rules were stripped", () => {
		mAutoStrip.mockReturnValue({
			totalStripped: 2,
			entries: [
				{
					file: "/repo/.claude/settings.json",
					bucket: "allow",
					index: 0,
					rule: "Bash(-d *)",
					reason: "paren_imbalance",
				},
				{
					file: "/repo/.claude/settings.local.json",
					bucket: "deny",
					index: 1,
					rule: "",
					reason: "empty_rule",
				},
			],
		} as never);
		const ctx = bCtx();
		const out = autoStripSessionStartPermissions(ctx, ctx.log, ["heavy1"]);
		expect(out?.decision).toBe("allow");
		expect(out?.warnings?.[0]).toBe("heavy1");
		const warning = out?.warnings?.[1] ?? "";
		expect(warning).toContain("[interlinked:permission-strip] Auto-stripped 2 malformed");
		expect(mResetSetupCache).toHaveBeenCalled();
		expect(bLog.some((l) => l.includes("Auto-stripped 2 malformed permission rule(s)"))).toBe(
			true,
		);
	});

	it("truncates the preview list past 5 entries with a count suffix", () => {
		const entries = Array.from({ length: 7 }, (_, i) => ({
			file: `/repo/.claude/settings.json`,
			bucket: "allow",
			index: i,
			rule: `rule${i}`,
			reason: "empty_rule",
		}));
		mAutoStrip.mockReturnValue({ totalStripped: 7, entries } as never);
		const ctx = bCtx();
		const out = autoStripSessionStartPermissions(ctx, ctx.log, []);
		expect(out?.warnings?.[0]).toContain("...and 2 more");
	});

	it("swallows a strip error non-fatally and returns null", () => {
		mAutoStrip.mockImplementation(() => {
			throw new Error("strip boom");
		});
		const ctx = bCtx();
		expect(autoStripSessionStartPermissions(ctx, ctx.log, [])).toBeNull();
		expect(bLog.some((l) => l.includes("Permission-rule auto-strip failed (non-fatal)"))).toBe(
			true,
		);
	});
});
