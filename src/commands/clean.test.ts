import { wireAbsentOptional, parseWire, wireArray, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked clean — behavioral coverage
// ===========================================
// Deep behavioral tests for cleanCommand. Mocks the module boundaries
// (node:fs, ../lib/formatter, ../lib/output) so every branch is driven
// deterministically with no real filesystem, network, or wall-clock time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- node:fs mock -------------------------------------------------------
// A virtual filesystem keyed by absolute path. Directories map to string[]
// of entry names; files map to { mtimeMs, size, content }.
interface VFile {
	mtimeMs?: number;
	size?: number;
	content?: string;
	statThrows?: boolean;
}
type VFS = {
	dirs: Record<string, string[]>;
	files: Record<string, VFile>;
	existing: Set<string>;
	readdirThrows: Set<string>;
};

let vfs: VFS;

function freshVfs(): VFS {
	return { dirs: {}, files: {}, existing: new Set(), readdirThrows: new Set() };
}

const unlinked: string[] = [];
const written: Array<{ path: string; data: string }> = [];
const readPaths: string[] = [];

vi.mock("node:fs", () => ({
	existsSync: (p: string) => vfs.existing.has(p),
	readdirSync: (p: string) => {
		if (vfs.readdirThrows.has(p)) throw new Error(`EACCES readdir ${p}`);
		return vfs.dirs[p] ?? [];
	},
	statSync: (p: string) => {
		const f = vfs.files[p];
		if (!f || f.statThrows) throw new Error(`ENOENT stat ${p}`);
		return { mtimeMs: f.mtimeMs ?? 0, size: f.size ?? 0 };
	},
	readFileSync: (p: string) => {
		readPaths.push(p);
		const f = vfs.files[p];
		if (!f || f.content === undefined) throw new Error(`ENOENT read ${p}`);
		return f.content;
	},
	unlinkSync: (p: string) => {
		unlinked.push(p);
	},
	writeFileSync: (p: string, data: string) => {
		written.push({ path: p, data });
	},
}));

// ---- formatter mock: identity colors so output strings are plain --------
vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		green: (s: string) => s,
		yellow: (s: string) => s,
	},
	divider: () => "----DIVIDER----",
	header: (t: string) => `== ${t} ==`,
}));

// Use the REAL output.ts (pure dispatch over console.log) so we exercise
// the actual getOutputMode + output wiring rather than re-stubbing it.

import { nonNull } from "../lib/non-null.js";
import { cleanCommand } from "./clean.js";

const HOOK_SESSIONS = "/repo/.interlinked/hooks/agent-sessions";
const ACTIVITY = "/repo/.interlinked/activity.jsonl";
const LOCAL_SESSIONS = "/repo/.interlinked/sessions";
const CLAUDE_SETTINGS = "/repo/.claude/settings.json";
const GEMINI_SETTINGS = "/repo/.gemini/settings.json";
const CODEX_CONFIG = "/repo/.codex/config.toml";

const NOW = 1_700_000_000_000; // fixed epoch
const DAY = 24 * 60 * 60 * 1000;

let logs: string[];

function lastJson(): Record<string, unknown> {
	return parseWire(JSON.parse(nonNull(logs.at(-1))), wireRecord(wireUnknown), "test JSON value");
}
function allOutput(): string {
	return logs.join("\n");
}

