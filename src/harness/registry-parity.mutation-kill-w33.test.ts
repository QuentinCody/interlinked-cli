import assert from "node:assert/strict";
import { nonNull } from "../lib/non-null.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkRegistryParity,
	extractKeys,
	loadRegistryParityConfig,
	type RegistryParityConfig,
} from "./registry-parity.js";

// Wave 33 survivor-kill suite for src/harness/registry-parity.ts.
// All functions take `cwd` explicitly, so real mkdtemp dirs are used with no
// chdir / process mocking required.

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "reg-parity-w33-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeRawConfig(raw: string): void {
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(join(dir, ".interlinked", "registry-parity.json"), raw);
}

function writeConfig(value: unknown): void {
	writeRawConfig(JSON.stringify(value));
}

describe("loadRegistryParityConfig — negative (must not fire / throw distinguishably)", () => {
	// test-contract: mutation-kill — valid config must load without throwing;
	// kills "utf-8"->"" encoding mutant (invalid encoding throws instead).
	it("loads a minimal valid config without throwing", () => {
		writeConfig({ pairs: [] });
		const result = loadRegistryParityConfig(dir);
		expect(result).toEqual({ pairs: [] });
	});

	// test-contract: mutation-kill — invalid JSON must throw the exact
	// "is not valid JSON" message with a defined `cause`; kills the emptied
	// catch block, the emptied template message, and the dropped `cause`.
	it("throws a JSON-parse error with message + cause on malformed JSON", () => {
		writeRawConfig("{not valid json");
		let caught: unknown;
		try {
			loadRegistryParityConfig(dir);
			caught = new Error("expected throw did not happen");
		} catch (err) {
			caught = err;
		}
		assert(caught instanceof Error);
		const err = caught;
		expect(err.message).toMatch(/^registry-parity config at .* is not valid JSON: /);
		expect(err.cause).toBeDefined();
	});
});

describe("validateConfig (via loadRegistryParityConfig) — negative", () => {
	// test-contract: mutation-kill — non-object root value; kills
	// !isObject(value)->false in validateConfig.
	it("rejects a numeric root value with the exact object-shape message", () => {
		writeRawConfig("42");
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"registry-parity config must be an object",
		);
	});

	// test-contract: mutation-kill — missing `pairs` key; kills
	// !Array.isArray(pairs)->false and the emptied pairs-array message.
	it("rejects a config with no pairs array with the exact message", () => {
		writeConfig({});
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"registry-parity.pairs must be an array",
		);
	});

	// test-contract: mutation-kill — a non-object pair element; kills the
	// `pairs[${i}]` context-template mutant (validateConfig.(anonymous)) and
	// validatePair's own !isObject(value)->false check, via the exact prefix.
	it("rejects a numeric pair element with the exact indexed context", () => {
		writeConfig({ pairs: [123] });
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0] must be an object",
		);
	});
});

describe("validatePair (via loadRegistryParityConfig) — negative", () => {
	// test-contract: mutation-kill — missing `name`; kills the `.name`
	// context-template mutant on validatePair.
	it("rejects a pair missing name with the exact context", () => {
		writeConfig({ pairs: [{}] });
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].name must be a string",
		);
	});

	// test-contract: mutation-kill — null `left`; kills the `.left`
	// context-template mutant AND validateSource's own isObject check
	// (both produce the identical exact message here).
	it("rejects a pair with a null left source with the exact context", () => {
		writeConfig({ pairs: [{ name: "n", left: null }] });
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].left must be an object",
		);
	});

	// test-contract: mutation-kill — null `right`; kills the `.right`
	// context-template mutant on validatePair.
	it("rejects a pair with a null right source with the exact context", () => {
		writeConfig({
			pairs: [{ name: "n", left: { file: "a", key_re: "b" }, right: null }],
		});
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].right must be an object",
		);
	});

	// test-contract: mutation-kill — non-array left_only_allowed; kills the
	// `.left_only_allowed` context-template mutant AND arrayOfString's
	// shared !Array.isArray(v)->false body check.
	it("rejects a non-array left_only_allowed with the exact context", () => {
		writeConfig({
			pairs: [
				{
					name: "n",
					left: { file: "a", key_re: "b" },
					right: { file: "c", key_re: "d" },
					left_only_allowed: "bad",
				},
			],
		});
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].left_only_allowed must be an array",
		);
	});

	// test-contract: mutation-kill — non-array right_only_allowed; kills the
	// `.right_only_allowed` context-template mutant.
	it("rejects a non-array right_only_allowed with the exact context", () => {
		writeConfig({
			pairs: [
				{
					name: "n",
					left: { file: "a", key_re: "b" },
					right: { file: "c", key_re: "d" },
					right_only_allowed: "bad",
				},
			],
		});
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].right_only_allowed must be an array",
		);
	});
});

