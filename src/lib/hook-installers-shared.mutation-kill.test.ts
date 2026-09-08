// Mutation-kill companion for hook-installers-shared.ts.
//
// Targets the 49 mutants recorded as "survived" for this file in
// .interlinked/mutation-manifest.json. Lives BESIDE the source file (rather
// than under __tests__/) with a static SUT import so the mutation runner's
// companion-scope resolver actually picks it up — the pre-existing
// __tests__/hook-installers-shared.test.ts sits outside that scope.
//
// Two groups of mutants require techniques beyond plain input/output
// assertions, documented at each site:
//   - "call-through fs spy": vi.mock("node:fs", ...) wrapping mkdirSync and
//     readFileSync with vi.fn(actual.fn) — the vitest-documented workaround
//     for "Module namespace is not configurable in ESM" (see
//     src/lib/config.mutation-kill.test.ts for the same pattern).
//   - "accessor-property call counter": distinguishes "assignment guarded by
//     a redundant-value check" from "assignment always attempted" when the
//     assigned value happens to equal the current value (so the final state
//     is identical either way and only the SET call itself is observable).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientName } from "./settings.js";
import type { JsonObject } from "./json-types.js";

// Hoisted: spies on mkdirSync/readFileSync only (call-through to the real
// implementation) while every other fs export stays untouched.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: vi.fn(actual.mkdirSync),
		readFileSync: vi.fn(actual.readFileSync),
	};
});

import * as fs from "node:fs";
import {
	buildHookCommand,
	cleanJsonHookFile,
	findParentWithHooks,
	installHookEntry,
	isNonEmptyString,
	writeJsonFile,
} from "./hook-installers-shared.js";

type FixtureHookEntry = { matcher: string; hooks: Array<Record<string, unknown>> };

beforeEach(() => {
	vi.mocked(fs.mkdirSync).mockClear();
	vi.mocked(fs.readFileSync).mockClear();
});

describe("isNonEmptyString", () => {
	// test-contract: public-api — a non-empty string is accepted by the public predicate.
	it("returns true for a non-empty string", () => {
		expect(isNonEmptyString("hello")).toBe(true);
	});

	// test-contract: positive/negative pair — kills the whole-conditional-forced-true
	// mutant, the &&-to-|| operator flip, the length>0-forced-true mutant, and the
	// >-to->= flip: an empty string is the ONE input where "v === String(v)" is true
	// but "length > 0" is false, so every one of those mutations flips this specific
	// result from false to true.
	// test-contract: boundary — empty string is the exact false/true pivot point above.
	it("returns false for an empty string", () => {
		expect(isNonEmptyString("")).toBe(false);
	});

	// test-contract: invariant — kills the "v === String(v) forced true" mutant — an array's
	// String() coercion has a non-zero .length property, so "v === String(v)"
	// being wrongly forced true (dropping the real type check) flips this result.
	it("returns false for an array (String() coercion has a non-zero .length)", () => {
		expect(isNonEmptyString([1, 2, 3])).toBe(false);
	});

	// test-contract: boundary — a number is rejected rather than coerced into a string.
	it("returns false for a number", () => {
		expect(isNonEmptyString(5)).toBe(false);
	});
});