beforeEach(() => {
	vfs = freshVfs();
	unlinked.length = 0;
	written.length = 0;
	readPaths.length = 0;
	logs = [];
	vi.spyOn(process, "cwd").mockReturnValue("/repo");
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ===========================================
// Empty / nothing-found path
// ===========================================

describe("clean — nothing to do", () => {
	it("normal mode: reports clean when no .interlinked dirs/files exist", async () => {
		await cleanCommand({});
		const out = allOutput();
		expect(out).toContain("== Clean (dry-run) ==");
		expect(out).toContain("No stale data found. Everything looks clean.");
		// early return: no divider / summary line
		expect(out).not.toContain("----DIVIDER----");
		expect(unlinked).toEqual([]);
		expect(written).toEqual([]);
	});

	it("json mode: empty payload, dry_run true by default", async () => {
		await cleanCommand({ json: true });
		const payload = lastJson();
		expect(payload.dry_run).toBe(true);
		expect(payload.stale_items).toEqual([]);
		expect(payload.removed).toEqual([]);
		expect(payload.total_found).toBe(0);
		expect(payload.total_removed).toBe(0);
	});

	it("header reads 'Clean' (not dry-run) when --force is passed", async () => {
		await cleanCommand({ force: true });
		expect(allOutput()).toContain("== Clean ==");
	});
});

// ===========================================
// 1. Stale hook session files
// ===========================================

describe("clean — stale hook session files", () => {
	beforeEach(() => {
		vfs.existing.add(HOOK_SESSIONS);
		vfs.dirs[HOOK_SESSIONS] = ["old.json", "fresh.json", "ghost.json"];
		// old: 30h ago -> stale; fresh: 1h ago -> kept; ghost: stat throws -> skipped
		vfs.files[`${HOOK_SESSIONS}/old.json`] = { mtimeMs: NOW - 30 * 60 * 60 * 1000 };
		vfs.files[`${HOOK_SESSIONS}/fresh.json`] = { mtimeMs: NOW - 1 * 60 * 60 * 1000 };
		vfs.files[`${HOOK_SESSIONS}/ghost.json`] = { statThrows: true };
	});

	it("dry-run: lists stale file, does NOT unlink, age in days", async () => {
		await cleanCommand({ json: true });
		const payload = lastJson();
		const items = parseWire(payload.stale_items, wireArray(wireObject({ "type": wireString, "path": wireString, "age": wireAbsentOptional(wireOptional(wireString)) })), "test JSON value");
		expect(items).toHaveLength(1);
		expect(nonNull(items[0]).type).toBe("session_file");
		expect(nonNull(items[0]).path).toBe(`${HOOK_SESSIONS}/old.json`);
		expect(nonNull(items[0]).age).toBe("1d"); // 30h -> floor(30/24)=1d
		expect(payload.removed).toEqual([]);
		expect(unlinked).toEqual([]);
	});

	it("dry-run normal output uses 'would remove' wording", async () => {
		await cleanCommand({});
		const out = allOutput();
		expect(out).toContain("Stale hook session files");
		expect(out).toContain(`would remove ${HOOK_SESSIONS}/old.json`);
		expect(out).toContain("Last modified 1d ago");
		expect(out).toContain("Found 1 item(s). Run 'interlinked clean --force' to remove.");
	});

	it("--force: unlinks stale file and records it as removed", async () => {
		await cleanCommand({ force: true });
		expect(unlinked).toEqual([`${HOOK_SESSIONS}/old.json`]);
		const out = allOutput();
		expect(out).toContain(`removed ${HOOK_SESSIONS}/old.json`);
		expect(out).toContain("Removed 1 item(s).");
	});

	it("25h-old file formats age as 1d (days branch of formatAge)", async () => {
		vfs.dirs[HOOK_SESSIONS] = ["h.json", "h2.json"];
		vfs.files = {
			[`${HOOK_SESSIONS}/h.json`]: { mtimeMs: NOW - 25 * 60 * 60 * 1000 },
			[`${HOOK_SESSIONS}/h2.json`]: { mtimeMs: NOW - 49 * 60 * 60 * 1000 },
		};
		await cleanCommand({ json: true });
		const items = parseWire(lastJson().stale_items, wireArray(wireObject({ "path": wireString, "age": wireAbsentOptional(wireOptional(wireString)) })), "test JSON value");
		const ageByPath = Object.fromEntries(items.map((i) => [i.path, i.age]));
		// Two different mtimes must floor to two different day buckets — proves
		// the "1d" above isn't a hardcoded default shared with the 30h-old case.
		expect(ageByPath[`${HOOK_SESSIONS}/h.json`]).toBe("1d"); // 25h -> 1d
		expect(ageByPath[`${HOOK_SESSIONS}/h2.json`]).toBe("2d"); // 49h -> 2d
	});

	it("readdir throwing on hook sessions dir is swallowed (treated empty)", async () => {
		vfs.readdirThrows.add(HOOK_SESSIONS);
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});
});

// NOTE: formatAge's `hours < 24` branch is unreachable from cleanCommand —
// formatAge is only ever called on items already older than the 24h stale
// threshold, so the elapsed age is always >= 24h. Recorded as untestable.

// ===========================================
// 2. Large activity log
// ===========================================

describe("clean — large activity log", () => {
	it("under threshold: not flagged", async () => {
		vfs.existing.add(ACTIVITY);
		vfs.files[ACTIVITY] = { size: 10 * 1024 * 1024 }; // 10MB
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});

	it("dry-run over threshold: flagged, no write", async () => {
		vfs.existing.add(ACTIVITY);
		vfs.files[ACTIVITY] = { size: 60 * 1024 * 1024 };
		await cleanCommand({ json: true });
		const items = parseWire(lastJson().stale_items, wireArray(wireObject({ "type": wireString, "detail": wireString })), "test JSON value");
		expect(items).toHaveLength(1);
		expect(nonNull(items[0]).type).toBe("large_activity_log");
		expect(nonNull(items[0]).detail).toContain("60.0 MB");
		expect(written).toEqual([]);
	});

	it("dry-run normal output uses 'would truncate'", async () => {
		vfs.existing.add(ACTIVITY);
		vfs.files[ACTIVITY] = { size: 55 * 1024 * 1024 };
		await cleanCommand({});
		const out = allOutput();
		expect(out).toContain("Large activity log");
		expect(out).toContain("would truncate");
	});

	it("--force: refuses a >16 MiB fallback before readFileSync when positional I/O is unavailable", async () => {
		vfs.existing.add(ACTIVITY);
		vfs.files[ACTIVITY] = { size: 60 * 1024 * 1024, content: "must-not-read\n" };
		await cleanCommand({ force: true });

		expect(readPaths).not.toContain(ACTIVITY);
		expect(written).toEqual([]);
		expect(allOutput()).toContain("not truncated");
		expect(allOutput()).toContain("Removed 0 item(s).");
	});

	it("--force json mode reports no removal when bounded truncation is unavailable", async () => {
		vfs.existing.add(ACTIVITY);
		vfs.files[ACTIVITY] = { size: 60 * 1024 * 1024, content: "a\nb\n" };
		await cleanCommand({ force: true, json: true });
		const payload = lastJson();
		expect(payload.removed).toEqual([]);
		expect(payload.dry_run).toBe(false);
		expect(payload.total_removed).toBe(0);
	});

	it("statSync throwing on activity log is swallowed", async () => {
		vfs.existing.add(ACTIVITY);
		vfs.files[ACTIVITY] = { statThrows: true };
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});
});

// ===========================================
// 3. Stale local sessions
// ===========================================

describe("clean — stale local sessions", () => {
	beforeEach(() => {
		vfs.existing.add(LOCAL_SESSIONS);
		vfs.dirs[LOCAL_SESSIONS] = ["old.json", "fresh.json", "notes.txt", "bad.json"];
		vfs.files[`${LOCAL_SESSIONS}/old.json`] = { mtimeMs: NOW - 2 * DAY };
		vfs.files[`${LOCAL_SESSIONS}/fresh.json`] = { mtimeMs: NOW - 3 * 60 * 60 * 1000 };
		vfs.files[`${LOCAL_SESSIONS}/notes.txt`] = { mtimeMs: NOW - 5 * DAY }; // non-json skipped
		vfs.files[`${LOCAL_SESSIONS}/bad.json`] = { statThrows: true };
	});

	it("dry-run: only stale .json flagged; .txt and stat-error skipped", async () => {
		await cleanCommand({ json: true });
		const items = parseWire(lastJson().stale_items, wireArray(wireObject({ "type": wireString, "path": wireString, "age": wireAbsentOptional(wireOptional(wireString)) })), "test JSON value");
		expect(items).toHaveLength(1);
		expect(nonNull(items[0]).type).toBe("stale_session");
		expect(nonNull(items[0]).path).toBe(`${LOCAL_SESSIONS}/old.json`);
		expect(nonNull(items[0]).age).toBe("2d");
		expect(unlinked).toEqual([]);
	});

	it("dry-run normal output renders stale local sessions section", async () => {
		await cleanCommand({});
		const out = allOutput();
		expect(out).toContain("Stale local sessions");
		expect(out).toContain(`would remove ${LOCAL_SESSIONS}/old.json`);
		expect(out).toContain("Session file last modified 2d ago");
	});

	it("--force: unlinks the stale local session", async () => {
		await cleanCommand({ force: true });
		expect(unlinked).toEqual([`${LOCAL_SESSIONS}/old.json`]);
		expect(allOutput()).toContain("Removed 1 item(s).");
	});

	it("readdir throwing on local sessions dir is swallowed", async () => {
		vfs.readdirThrows.add(LOCAL_SESSIONS);
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});
});

// ===========================================
// 4. Orphaned hook entries
// ===========================================

describe("clean — orphaned hook entries", () => {
	const orphanContent = "command: node /gone/interlinked-activity.mjs extra";

	it("flags orphan when referenced script is missing (Claude json settings)", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = { content: orphanContent };
		// /gone/interlinked-activity.mjs is NOT in existing -> orphan
		await cleanCommand({ json: true });
		const items = parseWire(lastJson().stale_items, wireArray(wireObject({ "type": wireString, "detail": wireString })), "test JSON value");
		expect(items).toHaveLength(1);
		expect(nonNull(items[0]).type).toBe("orphaned_hook");
		expect(nonNull(items[0]).detail).toContain("Claude Code");
		expect(nonNull(items[0]).detail).toContain("/gone/interlinked-activity.mjs");
	});

	it("does NOT flag when referenced script exists", async () => {
		vfs.existing.add(CODEX_CONFIG);
		vfs.files[CODEX_CONFIG] = {
			content: "command = 'node /here/interlinked-activity.mjs'",
		};
		vfs.existing.add("/here/interlinked-activity.mjs");
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});

	it("settings without interlinked-activity reference are ignored", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = { content: '{"hooks":{}}' };
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});

	it("mentions interlinked-activity but no .mjs match -> not orphan (hookMatch false)", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		vfs.files[GEMINI_SETTINGS] = { content: "interlinked-activity is referenced as text" };
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});

	it(".mjs present but no node-invocation pattern -> scriptPathMatch null branch", async () => {
		vfs.existing.add(GEMINI_SETTINGS);
		// has interlinked-activity.mjs token but not `node <path>.mjs`
		vfs.files[GEMINI_SETTINGS] = {
			content: "ref interlinked-activity.mjs without node prefix",
		};
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});

	it("readFileSync throwing on settings file is swallowed", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = {}; // no content -> readFileSync throws
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});

	it("nonexistent settings paths are skipped (continue branch)", async () => {
		// none added to existing
		await cleanCommand({ json: true });
		expect(lastJson().total_found).toBe(0);
	});

	it("orphan in normal dry-run renders 'found' + reinstall hint", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = { content: orphanContent };
		await cleanCommand({});
		const out = allOutput();
		expect(out).toContain("Orphaned hook entries");
		expect(out).toContain("found Claude Code: Hook references missing script");
		expect(out).toContain("Run 'interlinked enable' to reinstall hooks");
		expect(out).toContain("Found 1 item(s)");
	});

	it("orphan in --force mode renders the 'orphaned hook(s) found' tail", async () => {
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = { content: orphanContent };
		await cleanCommand({ force: true });
		const out = allOutput();
		// orphans are never removed, so removed=0 but the orphan tail must show
		expect(out).toContain("Removed 0 item(s).");
		expect(out).toContain("1 orphaned hook(s) found. Run 'interlinked enable' to fix.");
	});
});