describe("validateSource (via loadRegistryParityConfig) — negative", () => {
	// test-contract: mutation-kill — missing `file`; kills the `.file`
	// context-template mutant on validateSource.
	it("rejects a source missing file with the exact context", () => {
		writeConfig({
			pairs: [
				{ name: "n", left: {}, right: { file: "c", key_re: "d" } },
			],
		});
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].left.file must be a string",
		);
	});

	// test-contract: mutation-kill — missing `key_re`; kills the `.key_re`
	// context-template mutant on validateSource.
	it("rejects a source missing key_re with the exact context", () => {
		writeConfig({
			pairs: [
				{ name: "n", left: { file: "a" }, right: { file: "c", key_re: "d" } },
			],
		});
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].left.key_re must be a string",
		);
	});
});

describe("isObject (via loadRegistryParityConfig root value) — negative", () => {
	// test-contract: mutation-kill — null root value: kills the whole-expr
	// ->true mutant, the `v!==null`->true mutant, the two-term subexpr
	// ->true mutant, and the &&->|| LogicalOperator mutant on the first pair
	// (all four make isObject(null) incorrectly true).
	it("rejects a null root value with the exact object-shape message", () => {
		writeRawConfig("null");
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"registry-parity config must be an object",
		);
	});

	// test-contract: mutation-kill — string root value: kills the
	// `typeof v === "object"`->true mutant and the &&->|| LogicalOperator
	// mutant on the full three-term expression (both make isObject(string)
	// incorrectly true).
	it("rejects a string root value with the exact object-shape message", () => {
		writeRawConfig('"just-a-string"');
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"registry-parity config must be an object",
		);
	});
});

describe("requireString (via loadRegistryParityConfig) — negative", () => {
	// test-contract: mutation-kill — non-string name value; kills
	// `typeof v !== "string"`->false and the emptied message template
	// (shared body, exercised again with a different input shape).
	it("rejects a numeric name with the exact message", () => {
		writeConfig({
			pairs: [
				{
					name: 123,
					left: { file: "a", key_re: "b" },
					right: { file: "c", key_re: "d" },
				},
			],
		});
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].name must be a string",
		);
	});
});

describe("arrayOfString (via loadRegistryParityConfig) — positive + negative", () => {
	// test-contract: mutation-kill — omitted optional array defaults to [];
	// kills the ArrayDeclaration []->["Stryker was here"] mutant on the
	// undefined-shortcut branch.
	it("defaults an omitted left/right_only_allowed to an empty array", () => {
		writeConfig({
			pairs: [
				{ name: "n", left: { file: "a", key_re: "b" }, right: { file: "c", key_re: "d" } },
			],
		});
		const result = nonNull(loadRegistryParityConfig(dir));
		expect(result.pairs[0]?.left_only_allowed).toEqual([]);
		expect(result.pairs[0]?.right_only_allowed).toEqual([]);
	});

	// test-contract: mutation-kill — non-string array entry; kills the
	// emptied item-type-check block AND the `typeof item !== "string"`
	// ->false mutant (both suppress the "entries must be strings" throw).
	it("rejects a left_only_allowed array containing a non-string entry", () => {
		writeConfig({
			pairs: [
				{
					name: "n",
					left: { file: "a", key_re: "b" },
					right: { file: "c", key_re: "d" },
					left_only_allowed: [123],
				},
			],
		});
		expect(() => loadRegistryParityConfig(dir)).toThrowError(
			"pairs[0].left_only_allowed entries must be strings",
		);
	});
});

describe("extractKeys — negative", () => {
	// test-contract: mutation-kill — an optional capture group that does not
	// match must not add `undefined` to the result set; kills
	// `m[1] !== undefined`->true.
	it("does not add undefined when the capture group is absent", () => {
		const result = extractKeys("b", "(a)?b");
		expect(result.size).toBe(0);
		expect(result).toEqual(new Set());
	});

	it("extracts every capture-1 match on a positive corpus", () => {
		const result = extractKeys("id:foo id:bar", "id:(\\w+)");
		expect(result).toEqual(new Set(["foo", "bar"]));
	});
});

