// Behavioral unit tests for the four misc structural checks.
//
// All four functions are pure given their inputs except for two filesystem
// touches (`readFileSync` / `existsSync`, both from `node:fs`) and one clock
// read (`Date.now()` via `new Date()` arithmetic). We mock `node:fs` at the
// module boundary and drive the clock with vitest fake timers, so every test
// is fully deterministic. ProjectGraph / SessionTracker are stubbed with
// typed objects exposing only the methods each function consumes.
//
// Coverage goal: every branch — if/else, ternary, &&/||/??, the readFileSync
// catch, and each early-return guard. No tombstone tests; every case asserts
// a real returned StructuralCheckResult[] shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGraph } from "../project-graph.js";
import type { SessionTracker } from "../session-state.js";
import { makeSession as sessionFixture } from "../__tests__/fixtures/evaluator.js";
import type { SessionTrajectory } from "../types/session.js";
import type { HarnessEvent, ImportEdge } from "../types.js";

// --- node:fs mock ------------------------------------------------------------
// checkJSDocParamMismatch -> readFileSync; checkTestProximity -> existsSync.
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";
import {
	checkCoDependencyStaleness,
	checkInterfaceChangeImpact,
	checkJSDocParamMismatch,
	checkTestProximity,
} from "./misc-checks.js";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

// --- fixture helpers ---------------------------------------------------------

/** Minimal HarnessEvent — only `agent_name` is read by these checks. */
function makeEvent(agentName?: string): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s1",
		agent_source: "claude",
		...(agentName === undefined ? {} : { agent_name: agentName }),
		timestamp: "2026-06-05T00:00:00Z",
	};
}

/** A session trajectory stub with only the fields the checks read. */
function makeSession(opts: {
	agent_name: string;
	started_at?: string;
	files_read?: string[];
	files_written?: string[];
}): SessionTrajectory {
	return {
		...sessionFixture(),
		agent_name: opts.agent_name,
		started_at: opts.started_at ?? "2026-06-05T00:00:00Z",
		files_read: new Set(opts.files_read ?? []),
		files_written: new Set(opts.files_written ?? []),
	};
}

function makeSessions(list: SessionTrajectory[]): Pick<SessionTracker, "getAll"> {
	return {
		getAll: vi.fn().mockReturnValue(list),
	};
}

function edge(symbols: string[], fromFile: string): ImportEdge {
	return {
		fromFile,
		toFile: "/proj/target.ts",
		specifier: "./target",
		symbols,
		isTypeOnly: false,
	};
}