// ===========================================
// Output mode coverage: short + full fall back to normal renderer
// ===========================================

describe("clean — output mode fallbacks", () => {
	// commander forwards --short/--full even though cleanCommand's declared
	// param type omits them; cast to exercise the short/full branches of
	// output() (both fall back to the normal renderer).

	it("short mode falls back to the normal renderer", async () => {
		await cleanCommand({ short: true });
		expect(allOutput()).toContain("== Clean (dry-run) ==");
	});

	it("full mode falls back to the normal renderer", async () => {
		await cleanCommand({ full: true });
		expect(allOutput()).toContain("== Clean (dry-run) ==");
	});
});

// ===========================================
// Combined: multiple categories at once (exercises all section blocks)
// ===========================================

describe("clean — combined categories in one run", () => {
	it("--force removes sessions + truncates log + reports orphan together", async () => {
		// hook session (stale)
		vfs.existing.add(HOOK_SESSIONS);
		vfs.dirs[HOOK_SESSIONS] = ["s.json"];
		vfs.files[`${HOOK_SESSIONS}/s.json`] = { mtimeMs: NOW - 3 * DAY };
		// activity log (large)
		vfs.existing.add(ACTIVITY);
		vfs.files[ACTIVITY] = { size: 80 * 1024 * 1024, content: "a\nb\nc\n" };
		// local session (stale)
		vfs.existing.add(LOCAL_SESSIONS);
		vfs.dirs[LOCAL_SESSIONS] = ["l.json"];
		vfs.files[`${LOCAL_SESSIONS}/l.json`] = { mtimeMs: NOW - 4 * DAY };
		// orphan hook
		vfs.existing.add(CLAUDE_SETTINGS);
		vfs.files[CLAUDE_SETTINGS] = { content: "node /missing/interlinked-activity.mjs" };

		await cleanCommand({ force: true });
		const out = allOutput();
		expect(out).toContain("Large activity log");
		expect(out).toContain("Stale hook session files");
		expect(out).toContain("Stale local sessions");
		expect(out).toContain("Orphaned hook entries");
		// unlinked: hook session + local session (not the log, not the orphan)
		expect(unlinked).toEqual([`${HOOK_SESSIONS}/s.json`, `${LOCAL_SESSIONS}/l.json`]);
		// Positional I/O is intentionally unavailable in this virtual filesystem,
		// so only the two session files are removed.
		expect(out).toContain("Removed 2 item(s).");
		expect(out).toContain("1 orphaned hook(s) found");
	});

	it("json payload aggregates all categories with totals", async () => {
		vfs.existing.add(HOOK_SESSIONS);
		vfs.dirs[HOOK_SESSIONS] = ["s.json"];
		vfs.files[`${HOOK_SESSIONS}/s.json`] = { mtimeMs: NOW - 3 * DAY };
		vfs.existing.add(ACTIVITY);
		vfs.files[ACTIVITY] = { size: 80 * 1024 * 1024 };
		await cleanCommand({ json: true });
		const payload = lastJson();
		expect(payload.total_found).toBe(2);
		expect(payload.dry_run).toBe(true);
		expect(payload.total_removed).toBe(0);
	});
});
