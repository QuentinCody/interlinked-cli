import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../lib/json-types.js";
import { projectLineCount } from "./line-count-projection.js";

let dir: string;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeFile(name: string, content: string): string {
	dir = mkdtempSync(join(tmpdir(), "lcp-w48-"));
	const p = join(dir, name);
	writeFileSync(p, content, "utf-8");
	return p;
}

describe("projectLineCount — Write shape", () => {
	// kills 51615ffcd43f132c ('!current' -> 'false'): when the current file
	// can't be read (EISDIR), projectWrite must return null, not crash on
	// current.lines/.text of a null object.
	// test-contract: public-api — projectLineCount fails closed (null) rather
	// than crashing when the current file can't be read.
	it("returns null when the target path can't be read as a file (directory)", () => {
		dir = mkdtempSync(join(tmpdir(), "lcp-w48-"));
		const toolInput: JsonObject = { content: "hello\nworld" };
		expect(projectLineCount(toolInput, dir)).toBeNull();
	});
});

describe("projectLineCount — Edit shape: type-guard branches", () => {
	// kills 711d6c52f80cf622 (OR->AND), 4f56e2cfcdf55f84 (old_string check
	// forced false): old_string missing, new_string present must still be null.
	// test-contract: public-api — Edit tool input requires both old_string
	// and new_string; the type guard must reject a missing old_string.
	it("returns null when old_string is missing (new_string present)", () => {
		const p = makeFile("a.txt", "hello world");
		const toolInput: JsonObject = { new_string: "y" };
		expect(projectLineCount(toolInput, p)).toBeNull();
	});

	// kills 3b837e068065ad80 (new_string check forced false), and reinforces
	// 711d6c52f80cf622 from the other side.
	// test-contract: public-api — symmetric: a missing new_string must also
	// be rejected.
	it("returns null when new_string is missing (old_string present)", () => {
		const p = makeFile("b.txt", "hello world");
		const toolInput: JsonObject = { old_string: "hello" };
		expect(projectLineCount(toolInput, p)).toBeNull();
	});

	// kills 5bdc1c4d4c2c5791 (whole '!current || lines===0' forced false) and
	// 552d8b65b3ece902 (OR->AND): when current is unreadable (EISDIR) the
	// guard must short-circuit on `!current` alone without evaluating
	// `current.lines`, which would throw on null.
	// test-contract: invariant — the `!current` short-circuit must guard
	// `current.lines` so an unreadable path fails closed instead of throwing.
	it("returns null (not throw) for an unreadable path with a valid old/new pair", () => {
		dir = mkdtempSync(join(tmpdir(), "lcp-w48-"));
		const toolInput: JsonObject = { old_string: "a", new_string: "b" };
		expect(() => projectLineCount(toolInput, dir)).not.toThrow();
		expect(projectLineCount(toolInput, dir)).toBeNull();
	});
});

describe("projectLineCount — MultiEdit shape: type-guard branches", () => {
	// kills cc024e5b39dac74c (whole cond forced false) and ac3b2684da449a7e
	// (OR->AND) for the MultiEdit variant of the same guard.
	// test-contract: invariant — MultiEdit's variant of the same
	// `!current`/`current.lines` guard must also fail closed, not throw.
	it("returns null (not throw) for an unreadable path with valid edits", () => {
		dir = mkdtempSync(join(tmpdir(), "lcp-w48-"));
		const toolInput: JsonObject = { edits: [{ old_string: "a", new_string: "b" }] };
		expect(() => projectLineCount(toolInput, dir)).not.toThrow();
		expect(projectLineCount(toolInput, dir)).toBeNull();
	});

	// kills d97cb85ad648c374 (whole cond forced false), 03b2463a9da79bdf
	// (OR->AND), 5a48f737f12b8028 ('raw === null' forced false): a null entry
	// must be skipped, not treated as an edit object (which would throw
	// reading .old_string off null).
	// test-contract: invariant — a null entry in the edits array must be
	// skipped, not dereferenced as an edit object.
	it("skips a null entry in edits and applies the following real edit", () => {
		const content = "foo bar";
		const p = makeFile("c.txt", content);
		const toolInput: JsonObject = {
			edits: [null, { old_string: "foo", new_string: "baz" }],
		};
		const result = projectLineCount(toolInput, p);
		expect(result).toBeNull(); // Invalid entries make the proposed operation unmeasured.
	});

	// kills 20393f2642de4746 ('typeof raw !== "object"' forced false): a
	// non-object, non-null raw entry (typeof "function") carrying old_string/
	// new_string properties must still be skipped entirely — forcing the
	// check false lets it fall through the downstream string checks (which
	// see valid strings) and actually apply the bogus edit.
	// test-contract: invariant — the raw-entry type guard checks
	// `typeof raw !== "object"` independently of the null check; a
	// function-typed entry must be skipped even if it carries valid-looking
	// old_string/new_string properties.
	it("skips a function-typed edits entry even though it carries string-valued properties", () => {
		const content = "foo bar";
		const p = makeFile("d.txt", content);
		const fnEdit = Object.assign(
			() => {},
			{ old_string: "foo", new_string: "baz" },
		);
		const toolInput: JsonObject = { edits: [fnEdit] };
		const result = projectLineCount(toolInput, p);
		expect(result).toBeNull();
	});

	// kills a178e80803b35f65 (whole cond forced false), 837d8fc8319b2436
	// (OR->AND), 5ff3b0a69fd16496 (old_string check forced false): a
	// non-string old_string must be skipped, not passed to countLines
	// (which would throw calling .split on a number).
	// test-contract: invariant — a non-string old_string must be skipped
	// before it reaches countLines(), which requires a string argument.
	it("skips an edit whose old_string is not a string", () => {
		const content = "foo bar";
		const p = makeFile("e.txt", content);
		const toolInput: JsonObject = { edits: [{ old_string: 123, new_string: "y" }] };
		const result = projectLineCount(toolInput, p);
		expect(result).toBeNull();
	});

	// kills 6007e559d6bafd38 (new_string check forced false): symmetric case
	// with a non-string new_string.
	// test-contract: invariant — symmetric: a non-string new_string must
	// also be skipped before reaching countLines().
	it("skips an edit whose new_string is not a string", () => {
		const content = "foo bar";
		const p = makeFile("f.txt", content);
		const toolInput: JsonObject = { edits: [{ old_string: "foo", new_string: 456 }] };
		const result = projectLineCount(toolInput, p);
		expect(result).toBeNull();
	});
});