describe("checkRegistryParity — negative + drift corpus", () => {
	// test-contract: mutation-kill — missing left file; kills
	// !existsSync(leftAbs)->false (which would instead crash on a
	// nonexistent readFileSync rather than reporting missing-file).
	it("reports a missing-file finding when the left file is absent", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "right.txt"), "ID:x");
		const config: RegistryParityConfig = {
			pairs: [
				{
					name: "p",
					left: { file: "left.txt", key_re: "ID:(\\S+)" },
					right: { file: "right.txt", key_re: "ID:(\\S+)" },
				},
			],
		};
		expect(checkRegistryParity(config, dir)).toEqual([
			{
				pair: "p",
				kind: "missing-file",
				id: "left.txt",
				source_file: "left.txt",
				target_file: "right.txt",
				message: "Left file missing: left.txt",
			},
		]);
	});

	// test-contract: mutation-kill — missing right file; kills the emptied
	// "Right file missing" message template.
	it("reports a missing-file finding with exact message when the right file is absent", () => {
		writeFileSync(join(dir, "left.txt"), "ID:x");
		const config: RegistryParityConfig = {
			pairs: [
				{
					name: "p",
					left: { file: "left.txt", key_re: "ID:(\\S+)" },
					right: { file: "right.txt", key_re: "ID:(\\S+)" },
				},
			],
		};
		expect(checkRegistryParity(config, dir)).toEqual([
			{
				pair: "p",
				kind: "missing-file",
				id: "right.txt",
				source_file: "right.txt",
				target_file: "left.txt",
				message: "Right file missing: right.txt",
			},
		]);
	});

	// test-contract: mutation-kill — both files present with a two-sided
	// drift; kills both "utf-8"->"" encoding mutants (either one throws
	// "Unknown encoding" and breaks this call) and both emptied drift
	// message templates (missing-from-right / missing-from-left).
	it("reports exact two-sided drift findings for a real file pair", () => {
		writeFileSync(join(dir, "left.txt"), "ID:shared1\nID:onlyLeft");
		writeFileSync(join(dir, "right.txt"), "ID:shared1\nID:onlyRight");
		const config: RegistryParityConfig = {
			pairs: [
				{
					name: "p",
					left: { file: "left.txt", key_re: "ID:(\\S+)" },
					right: { file: "right.txt", key_re: "ID:(\\S+)" },
				},
			],
		};
		expect(checkRegistryParity(config, dir)).toEqual([
			{
				pair: "p",
				kind: "missing-from-right",
				id: "onlyLeft",
				source_file: "left.txt",
				target_file: "right.txt",
				message: '[p] "onlyLeft" is in left.txt but not right.txt',
			},
			{
				pair: "p",
				kind: "missing-from-left",
				id: "onlyRight",
				source_file: "right.txt",
				target_file: "left.txt",
				message: '[p] "onlyRight" is in right.txt but not left.txt',
			},
		]);
	});

	// test-contract: mutation-kill — omitted left_only_allowed defaulting to
	// the literal array ["Stryker was here"] instead of []; kills the
	// ArrayDeclaration mutant by using an id that collides with the
	// mutant's injected literal.
	it("does not suppress a drift id matching the mutant's injected literal (left default)", () => {
		writeFileSync(join(dir, "left.txt"), "ID:Stryker was here");
		writeFileSync(join(dir, "right.txt"), "ID:nothing-related");
		const config: RegistryParityConfig = {
			pairs: [
				{
					name: "p",
					left: { file: "left.txt", key_re: "ID:(.+)" },
					right: { file: "right.txt", key_re: "ID:(.+)" },
				},
			],
		};
		expect(checkRegistryParity(config, dir)).toEqual([
			{
				pair: "p",
				kind: "missing-from-right",
				id: "Stryker was here",
				source_file: "left.txt",
				target_file: "right.txt",
				message: '[p] "Stryker was here" is in left.txt but not right.txt',
			},
			{
				pair: "p",
				kind: "missing-from-left",
				id: "nothing-related",
				source_file: "right.txt",
				target_file: "left.txt",
				message: '[p] "nothing-related" is in right.txt but not left.txt',
			},
		]);
	});

	// test-contract: mutation-kill — omitted right_only_allowed defaulting
	// to the literal array ["Stryker was here"] instead of [] (right side).
	it("does not suppress a drift id matching the mutant's injected literal (right default)", () => {
		writeFileSync(join(dir, "left.txt"), "ID:nothing-related");
		writeFileSync(join(dir, "right.txt"), "ID:Stryker was here");
		const config: RegistryParityConfig = {
			pairs: [
				{
					name: "p",
					left: { file: "left.txt", key_re: "ID:(.+)" },
					right: { file: "right.txt", key_re: "ID:(.+)" },
				},
			],
		};
		expect(checkRegistryParity(config, dir)).toEqual([
			{
				pair: "p",
				kind: "missing-from-right",
				id: "nothing-related",
				source_file: "left.txt",
				target_file: "right.txt",
				message: '[p] "nothing-related" is in left.txt but not right.txt',
			},
			{
				pair: "p",
				kind: "missing-from-left",
				id: "Stryker was here",
				source_file: "right.txt",
				target_file: "left.txt",
				message: '[p] "Stryker was here" is in right.txt but not left.txt',
			},
		]);
	});
});
