import { wireAbsentOptional, parseWire, wireNumber, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { c, header, kvLine } from "../lib/formatter.js";
import {
	guardCheckCommand,
	guardInstallCommand,
	guardStatusCommand,
	guardUninstallCommand,
} from "./guard.js";

// ===========================================
// Targeted mutation-kill tests for `interlinked guard` (src/commands/guard.ts).
//
// guard.test.ts already gives broad behavioral coverage, but its normal-mode
// assertions are mostly `.toContain()` substring checks — which cannot tell
// "warn" from "warnings", or distinguish the FIRST "removed"/"installed"
// occurrence (pre-commit) from the SECOND (pre-push) when both render the
// same word. Every case below builds its expected string from the REAL
// `header`/`kvLine`/`c` helpers (imported unmocked, same as guard.ts itself)
// and asserts full equality, so it is sensitive to every literal, ternary,
// and join-separator the source uses. Each case names the manifest survivor
// mutantId(s) it targets.
// ===========================================

const mockCallTool = vi.fn();
vi.mock("../lib/api-client.js", () => ({
	getClient: vi.fn(() => ({ callTool: mockCallTool })),
}));

const mockReadLocalConfig = vi.fn<() => unknown>(() => ({
	agent_name: "my-agent",
	guard_mode: "warn",
}));
const mockUpdateLocalConfig = vi.fn();
vi.mock("../lib/config.js", () => ({
	readLocalConfig: () => mockReadLocalConfig(),
	updateLocalConfig: (...args: unknown[]) => mockUpdateLocalConfig(...args),
	getConfigDir: () => "/test/.interlinked",
}));

const mockIsGitRepo = vi.fn(() => true);
const mockGetStagedFiles = vi.fn<() => string[]>(() => []);
const mockGetGitToplevel = vi.fn<() => string | null>(() => "/test/repo");
vi.mock("../lib/git-utils.js", () => ({
	isGitRepo: () => mockIsGitRepo(),
	getStagedFiles: () => mockGetStagedFiles(),
	getGitToplevel: () => mockGetGitToplevel(),
}));

const mockInstallGuardHook =
	vi.fn<(root: string, hook: string) => { installed: boolean; backed_up?: string }>();
const mockUninstallGuardHook =
	vi.fn<(root: string, hook: string) => { removed: boolean; restored?: string }>();
// Forwards `root` through (unlike a mock that ignores its args) so tests can
// assert on the ACTUAL string that reached this call — needed to observe the
// `getGitToplevel(cwd) || cwd` fallback mutant, which is otherwise invisible
// (both a real path and a stray `true` are truthy to every other consumer).
const mockGetGuardHookStatus =
	vi.fn<(root: string) => { pre_commit: boolean; pre_push: boolean }>(() => ({
		pre_commit: false,
		pre_push: false,
	}));
vi.mock("../lib/guard-hooks.js", () => ({
	installGuardHook: (root: string, hook: string) => mockInstallGuardHook(root, hook),
	uninstallGuardHook: (root: string, hook: string) => mockUninstallGuardHook(root, hook),
	getGuardHookStatus: (root: string) => mockGetGuardHookStatus(root),
	GUARD_CACHE_FILE: "guard-cache.json",
}));

vi.mock("../lib/glob-overlap.js", () => ({
	patternsOverlap: (file: string, pattern: string) => {
		const prefix = pattern.split(/[*?[]/)[0] ?? "";
		return file.startsWith(prefix);
	},
}));

const mockExistsSync = vi.fn<(p: string) => boolean>(() => false);
const mockReadFileSync = vi.fn<(p: string, enc?: string) => string>(() => "{}");
const mockWriteFileSync = vi.fn<typeof import("node:fs").writeFileSync>();
const mockMkdirSync = vi.fn();
vi.mock("node:fs", () => ({
	existsSync: (p: string) => mockExistsSync(p),
	readFileSync: (p: string, enc?: string) => mockReadFileSync(p, enc),
	writeFileSync: (...args: Parameters<typeof mockWriteFileSync>) => mockWriteFileSync(...args),
	mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let previousExitCode: number | string | undefined;

function logOutput(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((args) => String(args[0]))
		.join("\n");
}

function errOutput(): string {
	return vi
		.mocked(console.error)
		.mock.calls.map((args) => String(args[0]))
		.join("\n");
}

function lastLogJson(): Record<string, unknown> {
	const raw = vi.mocked(console.log).mock.calls.at(-1)?.[0];
	if (typeof raw !== "string") throw new Error(`expected string log, got ${typeof raw}`);
	return parseWire(JSON.parse(raw), wireRecord(wireUnknown), "test JSON value");
}

beforeEach(() => {
	vi.clearAllMocks();
	previousExitCode = process.exitCode;
	process.exitCode = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	mockReadLocalConfig.mockReturnValue({ agent_name: "my-agent", guard_mode: "warn" });
	mockIsGitRepo.mockReturnValue(true);
	mockGetStagedFiles.mockReturnValue([]);
	mockGetGitToplevel.mockReturnValue("/test/repo");
	mockInstallGuardHook.mockReturnValue({ installed: true });
	mockUninstallGuardHook.mockReturnValue({ removed: true });
	mockGetGuardHookStatus.mockReturnValue({ pre_commit: false, pre_push: false });
	mockExistsSync.mockReturnValue(false);
	mockReadFileSync.mockReturnValue("{}");
	mockCallTool.mockResolvedValue({ reservations: [] });
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	process.exitCode = previousExitCode;
});

// ===========================================
// guardInstallCommand — exact-render kills
// ===========================================

describe("guardInstallCommand — exact-render mutation kills", () => {
	function expectedInstallNormal(opts: {
		guardMode: string;
		preCommit: { installed: boolean; backed_up?: string };
		prePush?: { installed: boolean; backed_up?: string };
	}): string {
		const lines: string[] = [];
		lines.push(header("Guard Installed"));
		lines.push(
			kvLine("Mode", opts.guardMode === "block" ? c.red("block") : c.yellow("warn")),
		);
		lines.push(
			kvLine(
				"pre-commit",
				opts.preCommit.installed ? c.green("installed") : c.dim("already installed"),
			),
		);
		if (opts.preCommit.backed_up) {
			lines.push(kvLine("Backup", opts.preCommit.backed_up));
		}
		if (opts.prePush) {
			lines.push(
				kvLine(
					"pre-push",
					opts.prePush.installed ? c.green("installed") : c.dim("already installed"),
				),
			);
		}
		lines.push("");
		lines.push(c.dim("  Guard will check staged files against active reservations."));
		lines.push(
			c.dim(
				opts.guardMode === "block"
					? "  Commits with conflicts will be blocked."
					: "  Conflicts will show warnings but allow commits.",
			),
		);
		return lines.join("\n");
	}

	// test-contract: invariant — the rendered Mode/pre-commit lines and the
	// \n join separator must match exactly; a plain `.toContain("warn")`
	// passes even with a wrong Mode line because "warnings" appears lower
	// in this same render, masking the very literal being asserted.
	it("warn mode, fresh pre-commit install renders the exact expected text", async () => {
		mockInstallGuardHook.mockReturnValue({ installed: true });
		await guardInstallCommand({ mode: "warn" });
		expect(logOutput()).toBe(
			expectedInstallNormal({ guardMode: "warn", preCommit: { installed: true } }),
		);
	});

	// test-contract: invariant — every optional branch (Backup line, both
	// "already installed" vs "installed" wordings, both hook labels) must
	// render exactly in block mode; a substring check cannot tell the
	// pre-commit "installed" occurrence apart from the pre-push one.
	it("block mode, already-installed pre-commit with backup + fresh pre-push renders the exact expected text", async () => {
		mockInstallGuardHook.mockImplementation((_root, hook) =>
			hook === "pre-commit"
				? { installed: false, backed_up: "/test/repo/.git/hooks/pre-commit.bak" }
				: { installed: true },
		);
		await guardInstallCommand({ mode: "block", prePush: true });
		expect(logOutput()).toBe(
			expectedInstallNormal({
				guardMode: "block",
				preCommit: {
					installed: false,
					backed_up: "/test/repo/.git/hooks/pre-commit.bak",
				},
				prePush: { installed: true },
			}),
		);
	});
});

// ===========================================
// guardCheckCommand — optional-chaining + exact-render kills
// ===========================================

describe("guardCheckCommand — optional-chaining + exact-render mutation kills", () => {
	// test-contract: public-api — guardCheckCommand's documented contract is
	// to degrade safely (no agent filtering, mode "off") when local config
	// is absent, not throw; removing the `?.` on either agent_name or the
	// internal guard_mode read would crash mid-try and surface as an error.
	it("readLocalConfig() returning undefined does not crash (optional chaining)", async () => {
		mockReadLocalConfig.mockReturnValue(undefined);
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "other", path_pattern: "src/**" }],
		});
		await guardCheckCommand({ files: ["src/x.ts"], json: true });
		const out = lastLogJson();
		expect(out.clean).toBe(false);
		expect(out.mode).toBe("off");
		expect(out).toHaveProperty(["conflicts","length"], 1);
	});

	function expectedCheckNormal(opts: {
		clean: boolean;
		filesChecked: number;
		conflicts: Array<{
			file: string;
			reserved_by: string;
			reservation_pattern: string;
			expires_at?: string;
		}>;
		cached: boolean;
		cacheAgeSeconds?: number;
	}): string {
		if (opts.clean) {
			return c.green(`No reservation conflicts (${opts.filesChecked} files checked).`);
		}
		const lines: string[] = [];
		lines.push(
			c.yellow(
				`${opts.conflicts.length} reservation conflict${opts.conflicts.length === 1 ? "" : "s"} found:`,
			),
		);
		lines.push("");
		for (const conflict of opts.conflicts) {
			lines.push(
				`  ${c.red(conflict.file)} ${c.dim("reserved by")} ${c.bold(conflict.reserved_by)}`,
			);
			lines.push(
				`    ${c.dim("pattern:")} ${conflict.reservation_pattern}${conflict.expires_at ? c.dim(` (expires ${conflict.expires_at})`) : ""}`,
			);
		}
		if (opts.cached) {
			lines.push("");
			lines.push(
				c.dim(
					`  (using cached reservations${opts.cacheAgeSeconds ? `, ${opts.cacheAgeSeconds}s old` : ""})`,
				),
			);
		}
		return lines.join("\n");
	}

	// test-contract: boundary — at the zero-age boundary every blank-line
	// separator and the cache-age suffix must render exactly as empty, not
	// filler text; Date.now() is spied (a single accessor override, no real
	// elapsed time) so fetched_at and "now" land on the identical instant.
	it("cached conflict with zero-age renders the exact expected text", async () => {
		const FIXED_NOW = 1_700_000_000_000;
		mockCallTool.mockRejectedValue(new Error("down"));
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				reservations: [{ agent_name: "other", path_pattern: "src/**" }],
				fetched_at: new Date(FIXED_NOW).toISOString(),
			}),
		);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		try {
			await guardCheckCommand({ files: ["src/a.ts"] });
		} finally {
			nowSpy.mockRestore();
		}
		expect(logOutput()).toBe(
			expectedCheckNormal({
				clean: false,
				filesChecked: 1,
				conflicts: [{ file: "src/a.ts", reserved_by: "other", reservation_pattern: "src/**" }],
				cached: true,
				cacheAgeSeconds: 0,
			}),
		);
	});
});