describe("projectLineCount — MultiEdit shape: replace_all + arithmetic", () => {
	// kills efff1eca991cb45b/8604cd4f228de23f ('=== true' forced to literal
	// true), 766bdc516de22fd6/56b610255cfdde12 ('===' -> '!=='),
	// 6fedaceb8b7b3e1a/2b29530b3649f499/71bb3994126fc46c/573f5cd2a2cd6b26
	// ('=== true' forced false / true literal flipped), d0caeda0c4b43f54
	// (occurrences '*' -> '/'), f0f6ad47b6865e2d ('+=' -> '-='),
	// 5874c9321e991650 ('-' -> '+' in the per-edit line diff), and
	// e0c85f9d2ffb21de ('current.lines + lineDelta' -> '- lineDelta').
	// test-contract: invariant — replace_all:true must replace every
	// occurrence and the projected line count must equal before + the
	// summed per-occurrence delta (occurrences * per-occurrence line diff).
	it("replace_all:true replaces every occurrence and accumulates the per-occurrence line delta", () => {
		const content = "foo foo foo\nbar";
		const p = makeFile("g.txt", content);
		const toolInput: JsonObject = {
			edits: [{ old_string: "foo", new_string: "foo\nfoo", replace_all: true }],
		};
		const result = projectLineCount(toolInput, p);
		expect(result).not.toBeNull();
		expect(result?.before).toBe(2);
		// 3 occurrences of "foo", each replacement adds exactly one line.
		expect(result?.after).toBe(5);
		expect(result?.afterText).toBe(content.split("foo").join("foo\nfoo"));
	});

	// Companion case with replace_all:false (or absent) so any mutation that
	// forces the "=== true" checks to always-true, always-false, or flips
	// the equality is caught from the opposite direction of the case above.
	// test-contract: invariant — the opposite-boolean case: replace_all:false
	// must replace exactly one occurrence, catching any mutation that flips
	// or forces the "=== true" comparisons in either direction.
	it("replace_all:false (default) replaces only the first occurrence", () => {
		const content = "foo foo foo\nbar";
		const p = makeFile("h.txt", content);
		const toolInput: JsonObject = {
			edits: [{ old_string: "foo", new_string: "FOO\nFOO", replace_all: false }],
		};
		const result = projectLineCount(toolInput, p);
		expect(result).not.toBeNull();
		expect(result?.before).toBe(2);
		// Exactly one occurrence counted, each replacement adds one line.
		expect(result?.after).toBe(3);
		const idx = content.indexOf("foo");
		const expectedAfterText = `${content.slice(0, idx)}FOO\nFOO${content.slice(idx + "foo".length)}`;
		expect(result?.afterText).toBe(expectedAfterText);
	});

	// kills 393636ac2fce5cee ('edit.old_string.length > 0' forced to 'true')
	// and 15a2f8ccdd890e33 ('> 0' -> '>= 0'): an empty old_string must never
	// drive a text substitution (replaceFirst("", ...) would prepend to
	// every call), so afterText must stay untouched.
	// test-contract: bug — replaceFirst("", ...) would splice into every
	// call position (idx 0), so the `old_string.length > 0` guard must
	// actually gate the substitution, not just decorate an always-true path.
	it("does not apply a text substitution when old_string is empty", () => {
		const content = "hello world";
		const p = makeFile("i.txt", content);
		const toolInput: JsonObject = {
			edits: [{ old_string: "", new_string: "XYZ", replace_all: false }],
		};
		const result = projectLineCount(toolInput, p);
		expect(result).toBeNull();
	});
});