/** Stub graph exposing only the methods the misc checks consume. */
function makeGraph(opts: {
	dependents?: string[];
	interfaceBodies?: Map<string, string>;
	importers?: ImportEdge[];
	toRelative?: (f: string) => string;
}): Pick<ProjectGraph, "getDependents" | "getInterfaceBodies" | "getImporters" | "toRelative"> {
	return {
		getDependents: vi.fn().mockReturnValue(opts.dependents ?? []),
		getInterfaceBodies: vi.fn().mockReturnValue(opts.interfaceBodies ?? new Map()),
		getImporters: vi.fn().mockReturnValue(opts.importers ?? []),
		// Default toRelative strips a leading "/proj/" for readable assertions.
		toRelative: opts.toRelative ?? ((f: string) => f.replace(/^\/proj\//, "")),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ============================================================================
// checkCoDependencyStaleness
// ============================================================================

describe("checkCoDependencyStaleness", () => {
	const FILE = "/proj/target.ts";
	const REL = "target.ts";

	// Pin the clock so `now - new Date(started_at)` is deterministic.
	const NOW = new Date("2026-06-05T01:00:00Z").getTime();
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// test-contract: returns [] when the file has no dependents (L32 guard)
	it("returns [] when the file has no dependents (L32 guard)", () => {
		const graph = makeGraph({ dependents: [] });
		const sessions = makeSessions([
			makeSession({ agent_name: "other", files_read: ["/proj/dep.ts"] }),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
		// getAll must not be reached on the no-dependents fast path.
		expect(sessions.getAll).not.toHaveBeenCalled();
	});

	// test-contract: skips the editing agent's own session (L39 continue)
	it("skips the editing agent's own session (L39 continue)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		// Only session is the same agent doing the edit -> no affected agents.
		const sessions = makeSessions([
			makeSession({
				agent_name: "me",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
	});

	// test-contract: ignores a session that did not read any dependent (L42 false)
	it("ignores a session that did not read any dependent (L42 false)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "other",
				files_read: ["/proj/unrelated.ts"],
				started_at: "2026-06-05T00:59:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
	});

	// test-contract: ignores a stale session whose age exceeds the window (L47 false)
	it("ignores a stale session whose age exceeds the window (L47 false)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		// Started 2h ago; window is 1h -> sessionAge >= stalenessMs.
		const sessions = makeSessions([
			makeSession({
				agent_name: "other",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-04T23:00:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
	});

	// test-contract: warns when a recent other-agent session read a dependent (happy path)
	it("warns when a recent other-agent session read a dependent (happy path)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "alice",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:00Z", // 1 min ago < 1h window
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "co_dependency_staleness",
			severity: "info",
			file: FILE,
			affectedFiles: ["/proj/dep.ts"],
		});
		expect(nonNull(out[0]).message).toContain("alice recently read dep.ts");
		expect(nonNull(out[0]).message).toContain("These files import from target.ts");
	});

	// test-contract: uses empty agent name when event.agent_name is undefined (L30 ?? branch)
	it("uses empty agent name when event.agent_name is undefined (L30 ?? branch)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		// The editing session has agent_name "" — it should be skipped (L39),
		// while a named other agent fires the warning. This exercises the
		// `event.agent_name || ""` falsy branch.
		const sessions = makeSessions([
			makeSession({ agent_name: "", files_read: ["/proj/dep.ts"] }),
			makeSession({
				agent_name: "bob",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:30Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent(undefined), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("bob recently read");
		// The empty-name session must have been skipped, not reported.
		expect(nonNull(out[0]).message).not.toContain(" recently read dep.ts; ");
	});

	// test-contract: aggregates multiple files per agent and adds a +N overflow (L68-69 ternary true)
	it("aggregates multiple files per agent and adds a +N overflow (L68-69 ternary true)", () => {
		const deps = ["/proj/a.ts", "/proj/b.ts", "/proj/c.ts", "/proj/d.ts", "/proj/e.ts"];
		const graph = makeGraph({ dependents: deps });
		const sessions = makeSessions([
			makeSession({
				agent_name: "carol",
				files_read: deps,
				started_at: "2026-06-05T00:59:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		// First 3 listed, then " +2" overflow.
		expect(nonNull(out[0]).message).toContain("carol recently read a.ts, b.ts, c.ts +2");
	});

	// test-contract: does not add overflow when an agent read 3 or fewer deps (L69 ternary false)
	it("does not add overflow when an agent read 3 or fewer deps (L69 ternary false)", () => {
		const deps = ["/proj/a.ts", "/proj/b.ts", "/proj/c.ts"];
		const graph = makeGraph({ dependents: deps });
		const sessions = makeSessions([
			makeSession({
				agent_name: "dan",
				files_read: deps,
				started_at: "2026-06-05T00:59:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(nonNull(out[0]).message).toContain("dan recently read a.ts, b.ts, c.ts.");
		expect(nonNull(out[0]).message).not.toContain("+");
	});

	// test-contract: dedups two distinct agents into separate summaries (byAgent map, L67 multi-key)
	it("dedups two distinct agents into separate summaries (byAgent map, L67 multi-key)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "alice",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:00Z",
			}),
			makeSession({
				agent_name: "bob",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:58:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("alice recently read dep.ts");
		expect(nonNull(out[0]).message).toContain("bob recently read dep.ts");
		// Two summaries joined by "; ".
		expect(nonNull(out[0]).message).toContain("; ");
	});

	// test-contract: merges two sessions of the SAME agent into one summary (L61 `|| []` existing-array branch)
	it("merges two sessions of the SAME agent into one summary (L61 `|| []` existing-array branch)", () => {
		const graph = makeGraph({ dependents: ["/proj/a.ts", "/proj/b.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "eve",
				files_read: ["/proj/a.ts"],
				started_at: "2026-06-05T00:59:00Z",
			}),
			makeSession({
				agent_name: "eve",
				files_read: ["/proj/b.ts"],
				started_at: "2026-06-05T00:58:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		// Single "eve" summary listing both files (proves the `|| []` reused the
		// existing array on the second push for the same agent key).
		const eveCount = (nonNull(out[0]).message.match(/eve recently read/g) || []).length;
		expect(eveCount).toBe(1);
		expect(nonNull(out[0]).message).toContain("eve recently read a.ts, b.ts");
	});

	// test-contract: mutation-kill — event.agent_name fallback must be the
	// literal "" so a same-named "" session is excluded by the L39 own-agent
	// skip; a mutant default (e.g. "Stryker was here!") would let the
	// ""-named session through and produce a finding instead of [].
	it("mutation-kill: empty-string agent fallback self-excludes the anonymous session", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:30Z", // 30s ago, well within window
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent(undefined), graph, sessions, 3600);
		expect(out).toEqual([]);
	});

	// test-contract: mutation-kill — sessionAge must be STRICTLY less than
	// stalenessMs (an exact-equal age is excluded). A `<=` mutant would
	// include the boundary session and produce a finding instead of [].
	it("mutation-kill: session aged EXACTLY at the staleness window boundary is excluded", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		// NOW = 2026-06-05T01:00:00Z; window 3600s -> started exactly 1h ago.
		const sessions = makeSessions([
			makeSession({
				agent_name: "other",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:00:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
	});

	// test-contract: mutation-kill — the `results` accumulator must start as
	// a real empty array; a mutant seeding it with a stray element would
	// leak that element through the untouched final `return results`
	// fallthrough (dependents present, but no agent ends up affected).
	it("mutation-kill: falls through to an untouched, genuinely-empty results array", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		// Dependent exists but the only session read something unrelated ->
		// affectedAgents stays empty via a DIFFERENT guard than the L39 own-
		// agent skip, exercising the final `return results` fallthrough.
		const sessions = makeSessions([
			makeSession({
				agent_name: "other",
				files_read: ["/proj/unrelated.ts"],
				started_at: "2026-06-05T00:59:30Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
		expect(Array.isArray(out)).toBe(true);
		expect(out).toHaveLength(0);
	});
});

// ============================================================================
// checkJSDocParamMismatch
// ============================================================================

describe("checkJSDocParamMismatch", () => {
	const FILE = "/proj/foo.ts";
	const REL = "foo.ts";

	// test-contract: returns [] for non-JS/TS extensions without reading the file (L95 guard)
	it("returns [] for non-JS/TS extensions without reading the file (L95 guard)", () => {
		const out = checkJSDocParamMismatch("/proj/readme.md", "readme.md");
		expect(out).toEqual([]);
		expect(mockReadFileSync).not.toHaveBeenCalled();
	});

	// test-contract: reads the file for supported extension %s
	it.each([".ts", ".tsx", ".js", ".jsx"])(
		"reads the file for supported extension %s",
		(ext) => {
			mockReadFileSync.mockReturnValue("const x = 1;\n");
			const out = checkJSDocParamMismatch(`/proj/foo${ext}`, `foo${ext}`);
			expect(out).toEqual([]);
			expect(mockReadFileSync).toHaveBeenCalledTimes(1);
		},
	);

	// test-contract: returns [] when readFileSync throws (L100 catch)
	it("returns [] when readFileSync throws (L100 catch)", () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toEqual([]);
	});

	// test-contract: flags a JSDoc @param name that is not an actual parameter (happy path)
	it("flags a JSDoc @param name that is not an actual parameter (happy path)", () => {
		// @param "oldName" doesn't appear in (name, age).
		const src = [
			"/**",
			" * Greet someone.",
			" * @param {string} oldName - mismatched",
			" * @param age - matches",
			" */",
			"function greet(name, age) {",
			"  return name;",
			"}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "jsdoc_param_mismatch",
			severity: "warning",
			file: FILE,
		});
		expect(nonNull(out[0]).message).toContain('JSDoc @param "oldName"');
		expect(nonNull(out[0]).message).toContain("[name, age]");
		expect(nonNull(out[0]).message).toContain("foo.ts:6");
	});

	// test-contract: does not flag when every @param matches the parameters (L154 false)
	it("does not flag when every @param matches the parameters (L154 false)", () => {
		const src = [
			"/**",
			" * @param name",
			" * @param age",
			" */",
			"function greet(name, age) {",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: skips lines that are not function declarations (L112 continue)
	it("skips lines that are not function declarations (L112 continue)", () => {
		mockReadFileSync.mockReturnValue("const a = 1;\nlet b = 2;\n");
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: skips a function with an empty parameter list (L116 !paramStr.trim continue)
	it("skips a function with an empty parameter list (L116 !paramStr.trim continue)", () => {
		const src = ["/**", " * @param ghost", " */", "function noargs() {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		// noargs() has paramStr "" -> trimmed empty -> continue before JSDoc scan.
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: skips when param parsing yields no names after destructure filtering (L129 continue)
	it("skips when param parsing yields no names after destructure filtering (L129 continue)", () => {
		// `{ }` -> split/filter drops "{" and "}" leaving zero param names.
		// We reach a match via `foo(( ... ))` shape so funcMatch[1] is "{ }".
		const src = ["/**", " * @param phantom", " */", "wrap(({ }) => {})"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: returns [] when a matching function has no preceding JSDoc (L150 continue)
	it("returns [] when a matching function has no preceding JSDoc (L150 continue)", () => {
		mockReadFileSync.mockReturnValue("function greet(name, age) {\n  return name;\n}\n");
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: stops the backward scan at the /** opener (L139 break)
	it("stops the backward scan at the /** opener (L139 break)", () => {
		// The @param above the /** line must NOT be collected: the loop breaks
		// at "/**". Here the only @param is inside the block, and it matches,
		// so no finding — and a stray @param ABOVE the opener is ignored.
		const src = [
			" * @param strayAbove",
			"/**",
			" * @param name",
			" */",
			"function greet(name) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		// strayAbove would mismatch if collected; it must not be.
		expect(out).toEqual([]);
	});

	// test-contract: stops the backward scan at a non-comment, non-blank line (L141-147 break)
	it("stops the backward scan at a non-comment, non-blank line (L141-147 break)", () => {
		// An intervening code statement between a stray @param and the function
		// halts the scan, so the stray @param is never gathered.
		const src = [
			" * @param strayBlocked",
			"const SEPARATOR = 1;",
			"function greet(name) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: allows blank lines and // comments inside the backward scan (L141-147 continue path)
	it("allows blank lines and // comments inside the backward scan (L141-147 continue path)", () => {
		// Blank line + // line do NOT break the scan, so the mismatched @param
		// above them is collected and fires.
		const src = [
			" * @param mismatchHere",
			"//",
			"",
			"function greet(name) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"mismatchHere"');
	});

	// test-contract: caps the backward scan ~30 lines above the function (L133 Math.max bound)
	it("caps the backward scan ~30 lines above the function (L133 Math.max bound)", () => {
		// A mismatched @param 40 lines above is out of the 30-line window;
		// the comment chain is unbroken (all blank), so the only thing that
		// could fire is out of range -> no finding.
		const lines: string[] = [" * @param wayUp"];
		for (let i = 0; i < 40; i++) lines.push("");
		lines.push("function greet(name) {}");
		mockReadFileSync.mockReturnValue(lines.join("\n"));
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: caps output at 5 findings (L163 break)
	it("caps output at 5 findings (L163 break)", () => {
		// Build 7 mismatched function+JSDoc blocks; only 5 should be reported.
		const block = (n: number) =>
			["/**", ` * @param wrong${n}`, " */", `function fn${n}(real${n}) {}`].join("\n");
		const src = Array.from({ length: 7 }, (_, i) => block(i)).join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(5);
		expect(out.every((r) => r.check === "jsdoc_param_mismatch")).toBe(true);
	});

	// test-contract: matches @param tags without a {type} prefix (regex optional group)
	it("matches @param tags without a {type} prefix (regex optional group)", () => {
		const src = ["/**", " * @param typeless", " */", "function greet(name) {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"typeless"');
	});

	// test-contract: mutation-kill — readFileSync must be called with the
	// exact "utf-8" encoding so bytes decode to a real string; a mutant
	// blanking the encoding arg is invisible unless the call args are spied.
	it("mutation-kill: reads the file with the exact utf-8 encoding argument", () => {
		mockReadFileSync.mockReturnValue("function greet(name) {}\n");
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(mockReadFileSync).toHaveBeenCalledWith(FILE, "utf-8");
		expect(out).toEqual([]);
	});

	// test-contract: mutation-kill — the backward scan must break the
	// instant it finds a line ENDING in "/**" via startsWith, not endsWith;
	// a `startsWith->endsWith` swap misfires on a normal "*"-continuation
	// line that happens to end in that text and stops the scan too early,
	// dropping an earlier @param the swap-free code would have collected.
	it("mutation-kill: only a line ENDING in /** stops the backward scan (startsWith not endsWith)", () => {
		const src = [
			" * @param realAbove",
			" * @param spurious /**",
			"function greet(spurious) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"realAbove"');
	});

	// test-contract: mutation-kill — same swap for the "//" pass-through
	// check: only a line ENDING in "//" must be excluded from continuing;
	// a startsWith->endsWith swap misreads a normal "//"-prefixed comment
	// as a boundary and halts the scan before an earlier @param.
	it("mutation-kill: only a line ENDING in // is treated specially (startsWith not endsWith)", () => {
		const src = [
			" * @param realAbove",
			"// trailing //",
			"function greet(realAbove) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		// Under original: "// trailing //" starts with "//" -> pass-through,
		// scan continues to "realAbove" -> jsdocParams=["realAbove"] matches
		// the real param -> NO mismatch -> [].
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: mutation-kill — the "starts with *" pass-through check
	// must use the TRIMMED line; on raw (untrimmed) text, leading
	// indentation before "*" defeats startsWith and incorrectly halts the
	// backward scan, dropping an earlier @param that should be collected.
	it("mutation-kill: an indented '*' comment line does not halt the backward scan", () => {
		const src = [
			" * @param topAbove",
			"   * @param name", // indented — trim() is required to see the leading "*"
			"function greet(onlyReal) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		// Full scan must reach "topAbove"; a trim-dropped check halts before it.
		expect(nonNull(out[0]).message).toContain('"topAbove"');
	});

	// test-contract: mutation-kill — the "starts with //" pass-through check
	// must use the TRIMMED line; on raw text, an indented "//" comment
	// defeats startsWith and incorrectly halts the scan, losing an earlier
	// @param entirely (and thus losing the finding altogether).
	it("mutation-kill: an indented '//' comment line does not halt the backward scan", () => {
		const src = [" * @param aboveComment", "   // spacer", "function greet(realOnly) {}"].join(
			"\n",
		);
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"aboveComment"');
	});

	// test-contract: mutation-kill — the blank-line check must use the
	// TRIMMED line; on raw text a whitespace-only line (non-empty string)
	// incorrectly reads as "non-blank" and halts the scan before an
	// earlier @param, losing the finding entirely.
	it("mutation-kill: a whitespace-only line is treated as blank, not a scan boundary", () => {
		const src = [" * @param aboveBlank", "   ", "function greet(realOnly) {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"aboveBlank"');
	});

	// test-contract: mutation-kill — multiple mismatched names must be
	// joined with the exact `", "` separator; an emptied separator would
	// concatenate them unreadably with no distinguishing punctuation.
	it("mutation-kill: joins multiple mismatched @param names with a comma-space separator", () => {
		const src = ["/**", " * @param wrongA", " * @param wrongB", " */", "function f(real) {}"].join(
			"\n",
		);
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		// Backward scan collects nearest-to-function first, so wrongB (closer
		// to the function signature) precedes wrongA in the pushed order.
		expect(nonNull(out[0]).message).toContain('"wrongB", "wrongA"');
	});

	// test-contract: mutation-kill — the funcMatch regex requires ONE-OR-MORE
	// whitespace chars after "function"; a `\s+` -> `\s` mutant fails to
	// match double-spaced declarations, silently skipping the line (and its
	// mismatch) entirely.
	it("mutation-kill: matches 'function' followed by MULTIPLE spaces before the name", () => {
		const src = ["/**", " * @param oldName", " */", "function  greet(name) {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"oldName"');
	});

	// test-contract: mutation-kill — the double-paren callback form (an
	// identifier immediately followed by two adjacent "(") must work when
	// NO leading identifier precedes it; a mutant that makes the leading
	// `(?:\w+\s*)?` group mandatory (instead of optional) breaks this
	// zero-identifier case, silently skipping the line.
	it("mutation-kill: matches a double-paren callback with no leading identifier", () => {
		const src = ["/**", " * @param oldName", " */", "((real1, real2) => {});"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"oldName"');
		expect(nonNull(out[0]).message).toContain("[real1, real2]");
	});

	// test-contract: mutation-kill — the double-paren callback form still
	// requires an actual WORD-CHAR identifier before it; a `\w+` -> `\W+`
	// mutant (or a `\w+` -> `\w` single-char mutant, or a `\w+\s*` -> `\w+\s`
	// mandatory-trailing-space mutant) breaks the ordinary "wrap((...))"
	// shape entirely, silently skipping the line.
	it("mutation-kill: matches a double-paren callback with a plain word-char identifier prefix", () => {
		const src = ["/**", " * @param oldName", " */", "wrap((real1, real2) => {})"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"oldName"');
		expect(nonNull(out[0]).message).toContain("[real1, real2]");
	});

	// test-contract: mutation-kill — the outer `\s*\(` (whitespace then the
	// opening paren) must tolerate a SPACE between the matched prefix and
	// the parameter list; a `\s*` -> `\S*` mutant requires a NON-whitespace
	// run there instead, breaking the (valid) "function greet (args)" form.
	it("mutation-kill: matches when whitespace separates the name from the parameter list", () => {
		const src = ["/**", " * @param oldName", " */", "function greet (name) {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"oldName"');
	});

	// test-contract: mutation-kill — the @param regex requires ONE-OR-MORE
	// whitespace chars right after "@param"; a `\s+` -> `\s` mutant fails
	// on a double-spaced @param line, so it never enters jsdocParams and
	// the mismatch it should have raised is silently dropped.
	it("mutation-kill: matches @param followed by MULTIPLE spaces before the name", () => {
		const src = ["/**", " * @param  ghostName", " */", "function greet(real) {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"ghostName"');
	});

	// test-contract: mutation-kill — same for the whitespace right after a
	// {type} annotation's closing brace; a `\s+` -> `\s` mutant there fails
	// on a double-spaced "@param {type}  name" line.
	it("mutation-kill: matches @param {type} followed by MULTIPLE spaces before the name", () => {
		const src = ["/**", " * @param {string}  ghostName", " */", "function greet(real) {}"].join(
			"\n",
		);
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"ghostName"');
	});

	// test-contract: mutation-kill — the rest-param "..." strip must be
	// ANCHORED to the start (`/^\.\.\./`); an unanchored mutant strips the
	// FIRST "..." found ANYWHERE, mangling a param name that merely
	// contains an ellipsis mid-string instead of leaving it untouched.
	it("mutation-kill: does not strip a mid-string ellipsis from a non-rest parameter", () => {
		const src = ["/**", " * @param foobar", " */", "function greet(foo...bar) {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		// Original: real param name stays "foo...bar" (unanchored strip would
		// instead yield "foobar", matching the JSDoc tag and hiding the bug).
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain('"foobar"');
		expect(nonNull(out[0]).message).toContain("[foo...bar]");
	});

	// test-contract: mutation-kill — a leading "..." must be replaced with
	// the empty string, not garbage text; a mutant replacement text would
	// glue itself onto the remaining param name, breaking the match against
	// a correctly-named JSDoc @param.
	it("mutation-kill: strips a leading rest-param ellipsis down to just the name", () => {
		const src = ["/**", " * @param rest", " */", "function greet(...rest) {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		// Original: "...rest" -> "rest", matches the JSDoc tag -> no mismatch.
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	// test-contract: mutation-kill — a lone "}" token produced by the
	// destructure-name split must be filtered OUT (same as "{"); a mutant
	// that neutralizes the `n !== "}"` filter clause (constant-folded to
	// `true`, or compared against "" instead of "}") lets it survive into
	// paramNames, causing a spurious mismatch against an unrelated JSDoc tag.
	it("mutation-kill: filters a lone '}' destructure token out of paramNames", () => {
		const src = ["/**", " * @param ghost", " */", "function greet(}) {"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		// Original: paramNames ends up [] (the "}" is filtered) -> L130
		// continue -> no finding, regardless of the unrelated "ghost" tag.
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});
});

// ============================================================================
// checkInterfaceChangeImpact
// ============================================================================

describe("checkInterfaceChangeImpact", () => {
	const FILE = "/proj/types.ts";
	const REL = "types.ts";

	// test-contract: returns [] when no interface bodies changed (L194 guard)
	it("returns [] when no interface bodies changed (L194 guard)", () => {
		const oldBodies = new Map([["Foo", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a: number }"]]), // identical
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toEqual([]);
		// No dependents lookup needed when nothing changed.
		expect(graph.getDependents).not.toHaveBeenCalled();
	});

	// test-contract: detects a removed interface (L187 !newBody -> Removed)
	it("detects a removed interface (L187 !newBody -> Removed)", () => {
		const oldBodies = new Map([["Gone", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map(), // "Gone" no longer present
			dependents: ["/proj/importer.ts"],
			importers: [edge(["Gone"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("`Gone`");
		expect(nonNull(out[0]).message).toContain("importer.ts");
	});

	// test-contract: detects a modified interface body (L189 oldBody !== newBody -> Modified)
	it("detects a modified interface body (L189 oldBody !== newBody -> Modified)", () => {
		const oldBodies = new Map([["Foo", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a: number; b: string }"]]),
			dependents: ["/proj/importer.ts"],
			importers: [edge(["Foo"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "interface_change_impact",
			severity: "warning",
			file: FILE,
			affectedFiles: ["/proj/importer.ts"],
		});
		expect(nonNull(out[0]).message).toContain("Verify implementations are updated");
	});

	// test-contract: returns [] when a changed interface has no dependents (L198 guard)
	it("returns [] when a changed interface has no dependents (L198 guard)", () => {
		const oldBodies = new Map([["Foo", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a: number; b: string }"]]),
			dependents: [], // changed but nothing depends on the file
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toEqual([]);
		// Importers lookup is skipped on the no-dependents path.
		expect(graph.getImporters).not.toHaveBeenCalled();
	});

	// test-contract: returns [] when dependents exist but none import a changed symbol (L203 some false -> L209 false)
	it("returns [] when dependents exist but none import a changed symbol (L203 some false -> L209 false)", () => {
		const oldBodies = new Map([["Foo", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a: number; b: string }"]]),
			dependents: ["/proj/importer.ts"],
			// importer pulls a DIFFERENT symbol, so usesChanged is false.
			importers: [edge(["Bar"], "/proj/importer.ts")],
		});
		expect(checkInterfaceChangeImpact(FILE, REL, oldBodies, graph)).toEqual([]);
	});

	// test-contract: truncates the changed-interface name list past 4 with +N (L211 ternary true)
	it("truncates the changed-interface name list past 4 with +N (L211 ternary true)", () => {
		const old = new Map<string, string>();
		for (const n of ["I1", "I2", "I3", "I4", "I5", "I6"]) old.set(n, `{ ${n} }`);
		const graph = makeGraph({
			interfaceBodies: new Map(), // all 6 removed
			dependents: ["/proj/importer.ts"],
			importers: [edge(["I1", "I2", "I3", "I4", "I5", "I6"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, old, graph);
		expect(out).toHaveLength(1);
		// First 4 names listed, then " +2".
		expect(nonNull(out[0]).message).toContain("I1, I2, I3, I4 +2");
	});

	// test-contract: does not truncate names at exactly 4 changed interfaces (L211 ternary false)
	it("does not truncate names at exactly 4 changed interfaces (L211 ternary false)", () => {
		const old = new Map<string, string>();
		for (const n of ["I1", "I2", "I3", "I4"]) old.set(n, `{ ${n} }`);
		const graph = makeGraph({
			interfaceBodies: new Map(),
			dependents: ["/proj/importer.ts"],
			importers: [edge(["I1", "I2", "I3", "I4"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, old, graph);
		// Names are wrapped in backticks: `I1, I2, I3, I4` with no +N overflow.
		expect(nonNull(out[0]).message).toContain("`I1, I2, I3, I4`");
		expect(nonNull(out[0]).message).not.toContain("+");
	});

	// test-contract: truncates the affected-file list past 6 with 'and N more' (L216 ternary true)
	it("truncates the affected-file list past 6 with 'and N more' (L216 ternary true)", () => {
		const oldBodies = new Map([["Foo", "{ a }"]]);
		const importerFiles = Array.from({ length: 8 }, (_, i) => `/proj/imp${i}.ts`);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a; b }"]]),
			dependents: ["/proj/any.ts"],
			importers: importerFiles.map((f) => edge(["Foo"], f)),
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		// 6 files listed + "and 2 more".
		expect(nonNull(out[0]).message).toContain("and 2 more");
		expect(nonNull(out[0]).affectedFiles).toHaveLength(8);
	});

	// test-contract: does not append 'and N more' at exactly 6 affected files (L216 ternary false)
	it("does not append 'and N more' at exactly 6 affected files (L216 ternary false)", () => {
		const oldBodies = new Map([["Foo", "{ a }"]]);
		const importerFiles = Array.from({ length: 6 }, (_, i) => `/proj/imp${i}.ts`);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a; b }"]]),
			dependents: ["/proj/any.ts"],
			importers: importerFiles.map((f) => edge(["Foo"], f)),
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(nonNull(out[0]).message).not.toContain("more");
		expect(nonNull(out[0]).affectedFiles).toHaveLength(6);
	});

	// test-contract: mutation-kill — an importer must be flagged when it uses
	// ANY (`.some`) of the changed interfaces, not ALL (`.every`) of them; a
	// `.some` -> `.every` mutant misses a real importer that pulls a mix of
	// changed and unchanged symbols.
	it("mutation-kill: flags an importer that uses SOME but not ALL changed interfaces", () => {
		const oldBodies = new Map([
			["Foo", "{ a: number }"],
			["Bar", "{ b: string }"],
		]);
		const graph = makeGraph({
			interfaceBodies: new Map([
				["Foo", "{ a: number; c: boolean }"], // changed
				["Bar", "{ b: string }"], // unchanged
			]),
			dependents: ["/proj/importer.ts"],
			// Importer pulls both Foo (changed) and Bar (unchanged).
			importers: [edge(["Foo", "Bar"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).affectedFiles).toEqual(["/proj/importer.ts"]);
	});

	// test-contract: mutation-kill — the affected-file list in the MESSAGE
	// must be capped at 6 entries; a mutant removing the `.slice(0, 6)` cap
	// would list every file (7th/8th included) even though "and N more" is
	// also appended, doubling up the tail entries in the readable summary.
	it("mutation-kill: the message's file list stops at 6 even with 8 affected files", () => {
		const oldBodies = new Map([["Foo", "{ a }"]]);
		const importerFiles = Array.from({ length: 8 }, (_, i) => `/proj/imp${i}.ts`);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a; b }"]]),
			dependents: ["/proj/any.ts"],
			importers: importerFiles.map((f) => edge(["Foo"], f)),
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).not.toContain("imp6.ts");
		expect(nonNull(out[0]).message).not.toContain("imp7.ts");
	});

	// test-contract: mutation-kill — the changed-interface NAME list must
	// join with the exact `", "` separator; an emptied separator would
	// concatenate multiple names unreadably with no punctuation between.
	it("mutation-kill: joins multiple changed interface names with a comma-space separator", () => {
		const oldBodies = new Map([
			["Foo", "{ a }"],
			["Bar", "{ b }"],
		]);
		const graph = makeGraph({
			interfaceBodies: new Map([
				["Foo", "{ a; c }"],
				["Bar", "{ b; d }"],
			]),
			dependents: ["/proj/importer.ts"],
			importers: [edge(["Foo", "Bar"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("`Foo, Bar`");
	});

	// test-contract: mutation-kill — the affected-FILE list must join with
	// the exact `", "` separator too; an emptied separator would glue
	// multiple relative paths together with no punctuation between them.
	it("mutation-kill: joins multiple affected file paths with a comma-space separator", () => {
		const oldBodies = new Map([["Foo", "{ a }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a; b }"]]),
			dependents: ["/proj/any.ts"],
			importers: [edge(["Foo"], "/proj/one.ts"), edge(["Foo"], "/proj/two.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("one.ts, two.ts");
	});




});

// ============================================================================
// checkTestProximity
// ============================================================================

describe("checkTestProximity", () => {
	// test-contract: returns [] when the edited file is itself a .test file (L246 guard)
	it("returns [] when the edited file is itself a .test file (L246 guard)", () => {
		const out = checkTestProximity(
			"/proj/src/foo.test.ts",
			"src/foo.test.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
		expect(mockExistsSync).not.toHaveBeenCalled();
	});

	// test-contract: returns [] when the edited file is a .spec file (L246 guard)
	it("returns [] when the edited file is a .spec file (L246 guard)", () => {
		const out = checkTestProximity(
			"/proj/src/foo.spec.ts",
			"src/foo.spec.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
	});

	// test-contract: returns [] for a declaration .d.ts file (L248 base.endsWith('.d'))
	it("returns [] for a declaration .d.ts file (L248 base.endsWith('.d'))", () => {
		const out = checkTestProximity(
			"/proj/src/foo.d.ts",
			"src/foo.d.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
	});

	// test-contract: returns [] for an index file (L248 base === 'index')
	it("returns [] for an index file (L248 base === 'index')", () => {
		const out = checkTestProximity(
			"/proj/src/index.ts",
			"src/index.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
	});

	// test-contract: returns [] for generated dir %s (L251-258 guard)
	it.each(["dist/", "node_modules/", ".next/", "build/", ".interlinked/"])(
		"returns [] for generated dir %s (L251-258 guard)",
		(seg) => {
			const rel = `${seg}foo.ts`;
			const out = checkTestProximity(`/proj/${rel}`, rel, makeEvent("me"), makeSessions([]));
			expect(out).toEqual([]);
			expect(mockExistsSync).not.toHaveBeenCalled();
		},
	);

	// test-contract: normalizes backslashes before the generated-dir check (L250 replace)
	it("normalizes backslashes before the generated-dir check (L250 replace)", () => {
		// Windows-style relPath with a dist segment must still be skipped.
		const out = checkTestProximity(
			"/proj/dist/foo.ts",
			"dist\\foo.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
	});

	// test-contract: reports an info finding when no test file exists (L270 !testFile)
	it("reports an info finding when no test file exists (L270 !testFile)", () => {
		mockExistsSync.mockReturnValue(false);
		const out = checkTestProximity(
			"/proj/src/foo.ts",
			"src/foo.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "test_proximity",
			severity: "info",
			file: "/proj/src/foo.ts",
		});
		expect(nonNull(out[0]).message).toContain("No test file found for src/foo.ts");
		expect(nonNull(out[0]).message).toContain("Consider adding foo.test.ts");
		expect(nonNull(out[0]).affectedFiles).toBeUndefined();
		// All four candidates probed.
		expect(mockExistsSync).toHaveBeenCalledTimes(4);
	});

	// test-contract: reports a gentle reminder when test exists but agent hasn't updated it (L283 true)
	it("reports a gentle reminder when test exists but agent hasn't updated it (L283 true)", () => {
		// First candidate (sibling .test.ts) exists.
		const testPath = "/proj/src/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		const sessions = makeSessions([
			makeSession({ agent_name: "me", files_written: ["/proj/src/foo.ts"] }),
		]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "test_proximity",
			severity: "info",
			file: "/proj/src/foo.ts",
			affectedFiles: [testPath],
		});
		expect(nonNull(out[0]).message).toContain("its test file hasn't been updated");
		expect(nonNull(out[0]).message).toContain("Test: foo.test.ts");
	});

	// test-contract: stays silent when the agent HAS written the test file this session (L283 false)
	it("stays silent when the agent HAS written the test file this session (L283 false)", () => {
		const testPath = "/proj/src/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		const sessions = makeSessions([
			makeSession({
				agent_name: "me",
				files_written: ["/proj/src/foo.ts", testPath], // test already touched
			}),
		]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toEqual([]);
	});

	// test-contract: stays silent when no session matches the editing agent (L282 sess undefined, L283 short-circuit)
	it("stays silent when no session matches the editing agent (L282 sess undefined, L283 short-circuit)", () => {
		const testPath = "/proj/src/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		// Session belongs to a different agent -> find() returns undefined.
		const sessions = makeSessions([makeSession({ agent_name: "someone-else" })]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toEqual([]);
	});

	// test-contract: uses empty agent name when event.agent_name is undefined (L281 || '' branch)
	it("uses empty agent name when event.agent_name is undefined (L281 || '' branch)", () => {
		const testPath = "/proj/src/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		// A session with agent_name "" matches the "" fallback and hasn't
		// written the test -> reminder fires.
		const sessions = makeSessions([makeSession({ agent_name: "" })]);
		const out = checkTestProximity(
			"/proj/src/foo.ts",
			"src/foo.ts",
			makeEvent(undefined),
			sessions,
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("its test file hasn't been updated");
	});

	// test-contract: finds a test in a __tests__ subdir (later candidate in the find() scan)
	it("finds a test in a __tests__ subdir (later candidate in the find() scan)", () => {
		const testPath = "/proj/src/__tests__/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		const sessions = makeSessions([makeSession({ agent_name: "me" })]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).affectedFiles).toEqual([testPath]);
		expect(nonNull(out[0]).message).toContain("Test: foo.test.ts");
	});

	// test-contract: mutation-kill — the sibling `.spec${ext}` candidate must
	// be a REAL, non-empty template; a mutant blanking that template
	// produces a malformed candidate path that never matches the real
	// sibling spec file, so the check falsely reports "no test file found".
	it("mutation-kill: finds a sibling .spec file via the real (non-blanked) template", () => {
		const specPath = "/proj/src/foo.spec.ts";
		mockExistsSync.mockImplementation((p) => p === specPath);
		const sessions = makeSessions([makeSession({ agent_name: "me", files_written: [specPath] })]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		// Test file found AND already written this session -> silent.
		expect(out).toEqual([]);
	});

	// test-contract: mutation-kill — the __tests__/`.spec${ext}` candidate
	// must also be a REAL, non-empty template; a mutant blanking that
	// template collapses it to a malformed path that never matches the
	// real __tests__ spec file.
	it("mutation-kill: finds a __tests__/*.spec file via the real (non-blanked) template", () => {
		const specPath = "/proj/src/__tests__/foo.spec.ts";
		mockExistsSync.mockImplementation((p) => p === specPath);
		const sessions = makeSessions([makeSession({ agent_name: "me", files_written: [specPath] })]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toEqual([]);
	});

	// test-contract: mutation-kill — the "__tests__" path segment must be a
	// literal non-empty string; a mutant blanking it collapses the two
	// __tests__ candidates onto the sibling candidates, so a test file that
	// exists ONLY inside __tests__/ is never found.
	it("mutation-kill: the __tests__ candidates use a real (non-blanked) subdirectory segment", () => {
		const testPath = "/proj/src/__tests__/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		const sessions = makeSessions([makeSession({ agent_name: "me", files_written: [testPath] })]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toEqual([]);
	});
});