// ===========================================
// guardStatusCommand — gitRoot fallback + optional-chaining + exact-render kills
// ===========================================

describe("guardStatusCommand — gitRoot fallback + optional-chaining + exact-render mutation kills", () => {
	// test-contract: public-api — the documented cwd fallback must pass the
	// real path string to hook-status lookup, not merely something truthy;
	// this mock forwards its argument so a stray boolean substitute for the
	// fallback is directly observable instead of masked by a truthy check.
	it("falls back to the real cwd string (not a boolean) when getGitToplevel returns null", async () => {
		mockGetGitToplevel.mockReturnValue(null);
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/fallback/cwd");
		try {
			await guardStatusCommand({ json: true });
		} finally {
			cwdSpy.mockRestore();
		}
		expect(mockGetGuardHookStatus).toHaveBeenCalledWith("/fallback/cwd");
	});

	// test-contract: public-api — guardStatusCommand's documented contract
	// is to resolve mode "off" when local config is absent, not throw; a
	// missing `?.` guard on the internal guard_mode read would crash mid-try.
	it("readLocalConfig() returning undefined resolves mode 'off' (optional chaining)", async () => {
		mockReadLocalConfig.mockReturnValue(undefined);
		await guardStatusCommand({ json: true });
		expect(lastLogJson().mode).toBe("off");
	});

	function expectedStatusNormal(opts: {
		guardMode: string;
		gitRoot: string | null;
		hookStatus: { pre_commit: boolean; pre_push: boolean };
		cache: { reservation_count: number; age_seconds: number } | null;
	}): string {
		const lines: string[] = [];
		lines.push(header("Guard Status"));
		lines.push(
			kvLine(
				"Mode",
				opts.guardMode === "off"
					? c.dim("off")
					: opts.guardMode === "block"
						? c.red("block")
						: c.yellow("warn"),
			),
		);
		lines.push(kvLine("Git repo", opts.gitRoot ? c.green("yes") : c.red("no")));
		lines.push(
			kvLine(
				"pre-commit",
				opts.hookStatus.pre_commit ? c.green("installed") : c.dim("not installed"),
			),
		);
		lines.push(
			kvLine(
				"pre-push",
				opts.hookStatus.pre_push ? c.green("installed") : c.dim("not installed"),
			),
		);
		if (opts.cache) {
			lines.push(
				kvLine(
					"Cache",
					`${opts.cache.reservation_count} reservations (${opts.cache.age_seconds}s old)`,
				),
			);
		} else {
			lines.push(kvLine("Cache", c.dim("empty")));
		}
		return lines.join("\n");
	}

	// test-contract: invariant — every kvLine label/value and the join
	// separator must render exactly; a substring check on "installed" can't
	// tell the pre-commit occurrence apart from the distinct pre-push one.
	it("git repo, both hooks installed renders the exact expected text", async () => {
		mockGetGuardHookStatus.mockReturnValue({ pre_commit: true, pre_push: true });
		mockReadLocalConfig.mockReturnValue({ agent_name: "me", guard_mode: "block" });
		mockExistsSync.mockReturnValue(false);
		await guardStatusCommand({});
		expect(logOutput()).toBe(
			expectedStatusNormal({
				guardMode: "block",
				gitRoot: "/test/repo",
				hookStatus: { pre_commit: true, pre_push: true },
				cache: null,
			}),
		);
	});

	// test-contract: mutation-kill — kills a5d73b98 ("no" string), d3268e77
	// ("not installed" ord0 — pre-commit), d13c9bf0 ("not installed" ord1 —
	// pre-push, distinct site from ord0). Not a git repo forces gitRoot to
	// null and hookStatus to the hardcoded both-false default.
	it("not a git repo renders the exact expected text", async () => {
		mockIsGitRepo.mockReturnValue(false);
		mockReadLocalConfig.mockReturnValue({ agent_name: "me", guard_mode: "warn" });
		mockExistsSync.mockReturnValue(false);
		await guardStatusCommand({});
		expect(logOutput()).toBe(
			expectedStatusNormal({
				guardMode: "warn",
				gitRoot: null,
				hookStatus: { pre_commit: false, pre_push: false },
				cache: null,
			}),
		);
	});
});

