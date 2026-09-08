import { parseWire, wireArray, wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
// ===========================================
// Cross-Session Learned Rules — persistence failure paths
// ===========================================
// Happy-path learning/persisting/has() behavior is covered by
// `__tests__/cc-patterns.test.ts` §8. This file targets the three
// filesystem-failure branches inside `save()` / `load()` that the happy
// path never reaches: the lazy directory create, the swallowed write
// error, and the swallowed read/parse error.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLearnedRulesStore } from "./learned-rules.js";

let tmp: string;

beforeEach(() => {
	tmp = join(tmpdir(), `learned-rules-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("createLearnedRulesStore — save() lazily creates the directory", () => {
	it("creates a not-yet-existing .interlinked directory before writing the rules file", () => {
		// test-contract: invariant — `save()` must not require the caller to
		// have pre-created the directory; it is the module's own doc comment
		// job to persist "when a pattern is observed N times".
		const interlinkedDir = join(tmp, "deep", "nested", ".interlinked");
		expect(existsSync(interlinkedDir)).toBe(false);

		const store = createLearnedRulesStore(interlinkedDir, 1);
		store.observe("Bash(npm run build *)", "s1");

		expect(existsSync(interlinkedDir)).toBe(true);
		// SAFETY: we just wrote this file via the module's own save() path,
		// which always serializes a LearnedRule[].
		const onDisk = parseWire(JSON.parse(
			readFileSync(join(interlinkedDir, "learned-rules.json"), "utf-8"),
		), wireArray(wireObject({ "pattern": wireString, "observation_count": wireNumber, "decision": wireLiteral("allow"), "first_seen": wireString, "learned_at": wireString, "learned_in_session": wireString })), "test JSON value");
		expect(onDisk.map((r) => r.pattern)).toEqual(["Bash(npm run build *)"]);
	});
});

describe("createLearnedRulesStore — save() swallows a write failure", () => {
	it("keeps the in-memory rule and does not throw when the rules file path is a directory", () => {
		// test-contract: invariant — a persistence failure (e.g. disk full,
		// permissions, or here a path collision) must not crash the caller;
		// the rule already accepted into memory must remain queryable via
		// has() regardless of whether the write succeeded.
		const interlinkedDir = join(tmp, ".interlinked");
		const filePath = join(interlinkedDir, "learned-rules.json");
		mkdirSync(filePath, { recursive: true }); // learned-rules.json is itself a dir → EISDIR on write

		const store = createLearnedRulesStore(interlinkedDir, 1);
		// If save()'s catch were removed, the EISDIR write error would
		// propagate straight out of this call and fail the test with a
		// thrown exception rather than the assertion below.
		const learned = store.observe("Bash(git status *)", "s1");

		expect(learned?.pattern).toBe("Bash(git status *)");
		expect(store.has("Bash(git status *)")).toBe(true);
		// The write failed silently — the path is still the directory we made,
		// never replaced by a rules file.
		expect(statSync(filePath).isDirectory()).toBe(true);
	});
});

describe("createLearnedRulesStore — load() swallows a read/parse failure", () => {
	it("starts with no rules when the on-disk rules file is malformed JSON", () => {
		// test-contract: invariant — a corrupted rules file must degrade to
		// "nothing learned yet", not crash store construction (load() runs
		// synchronously inside createLearnedRulesStore).
		const interlinkedDir = join(tmp, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(join(interlinkedDir, "learned-rules.json"), "{not valid json");

		// If load()'s catch were removed, the SyntaxError from JSON.parse would
		// propagate out of createLearnedRulesStore itself and fail this test
		// with a thrown exception before the assertions below ever run.
		const store = createLearnedRulesStore(interlinkedDir, 1);

		expect(store.rules).toEqual([]);
		expect(store.has("Bash(anything *)")).toBe(false);
	});
});