describe("installHookEntry", () => {
	// test-contract: invariant — kills "!hooks[eventName] forced true" — a pre-existing,
	// non-interlinked entry array must survive an install call, not be wiped
	// back to [] before the new entry is appended.
	it("does not clobber a pre-existing entry array when installing into an existing event", () => {
		const hooks: JsonObject = {
			CustomEvent: [{ matcher: "", hooks: [{ type: "command", command: "echo pretest" }] }],
		};
		installHookEntry(hooks, "CustomEvent", "node .interlinked/hooks/interlinked-activity.mjs");
		// SAFETY: test fixture — shape asserted by construction above.
		const entries = hooks.CustomEvent as unknown[];
		expect(entries).toHaveLength(2);
	});

	// test-contract: invariant — kills the '"command"' -> '""' string-literal mutant on the
	// newly-pushed hook object's `type` field.
	it("pushes a new entry whose hook object has type 'command'", () => {
		const hooks: JsonObject = {};
		installHookEntry(hooks, "CustomEvent", "node .interlinked/hooks/interlinked-activity.mjs");
		// SAFETY: test fixture — shape asserted by construction above.
		const entries = hooks.CustomEvent as FixtureHookEntry[];
		expect(entries[0]!.hooks[0]!.type).toBe("command");
	});

	// test-contract: invariant — kills "timeout !== undefined forced true" on the push path —
	// an event with no configured timeout policy must NOT gain an own "timeout"
	// key (even one whose value is undefined; the ternary spread is what decides
	// whether the key exists at all).
	it("omits the timeout key entirely for an event with no configured timeout policy", () => {
		const hooks: JsonObject = {};
		installHookEntry(hooks, "CustomEvent", "node .interlinked/hooks/interlinked-activity.mjs");
		// SAFETY: test fixture — shape asserted by construction above.
		const entries = hooks.CustomEvent as FixtureHookEntry[];
		expect(Object.hasOwn(entries[0]!.hooks[0]!, "timeout")).toBe(false);
	});

	// test-contract: public-api — configured PreToolUse policy is materialized as timeout 240.
	it("sets the timeout key for an event with a configured timeout policy", () => {
		const hooks: JsonObject = {};
		installHookEntry(hooks, "PreToolUse", "node .interlinked/hooks/interlinked-activity.mjs");
		// SAFETY: test fixture — shape asserted by construction above.
		const entries = hooks.PreToolUse as FixtureHookEntry[];
		expect(entries[0]!.hooks[0]!.timeout).toBe(240);
	});

	// test-contract: invariant — kills the ".some" -> ".every" mutant — only one of two
	// nested hooks carries the interlinked marker, so .some must match (and
	// reconcile in place) while .every would not (and would wrongly push a
	// second top-level entry).
	it("finds an existing entry via .some when only one nested hook carries the marker", () => {
		const hooks: JsonObject = {
			CustomEvent: [
				{
					matcher: "",
					hooks: [
						{ type: "command", command: "echo unrelated" },
						{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" },
					],
				},
			],
		};
		installHookEntry(hooks, "CustomEvent", "node NEW.mjs");
		// SAFETY: test fixture — shape asserted by construction above.
		const entries = hooks.CustomEvent as unknown[];
		expect(entries).toHaveLength(1);
	});

	// test-contract: invariant — kills "entry.hooks?.some" -> "entry.hooks.some" — an entry
	// with no `hooks` field at all must be skipped via the optional chain, not
	// throw.
	it("does not throw when an earlier entry has no hooks field at all", () => {
		const hooks: JsonObject = { CustomEvent: [{ matcher: "" }] };
		expect(() =>
			installHookEntry(hooks, "CustomEvent", "node .interlinked/hooks/interlinked-activity.mjs"),
		).not.toThrow();
	});

	// test-contract: invariant — kills "h.command?.includes" -> "h.command.includes" inside
	// the .some callback — a nested hook object with no `command` field must be
	// skipped via the optional chain, not throw.
	it("does not throw when a nested hook object has no command field", () => {
		const hooks: JsonObject = { CustomEvent: [{ matcher: "", hooks: [{ type: "command" }] }] };
		expect(() =>
			installHookEntry(hooks, "CustomEvent", "node .interlinked/hooks/interlinked-activity.mjs"),
		).not.toThrow();
	});
});

describe("installHookEntry — reconciliation (reconcileExistingEntry)", () => {
	// test-contract: invariant — kills "hook && hook.command !== command -> false" and the
	// emptied assignment block — a genuinely stale command path must actually
	// get rewritten, and the entry must be reconciled in place (length stays 1).
	it("updates a stale command and adds the timeout on an existing reconciled entry", () => {
		const hooks: JsonObject = {
			PreToolUse: [
				{
					matcher: "",
					hooks: [{ type: "command", command: "node OLD/.interlinked/hooks/interlinked-activity.mjs" }],
				},
			],
		};
		installHookEntry(hooks, "PreToolUse", "node NEW/.interlinked/hooks/interlinked-activity.mjs");
		// SAFETY: test fixture — shape asserted by construction above.
		const entries = hooks.PreToolUse as FixtureHookEntry[];
		expect(entries).toHaveLength(1);
		expect(entries[0]!.hooks[0]!.command).toBe("node NEW/.interlinked/hooks/interlinked-activity.mjs");
		expect(entries[0]!.hooks[0]!.timeout).toBe(240);
	});

	// test-contract: invariant — kills every "always attempt the reconcile assignment"
	// mutant (command/timeout/matcher, both the &&-forced-true and the
	// &&-to-|| flips) that a plain value assertion cannot catch, because
	// reassigning an already-correct value is a no-op on the final state —
	// only the assignment ATTEMPT itself (observed via an accessor-property
	// setter counter) tells the mutant apart from the real, guarded code.
	// test-contract: invariant — no reassignment when reconciled values already match.
	it("does not reassign command, timeout, or matcher when they already match on reconcile", () => {
		const setCounts = { command: 0, timeout: 0, matcher: 0 };
		let commandVal = "node .interlinked/hooks/interlinked-activity.mjs";
		let timeoutVal: number | undefined = 240;
		let matcherVal = "";

		const hookObj: Record<string, unknown> = { type: "command" };
		Object.defineProperty(hookObj, "command", {
			get: () => commandVal,
			set: (v: string) => {
				setCounts.command++;
				commandVal = v;
			},
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(hookObj, "timeout", {
			get: () => timeoutVal,
			set: (v: number | undefined) => {
				setCounts.timeout++;
				timeoutVal = v;
			},
			enumerable: true,
			configurable: true,
		});

		const entryObj: Record<string, unknown> = { hooks: [hookObj] };
		Object.defineProperty(entryObj, "matcher", {
			get: () => matcherVal,
			set: (v: string) => {
				setCounts.matcher++;
				matcherVal = v;
			},
			enumerable: true,
			configurable: true,
		});

		const hooks: JsonObject = { PreToolUse: [entryObj] };
		installHookEntry(hooks, "PreToolUse", "node .interlinked/hooks/interlinked-activity.mjs");

		expect(setCounts).toEqual({ command: 0, timeout: 0, matcher: 0 });
	});

	// test-contract: invariant — kills the three "drop the timeout !== undefined guard"
	// mutants (forced-true whole-prefix, ||-flip, and the standalone middle
	// clause forced true) — an event with NO configured timeout policy, whose
	// existing hook already carries a stale numeric timeout, must leave that
	// stale timeout untouched (the guard's whole job is to refuse to overwrite
	// it with `undefined`).
	// test-contract: invariant — an unconfigured timeout policy never overwrites an existing timeout.
	it("leaves an existing timeout untouched for an event with no configured timeout policy", () => {
		const setCounts = { timeout: 0 };
		let timeoutVal: number | undefined = 99;
		const hookObj: Record<string, unknown> = {
			type: "command",
			command: "node .interlinked/hooks/interlinked-activity.mjs",
		};
		Object.defineProperty(hookObj, "timeout", {
			get: () => timeoutVal,
			set: (v: number | undefined) => {
				setCounts.timeout++;
				timeoutVal = v;
			},
			enumerable: true,
			configurable: true,
		});

		const hooks: JsonObject = { CustomEvent: [{ matcher: "", hooks: [hookObj] }] };
		installHookEntry(hooks, "CustomEvent", "node .interlinked/hooks/interlinked-activity.mjs");

		expect(setCounts.timeout).toBe(0);
		expect(timeoutVal).toBe(99);
	});

	// test-contract: invariant — kills "h.command?.includes" -> "h.command.includes" inside
	// reconcileExistingEntry's own .find lookup — a hook missing `command`
	// earlier in the SAME existing.hooks array (that also contains the real
	// marker match) must be skipped via the optional chain, not throw, and
	// the genuine match must still get reconciled.
	// test-contract: boundary — an earlier hook missing `command` is skipped, not thrown on.
	it("does not throw and still reconciles when an earlier hook in the array lacks a command field", () => {
		const hooks: JsonObject = {
			PreToolUse: [
				{
					matcher: "",
					hooks: [
						{ type: "command" },
						{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" },
					],
				},
			],
		};
		expect(() => installHookEntry(hooks, "PreToolUse", "node NEW.mjs")).not.toThrow();
		// SAFETY: test fixture — shape asserted by construction above.
		const entries = hooks.PreToolUse as FixtureHookEntry[];
		expect(entries).toHaveLength(1);
		const reconciledEntry = entries[0];
		expect(reconciledEntry).toBeDefined();
		expect(reconciledEntry!.hooks[1]).toBeDefined();
		expect(reconciledEntry!.hooks[1]!.command).toBe("node NEW.mjs");
		expect(reconciledEntry!.hooks[0]).toBeDefined();
		expect(reconciledEntry!.hooks[0]!.command).toBeUndefined();
	});
});

describe("writeJsonFile", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hook-shared-write-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills "!existsSync(dir) forced true" — the common
	// warm-directory path must not call mkdirSync at all.
	it("does not call mkdirSync when the target directory already exists", () => {
		const path = join(tmp, "settings.json");
		writeJsonFile(path, { foo: "bar" });
		expect(fs.mkdirSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant — kills "{ recursive: true }" -> "{}" and "true" -> "false" on
	// the mkdirSync options — a missing MULTI-LEVEL directory only succeeds when
	// the recursive option is genuinely honored.
	it("creates nested missing directories recursively without throwing", () => {
		const path = join(tmp, "a", "b", "c", "settings.json");
		expect(() => writeJsonFile(path, { foo: "bar" })).not.toThrow();
		expect(readFileSync(path, "utf-8")).toContain('"foo": "bar"');
	});

	// test-contract: invariant — kills "existsSync(path) forced true" — writing a brand new
	// file must not attempt to read it first.
	it("does not attempt to read the target file when it does not exist yet", () => {
		const path = join(tmp, "new-settings.json");
		writeJsonFile(path, { foo: "bar" });
		expect(fs.readFileSync).not.toHaveBeenCalled();
	});
});

describe("buildHookCommand", () => {
	// test-contract: invariant — kills "client === CLIENT_CURSOR forced true" — a call with
	// no client at all must return the fail-OPEN absolute-path form, not the
	// fail-closed cursor form.
	it("returns the fail-open form for an absolute path with no client", () => {
		expect(buildHookCommand("/abs/path.mjs")).toBe(
			'test -f "/abs/path.mjs" && node "/abs/path.mjs" || true',
		);
	});

	// test-contract: invariant — kills the '"\\$1"' -> '""' replacement-string mutant — a
	// quote character in the path must be ESCAPED (backslash preserved), not
	// silently stripped.
	it("escapes a double quote in the script path rather than stripping it", () => {
		const cmd = buildHookCommand(`/abs/path with "quote".mjs`);
		expect(cmd).toContain('\\"quote\\"');
	});

	// test-contract: invariant — kills the runner-default '""' -> '"Stryker was here!"'
	// mutant and the "client && runner" -> "client || runner" operator flip.
	// `client` is cast past the ClientName union on purpose: it is the one
	// input that reaches the fallback ("" runner) branch of the ternary chain
	// while still being truthy, which is required to observe either mutation
	// (both hinge on `runner`/`client`'s truthiness feeding envPrefix).
	// test-contract: boundary — an unknown client value falls through to no INTERLINKED_ prefix.
	it("adds no INTERLINKED_ prefix for a client value outside the known runner set", () => {
		// SAFETY: this deliberately exercises the runtime fallback for an unknown client.
		const cmd = buildHookCommand("/abs/path.mjs", "bogus" as ClientName);
		expect(cmd).not.toContain("INTERLINKED_");
	});
});

describe("cleanJsonHookFile", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hook-shared-clean2-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills "!existsSync(settingsPath) forced false" — readJsonFile
	// gracefully returns null for a missing file, so the return-value alone
	// can't tell the mutant apart; the read attempt itself must not happen.
	it("does not attempt to read the settings file when it does not exist", () => {
		const missing = join(tmp, "does-not-exist.json");
		expect(cleanJsonHookFile(missing)).toBe(false);
		expect(fs.readFileSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant — kills "!settings?.hooks || !isPlainObject(...)" -> "&&" —
	// hooks as a nested array (truthy, but not a plain object) must be
	// rejected and the file left untouched.
	it("returns false and leaves the file untouched when hooks is an array, not a plain object", () => {
		const path = join(tmp, "settings.json");
		const original = JSON.stringify({
			hooks: [[{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }]],
		});
		writeFileSync(path, original);
		expect(cleanJsonHookFile(path)).toBe(false);
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	// test-contract: invariant — kills "settings?.hooks" -> "settings.hooks" — malformed
	// JSON makes readJsonFile return null, and the optional chain must guard
	// against reading `.hooks` off that null.
	it("does not throw when the settings file contains malformed JSON", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(path, "{ not valid json");
		expect(() => cleanJsonHookFile(path)).not.toThrow();
		expect(cleanJsonHookFile(path)).toBe(false);
	});

	// test-contract: invariant — kills "filtered.length !== entries.length" forced true —
	// when nothing actually needs removing, the function must report no
	// change and leave the file untouched.
	it("returns false and leaves the file untouched when nothing needs filtering", () => {
		const path = join(tmp, "settings.json");
		const original = JSON.stringify({
			hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo user-hook" }] }] },
		});
		writeFileSync(path, original);
		expect(cleanJsonHookFile(path)).toBe(false);
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	// test-contract: invariant — kills "filtered.length > 0" forced false — a mixed array
	// with both an interlinked entry (to remove) and a user entry (to keep)
	// must retain the surviving user entry, not wipe the whole event to
	// undefined.
	it("keeps a surviving non-interlinked entry when only some entries in the event are removed", () => {
		const path = join(tmp, "settings.json");
		writeFileSync(
			path,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "",
							hooks: [{ type: "command", command: "node .interlinked/hooks/interlinked-activity.mjs" }],
						},
						{ matcher: "", hooks: [{ type: "command", command: "echo user-hook" }] },
					],
				},
			}),
		);
		expect(cleanJsonHookFile(path)).toBe(true);
		const written = JSON.parse(readFileSync(path, "utf-8"));
		expect(written.hooks.PreToolUse).toEqual([
			{ matcher: "", hooks: [{ type: "command", command: "echo user-hook" }] },
		]);
	});
});

describe("findParentWithHooks", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hook-shared-parent2-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: invariant — kills "gitRoot || parse(cwd).root" -> "&&" — with a real
	// git root found, the walk must stop AT the git root, not fall through to
	// the filesystem root and pick up a settings file one level above it.
	it("stops walking at the git root and does not find a settings file placed above it", () => {
		const gitRoot = join(tmp, "proj");
		const nested = join(gitRoot, "nested", "deep");
		mkdirSync(join(gitRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		const outerSettingsDir = join(tmp, ".claude");
		mkdirSync(outerSettingsDir, { recursive: true });
		writeFileSync(
			join(outerSettingsDir, "settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ command: "node \".interlinked/hooks/interlinked-activity.mjs\"" }] } }),
		);
		expect(findParentWithHooks(nested, ".claude/settings.json")).toBeNull();
	});

	// test-contract: invariant — kills "existsSync(settingsPath) forced true" — when no
	// ancestor has the settings file, readFileSync must never even be
	// attempted (existsSync is the gate).
	it("never calls readFileSync while walking up when no ancestor has the settings file", () => {
		mkdirSync(join(tmp, ".git"));
		const nested = join(tmp, "a", "b");
		mkdirSync(nested, { recursive: true });
		expect(findParentWithHooks(nested, ".claude/settings.json")).toBeNull();
		expect(fs.readFileSync).not.toHaveBeenCalled();
	});

	// test-contract: invariant — kills "dir.length >= stopAt.length" -> ">" (the git root
	// itself must still be checked) and the '"utf-8"' -> '""' encoding mutant
	// (an invalid encoding throws inside the try/catch, silently swallowing a
	// genuine match).
	it("checks the settings file at the git root itself", () => {
		const gitRoot = join(tmp, "proj");
		const sub = join(gitRoot, "sub");
		mkdirSync(join(gitRoot, ".git"), { recursive: true });
		mkdirSync(sub, { recursive: true });
		const settingsDir = join(gitRoot, ".claude");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ command: "node \".interlinked/hooks/interlinked-activity.mjs\"" }] } }),
		);
		expect(findParentWithHooks(sub, ".claude/settings.json")).toBe(gitRoot);
		// The returned value proves the content was usable; this call assertion
		// separately pins the Node fs decoding contract used by the walker.
		expect(fs.readFileSync).toHaveBeenCalledWith(join(settingsDir, "settings.json"), "utf-8");
	});

	// test-contract: invariant — kills "parent === dir" forced true (loop-terminates-early)
	// and the "parent === dir" -> "parent !== dir" equality flip (which also
	// terminates after one iteration in every reachable case) — the walk must
	// continue past the FIRST ancestor to find a match two levels up.
	it("keeps walking past the first ancestor to find a settings file two levels up", () => {
		const gitRoot = join(tmp, "proj");
		const cwd = join(gitRoot, "a", "b", "c");
		mkdirSync(join(gitRoot, ".git"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const settingsDir = join(gitRoot, "a", ".claude");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ command: "node \".interlinked/hooks/interlinked-activity.mjs\"" }] } }),
		);
		expect(findParentWithHooks(cwd, ".claude/settings.json")).toBe(join(gitRoot, "a"));
	});

	// NOT covered here: mutant fae048800e401eb4 ("parent === dir" forced
	// false) removes the ONLY guard against an unbounded synchronous while
	// loop once `dir` reaches the true filesystem root with no git boundary
	// (dirname("/") === "/" forever, so `dir` never shrinks and the outer
	// `dir.length >= stopAt.length` never turns false either). Triggering that
	// path for real requires walking to the actual OS root, and under the
	// mutant it would hang the test process with no timeout able to interrupt
	// a synchronous loop. Left uncovered rather than risking a hung verifier
	// run; see the mutation-kill receipt for this file.

	// test-contract: invariant — kills the '"utf-8"' -> '""' StringLiteral mutant
	// (mutantId 48c7bfe3c7690ef0) in isolation from the broader git-root
	// assertion above — `readFileSync(path, "")` returns a Buffer, not a
	// string, so this pins the exact second argument passed at the call
	// site rather than relying on the return value (Buffer#includes still
	// matches an ASCII marker, so the return value alone can't tell the two
	// apart).
	// test-contract: boundary — the encoding argument itself, not just the returned content, is pinned.
	// interlinked: defer mock_only_test -- the call-argument shape IS the mutation target here (StringLiteral mutant on the "utf-8" arg); the return value is identical either way, so the call assertion is the only observable.
	it("reads the matched settings file with the utf-8 encoding argument", () => {
		const gitRoot = join(tmp, "proj");
		const sub = join(gitRoot, "sub");
		mkdirSync(join(gitRoot, ".git"), { recursive: true });
		mkdirSync(sub, { recursive: true });
		const settingsDir = join(gitRoot, ".claude");
		mkdirSync(settingsDir, { recursive: true });
		const settingsPath = join(settingsDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ hooks: { PreToolUse: [{ command: "node \".interlinked/hooks/interlinked-activity.mjs\"" }] } }),
		);
		findParentWithHooks(sub, ".claude/settings.json");
		expect(fs.readFileSync).toHaveBeenCalledWith(settingsPath, "utf-8");
	});
});

// test-contract: suspected-equivalent — SCOPED_MATCHER_EVENTS set contents
// (mutants 1bf5e1282b169e83, 067a37dc57a7b5f5, 37b2c5d132186860). Read
// hook-installers-shared.ts:44 and :112-114: `POST_TOOL_USE_MATCHER` is the
// literal empty string, and `getHookMatcher` is
// `SCOPED_MATCHER_EVENTS.has(eventName) ? POST_TOOL_USE_MATCHER : ""` — both
// branches of that ternary evaluate to "". Emptying the Set, or blanking
// either string literal it holds, cannot change `getHookMatcher`'s return
// value for ANY input, so no assertion on `installHookEntry`'s output (the
// only consumer of `getHookMatcher`) can distinguish original from mutant.
// No test added for these three ids; see the mutation-kill receipt.
