// Companion tests for the per-line bare-catch helpers extracted out of
// error-handling.ts (cyclomatic burn-down: checkBareCatchBlock decomposition).
import { describe, expect, it } from "vitest";
import type { InlineMatch } from "./shared.js";
import {
	pushBareCatchOneLiner,
	pushBarePythonExcept,
	pushCommentOnlyCatch,
} from "./error-handling-bare-catch.js";

describe("pushBareCatchOneLiner — positive (must fire)", () => {
	it("P1: matches catch (e) {}", () => {
		const matches: InlineMatch[] = [];
		const matched = pushBareCatchOneLiner("  catch (e) {}", 4, matches);
		expect(matched).toBe(true);
		expect(matches).toHaveLength(1);
		expect(matches[0]).toEqual({
			line: 5,
			text: "bare catch block silently swallows error: catch (e) {}",
		});
	});

	it("P2: matches bare catch {} with no parens", () => {
		const matches: InlineMatch[] = [];
		const matched = pushBareCatchOneLiner("catch {}", 0, matches);
		expect(matched).toBe(true);
		expect(matches).toHaveLength(1);
	});
});

describe("pushBareCatchOneLiner — negative (must not fire)", () => {
	it("N1: does not match a catch block with a body", () => {
		const matches: InlineMatch[] = [];
		const matched = pushBareCatchOneLiner("catch (e) { log(e); }", 0, matches);
		expect(matched).toBe(false);
		expect(matches).toHaveLength(0);
	});

	it("N2: does not match an unrelated line", () => {
		const matches: InlineMatch[] = [];
		const matched = pushBareCatchOneLiner("const x = 1;", 0, matches);
		expect(matched).toBe(false);
		expect(matches).toHaveLength(0);
	});
});

describe("pushCommentOnlyCatch — positive (must fire)", () => {
	it("P1: matches catch block with only a // comment inside", () => {
		const lines = ["catch (e) {", "  // ignore", "}"];
		const matches: InlineMatch[] = [];
		pushCommentOnlyCatch(lines, 0, matches);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
	});

	it("P2: matches catch block with a blank body line", () => {
		const lines = ["catch (e) {", "  ", "}"];
		const matches: InlineMatch[] = [];
		pushCommentOnlyCatch(lines, 0, matches);
		expect(matches).toHaveLength(1);
	});
});

describe("pushCommentOnlyCatch — negative (must not fire)", () => {
	it("N1: does not match a catch block with real code", () => {
		const lines = ["catch (e) {", "  doSomething();", "}"];
		const matches: InlineMatch[] = [];
		pushCommentOnlyCatch(lines, 0, matches);
		expect(matches).toHaveLength(0);
	});

	it("N2: does not match when there aren't 2 more lines available", () => {
		const lines = ["catch (e) {", "}"];
		const matches: InlineMatch[] = [];
		pushCommentOnlyCatch(lines, 0, matches);
		expect(matches).toHaveLength(0);
	});
});

describe("pushBarePythonExcept — positive (must fire)", () => {
	it("P1: matches except: followed by pass", () => {
		const lines = ["except Exception:", "    pass"];
		const matches: InlineMatch[] = [];
		pushBarePythonExcept(lines, 0, matches);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
	});

	it("P2: matches bare except: followed by ...", () => {
		const lines = ["except:", "    ..."];
		const matches: InlineMatch[] = [];
		pushBarePythonExcept(lines, 0, matches);
		expect(matches).toHaveLength(1);
	});
});

describe("pushBarePythonExcept — negative (must not fire)", () => {
	it("N1: does not match except with real handling", () => {
		const lines = ["except Exception as e:", "    log(e)"];
		const matches: InlineMatch[] = [];
		pushBarePythonExcept(lines, 0, matches);
		expect(matches).toHaveLength(0);
	});

	it("N2: does not match a non-except line", () => {
		const lines = ["x = 1", "pass"];
		const matches: InlineMatch[] = [];
		pushBarePythonExcept(lines, 0, matches);
		expect(matches).toHaveLength(0);
	});
});
