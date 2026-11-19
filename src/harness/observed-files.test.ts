import { describe, expect, it } from "vitest";
import { makeSession } from "./__tests__/fixtures/evaluator.js";
import { clearObservedOnly, isObservedOnly, mergeObservedOnly, recordObservedOnly } from "./observed-files.js";

// A Stop residue effect is a change seen in the workspace that no tool call of
// this session declared. Other sessions work in the same checkout, so such a
// change is rescanned (backstop) but is never proof that this session wrote it.
describe("recordObservedOnly", () => {
	it("keeps an observed path in the rescan set and marks it observed-only", () => {
		const session = makeSession();
		recordObservedOnly(session, ["src/other.ts"], "/repo");
		expect(session.files_written.has("src/other.ts")).toBe(true);
		expect(isObservedOnly(session, "src/other.ts", "/repo")).toBe(true);
		expect(isObservedOnly(session, "/repo/src/other.ts", "/repo")).toBe(true);
	});

	it("does not mark a path that this session already declared, in raw or absolute form", () => {
		const session = makeSession();
		session.files_written = new Set(["src/mine.ts", "/repo/src/abs.ts"]);
		recordObservedOnly(session, ["src/mine.ts", "src/abs.ts"], "/repo");
		expect(isObservedOnly(session, "src/mine.ts", "/repo")).toBe(false);
		expect(isObservedOnly(session, "src/abs.ts", "/repo")).toBe(false);
	});

	it("reports false for a path that was never observed", () => {
		expect(isObservedOnly(makeSession(), "src/never.ts", "/repo")).toBe(false);
	});
});

describe("clearObservedOnly", () => {
	it("makes the path declared when this session later writes it with a tool", () => {
		const session = makeSession();
		recordObservedOnly(session, ["src/other.ts"], "/repo");
		clearObservedOnly(session, ["src/other.ts", "/repo/src/other.ts"]);
		expect(isObservedOnly(session, "src/other.ts", "/repo")).toBe(false);
		expect(session.files_written.has("src/other.ts")).toBe(true);
	});
});

describe("mergeObservedOnly", () => {
	it("carries a subagent's observed-only path to the parent unless the parent declared it", () => {
		const parent = makeSession();
		parent.files_written = new Set(["src/declared.ts"]);
		const child = makeSession();
		recordObservedOnly(child, ["src/declared.ts", "src/unknown.ts"], "/repo");
		mergeObservedOnly(child, parent);
		expect([...(parent.files_observed_only ?? [])]).toEqual(["src/unknown.ts"]);
	});
});