// ===========================================
// guardUninstallCommand — exact-render kills
// ===========================================

describe("guardUninstallCommand — exact-render mutation kills", () => {
	function expectedUninstallNormal(opts: {
		preCommit: { removed: boolean; restored?: string };
		prePush: { removed: boolean; restored?: string };
	}): string {
		const lines: string[] = [];
		lines.push(header("Guard Uninstalled"));
		lines.push(
			kvLine("pre-commit", opts.preCommit.removed ? c.green("removed") : c.dim("not found")),
		);
		if (opts.preCommit.restored) {
			lines.push(kvLine("Restored", opts.preCommit.restored));
		}
		lines.push(
			kvLine("pre-push", opts.prePush.removed ? c.green("removed") : c.dim("not found")),
		);
		if (opts.prePush.restored) {
			lines.push(kvLine("Restored", opts.prePush.restored));
		}
		lines.push(kvLine("Mode", c.dim("off")));
		return lines.join("\n");
	}

	// test-contract: mutation-kill — kills 612c11af (ArrayDeclaration),
	// e5b527da ("pre-commit" string), 17c065cf ("removed" ord0 —
	// pre-commit), 28e7290e ("Restored" ord0 — pre-commit's restore line),
	// e38ff7c3 ("pre-push" string), 9cf98776 ("not found" ord1 — pre-push),
	// 2d9ee878 ("Restored" ord1 — pre-push's restore line), 0264a63e (\n
	// join separator). guard.test.ts's `.toContain("removed")` cannot tell
	// which of the two "removed" occurrences (pre-commit vs pre-push) a
	// StringLiteral mutant erased when both render — full equality can.
	it("pre-commit removed with restore, pre-push not-found with restore renders the exact expected text", async () => {
		mockUninstallGuardHook.mockImplementation((_root, hook) =>
			hook === "pre-commit"
				? { removed: true, restored: "/restored/pre-commit" }
				: { removed: false, restored: "/restored/pre-push" },
		);
		await guardUninstallCommand({});
		expect(logOutput()).toBe(
			expectedUninstallNormal({
				preCommit: { removed: true, restored: "/restored/pre-commit" },
				prePush: { removed: false, restored: "/restored/pre-push" },
			}),
		);
	});

	// test-contract: mutation-kill — kills d6aba7ba ("not found" ord0 —
	// pre-commit), 738f36b4 ("removed" ord1 — pre-push). Complements the
	// case above by swapping which hook is removed vs not-found, with
	// neither restored.
	it("pre-commit not-found, pre-push removed (no restores) renders the exact expected text", async () => {
		mockUninstallGuardHook.mockImplementation((_root, hook) =>
			hook === "pre-commit" ? { removed: false } : { removed: true },
		);
		await guardUninstallCommand({});
		expect(logOutput()).toBe(
			expectedUninstallNormal({
				preCommit: { removed: false },
				prePush: { removed: true },
			}),
		);
	});
});

// ===========================================
// getReservations / writeGuardCache — private-helper kills
// ===========================================

describe("getReservations / writeGuardCache — private-helper mutation kills", () => {
	// test-contract: mutation-kill — kills ee015aa8 (`ageMs > CACHE_TTL_MS`
	// → `>=`) and b8257f22 (`ageMs / MS_PER_SECOND` → `*`). Date.now() is
	// spied to a fixed epoch (a single deterministic accessor override, not
	// fake timers and no real elapsed time) so ageMs lands EXACTLY on the
	// 5-minute TTL boundary, where `>` and `>=` diverge, and so
	// cache_age_seconds is a known, exact value the `/` vs `*` swap
	// obviously fails.
	it("cache aged exactly to the TTL boundary is not stale, and age_seconds divides (not multiplies) by 1000", async () => {
		const FIXED_NOW = 1_700_000_000_000;
		const CACHE_TTL_MS = 5 * 60 * 1000;
		mockCallTool.mockRejectedValue(new Error("down"));
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				reservations: [{ agent_name: "other", path_pattern: "src/**" }],
				fetched_at: new Date(FIXED_NOW - CACHE_TTL_MS).toISOString(),
			}),
		);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		try {
			await guardCheckCommand({ files: ["src/x.ts"], json: true });
		} finally {
			nowSpy.mockRestore();
		}
		expect(errOutput()).not.toContain("stale");
		expect(lastLogJson().cache_age_seconds).toBe(300);
	});

	// test-contract: mutation-kill — kills d6e76dafd67479f4 (guardStatusCommand's
	// `(Date.now() - new Date(cache.fetched_at).getTime()) / MS_PER_SECOND`
	// mutated `/` to `*`) and cbefeaade5601e64 (the inner `-` mutated to `+`).
	// FIXED_NOW and fetched_at are chosen 300_000ms apart so the three
	// candidate formulas — correct (300), `*` (300_000_000), and `+` (a huge
	// sum divided by 1000) — are all distinguishable from the expected value.
	it("guardStatusCommand cache age_seconds subtracts then divides by 1000, not adds or multiplies", async () => {
		const FIXED_NOW = 1_700_000_300_000;
		const FETCHED_AT = 1_700_000_000_000; // 300_000ms earlier
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				reservations: [{ agent_name: "other", path_pattern: "src/**" }],
				fetched_at: new Date(FETCHED_AT).toISOString(),
			}),
		);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
		try {
			await guardStatusCommand({ json: true });
		} finally {
			nowSpy.mockRestore();
		}
		const out = lastLogJson();
		const cache = parseWire(out.cache, wireObject({ "age_seconds": wireNumber }), "test JSON value");
		expect(cache.age_seconds).toBe(300);
		expect(cache.age_seconds).not.toBe(300_000_000); // would be `*` mutant
		expect(cache.age_seconds).not.toBeGreaterThan(1_000_000); // would be `+` mutant
	});

	// test-contract: mutation-kill — kills c989db90 (writeGuardCache's
	// `{ reservations, fetched_at: ... }` object literal collapsed to `{}`).
	// The JSON actually written to disk must carry the real reservations
	// array and an ISO fetched_at, not an empty object.
	it("writeGuardCache persists reservations + fetched_at (not an empty object)", async () => {
		mockCallTool.mockResolvedValue({
			reservations: [{ agent_name: "a", path_pattern: "x/**" }],
		});
		await guardCheckCommand({ files: ["x/y.ts"], json: true });
		expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
		const call = nonNull(mockWriteFileSync.mock.calls[0]);
		const written = parseWire(JSON.parse(parseWire(call[1], wireString, "guard cache write")), wireObject({ "reservations": wireAbsentOptional(wireOptional(wireUnknown)), "fetched_at": wireAbsentOptional(wireOptional(wireUnknown)) }), "test JSON value");
		expect(written.reservations).toEqual([{ agent_name: "a", path_pattern: "x/**" }]);
		expect(typeof written.fetched_at).toBe("string");
		expect(Number.isNaN(new Date(parseWire(written.fetched_at, wireString, "test JSON value")).getTime())).toBe(false);
	});
});
