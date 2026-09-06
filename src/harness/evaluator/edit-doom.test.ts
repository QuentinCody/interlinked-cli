// Companion tests for edit-doom.ts (LG-1/LG-2 — edit-contract-hardening.md).
// Positive cases prove each doom class fires with one-round-trip rescue
// material; negative cases prove the client stays the authority everywhere
// we cannot decide with certainty (fail-open).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeApplyPatchDoom, analyzeStrReplaceDoom, formatDoomReason } from "./edit-doom.js";

let dir: string;
let target: string;

const FILE_CONTENT = [
	"function greet(name) {",
	'  const msg = "Hello, " + name;',
	"  console.log(msg);",
	"}",
	"const tail = 1;",
	"const tail = 1;",
	"",
].join("\n");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "edit-doom-"));
	target = join(dir, "sample.js");
	writeFileSync(target, FILE_CONTENT);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("analyzeStrReplaceDoom — missing anchor", () => {
	it("dooms a bare Edit whose old_string is absent", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: 'const msg = "Hello " + name;', // comma missing vs file
			new_string: "x",
		});
		expect(doom?.kind).toBe("missing");
		expect(doom?.entryIndex).toBe(1);
		expect(doom?.entryCount).toBe(1);
	});

	it("renders the rescue with verbatim current content and no re-read demand", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: 'const msg = "Hello " + name;',
			new_string: "x",
		});
		expect(doom).not.toBeNull();
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toMatch(/old_string not found/);
		expect(reason).toContain('  const msg = "Hello, " + name;'); // exact whitespace
		expect(reason).toContain("```");
		expect(reason).not.toMatch(/Re-read the file first/);
	});

	it("dooms the correct MultiEdit entry against post-earlier-entry content", () => {
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: "function greet(name) {", new_string: "function greet(who) {" },
				// Entry 2 still references the ORIGINAL signature entry 1 replaced.
				{ old_string: "function greet(name) {", new_string: "function hi(name) {" },
			],
		});
		expect(doom?.kind).toBe("missing");
		expect(doom?.entryIndex).toBe(2);
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toMatch(/entry 2 of 2/);
		expect(reason).toMatch(/MultiEdit is atomic — nothing was applied/);
		expect(reason).toContain("Entries 1–1 would have applied");
		expect(reason).toContain("(checked against the file with earlier entries applied)");
	});

	it("rejects a MultiEdit whose first entry is missing without pretending it was checked after edits", () => {
		const doom = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [
				{ old_string: "not in the file", new_string: "x" },
				{ old_string: "console.log(msg);", new_string: "report(msg);" },
			],
		});
		expect(doom?.entryIndex).toBe(1);
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).not.toContain("checked against the file with earlier entries applied");
	});

	it("does not add entry or atomicity wording to a bare Edit reason", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "not in the file",
			new_string: "x",
		});
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toMatch(/^Edit will fail: old_string not found/);
		expect(reason).not.toContain("entry 1 of 1");
		expect(reason).not.toContain("MultiEdit is atomic");
	});

	it("does not fabricate rescue material when no near miss exists", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
			new_string: "x",
		});
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).not.toContain("Stryker was here");
		expect(reason).not.toContain("```");
	});
});

describe("analyzeStrReplaceDoom — ambiguous anchor", () => {
	it("dooms a multi-match old_string without replace_all and lists sites", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "const tail = 1;",
			new_string: "const tail = 2;",
		});
		expect(doom?.kind).toBe("ambiguous");
		expect(doom?.occurrenceLines).toEqual([5, 6]);
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toMatch(/matches 2 times/);
		expect(reason).toMatch(/replace_all: true/);
	});

	it("suggests a unique widened anchor when one exists", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "const tail = 1;",
			new_string: "x",
		});
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		// Widening the first site downward reaches the second duplicate line,
		// which uniquifies (the pair only occurs once).
		expect(reason).toMatch(/unique anchor exists/);
		expect(reason).toContain("const tail = 1;\nconst tail = 1;");
	});

	it("caps ambiguous sites at five and reports the number omitted", () => {
		writeFileSync(target, Array.from({ length: 7 }, () => "duplicate").join("\n"));
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "duplicate",
			new_string: "replacement",
		});
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toContain("matches 7 times");
		expect(reason).toContain("(L1, L2, L3, L4, L5 (+2 more))");
		expect(reason).not.toContain("L6");
	});

	it("does not report a zero-sized omitted-site suffix", () => {
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: target,
			old_string: "const tail = 1;",
			new_string: "x",
		});
		const reason = formatDoomReason(doom as NonNullable<typeof doom>);
		expect(reason).toContain("L5, L6");
		expect(reason).not.toContain("+0 more");
	});
});

describe("analyzeStrReplaceDoom — fail-open negatives", () => {
	it("returns null when the old_string is present exactly once", () => {
		expect(
			analyzeStrReplaceDoom("Edit", {
				file_path: target,
				old_string: "console.log(msg);",
				new_string: "console.warn(msg);",
			}),
		).toBeNull();
	});

	it("returns null for a multi-match WITH replace_all", () => {
		expect(
			analyzeStrReplaceDoom("Edit", {
				file_path: target,
				old_string: "const tail = 1;",
				new_string: "const tail = 2;",
				replace_all: true,
			}),
		).toBeNull();
	});

	it("rejects incomplete bare Edit payloads and malformed MultiEdit entries", () => {
		expect(
			analyzeStrReplaceDoom("Edit", {
				file_path: target,
				old_string: "const tail = 1;",
			} as never),
		).toBeNull();
		expect(
			analyzeStrReplaceDoom("Edit", {
				file_path: target,
				new_string: "console.warn(msg);",
			} as never),
		).toBeNull();

		for (const malformed of [
			{ old_string: "console.log(msg);", new_string: 42 },
			{ old_string: 42, new_string: "console.warn(msg);" },
		]) {
			const doom = analyzeStrReplaceDoom("MultiEdit", {
				file_path: target,
				edits: [malformed, { old_string: "not in the file", new_string: "x" }],
			} as never);
			expect(doom).toBeNull();
		}
	});

	it("rejects empty edits, null entries, and function-shaped entries", () => {
		expect(analyzeStrReplaceDoom("MultiEdit", { file_path: target, edits: [] })).toBeNull();
		expect(
			analyzeStrReplaceDoom("MultiEdit", { file_path: target, edits: [null] } as never),
		).toBeNull();
		const callable = Object.assign(() => undefined, {
			old_string: "console.log(msg);",
			new_string: "console.warn(msg);",
		});
		expect(
			analyzeStrReplaceDoom("MultiEdit", { file_path: target, edits: [callable] } as never),
		).toBeNull();
	});

	it("preserves array-entry replace_all semantics", () => {
		const ambiguous = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [{ old_string: "const tail = 1;", new_string: "const tail = 2;" }],
		});
		expect(ambiguous?.kind).toBe("ambiguous");
		const replaceAll = analyzeStrReplaceDoom("MultiEdit", {
			file_path: target,
			edits: [{ old_string: "const tail = 1;", new_string: "const tail = 2;", replace_all: true }],
		});
		expect(replaceAll).toBeNull();
	});

	it("does not doom a MultiEdit entry whose anchor is created by an earlier entry", () => {
		expect(
			analyzeStrReplaceDoom("MultiEdit", {
				file_path: target,
				edits: [
					{ old_string: "console.log(msg);", new_string: "report(msg);" },
					{ old_string: "report(msg);", new_string: "report(msg, true);" },
				],
			}),
		).toBeNull();
	});

	it("returns null for a nonexistent file, foreign shapes, and foreign tools", () => {
		expect(
			analyzeStrReplaceDoom("Edit", {
				file_path: join(dir, "absent.js"),
				old_string: "x",
				new_string: "y",
			}),
		).toBeNull();
		expect(analyzeStrReplaceDoom("Edit", { file_path: target })).toBeNull();
		expect(
			analyzeStrReplaceDoom("Write", { file_path: target, old_string: "a", new_string: "b" }),
		).toBeNull();
	});

	it("fails open for a non-string path even when Node would accept the path value", () => {
		const bufferPath = Buffer.from(target) as unknown as string;
		const doom = analyzeStrReplaceDoom("Edit", {
			file_path: bufferPath,
			old_string: "const tail = 1;",
			new_string: "x",
		});
		expect(doom).toBeNull();
	});
});

describe("analyzeApplyPatchDoom", () => {
	const patchFor = (body: string[]): string =>
		["*** Begin Patch", `*** Update File: ${target}`, ...body, "*** End Patch"].join("\n");

	it("warns when hunk context does not match the live file, with rescue", () => {
		const dooms = analyzeApplyPatchDoom("apply_patch", {
			command: patchFor([" function greet(nom) {", "-  console.log(msg);", "+  console.warn(msg);"]),
		});
		expect(dooms).toHaveLength(1);
		expect(dooms[0]?.path).toBe(target);
		expect(dooms[0]?.warning).toMatch(/apply-patch-doom/);
		expect(dooms[0]?.warning).toMatch(/does not match the live file/);
		expect(dooms[0]?.warning).toContain("function greet(name) {");
	});

	it("warns when the update targets a missing file", () => {
		const missing = join(dir, "gone.js");
		const dooms = analyzeApplyPatchDoom("apply_patch", {
			command: [
				"*** Begin Patch",
				`*** Update File: ${missing}`,
				" a",
				"-b",
				"+c",
				"*** End Patch",
			].join("\n"),
		});
		expect(dooms).toHaveLength(1);
		expect(dooms[0]?.warning).toMatch(/does not exist/);
	});

	it("stays silent when the patch applies cleanly", () => {
		const warnings = analyzeApplyPatchDoom("apply_patch", {
			command: patchFor([
				" function greet(name) {",
				'   const msg = "Hello, " + name;',
				"-  console.log(msg);",
				"+  console.warn(msg);",
			]),
		});
		expect(warnings).toEqual([]);
	});

	it("ignores non-update sections and non-apply_patch tools", () => {
		const mismatch = patchFor([" function greet(nom) {"]);
		expect(analyzeApplyPatchDoom("Edit", { command: mismatch })).toEqual([]);
		expect(
			analyzeApplyPatchDoom("apply_patch", {
				command: [
					"*** Begin Patch",
					`*** Add File: ${join(dir, "new.js")}`,
					"+one",
					`*** Update File: ${target}`,
					" function greet(nom) {",
					"*** End Patch",
				].join("\n"),
			}),
		).toHaveLength(1);
	});

	it("caps apply_patch warnings and omits rescue when no near miss exists", () => {
		const command = [
			"*** Begin Patch",
			...Array.from({ length: 5 }, (_, i) => [
				`*** Update File: ${join(dir, `missing-${i}.js`)}`,
				" qwerty completely unrelated text",
				"-still unrelated",
				"+replacement",
			]).flat(),
			"*** End Patch",
		].join("\n");
		const warnings = analyzeApplyPatchDoom("apply_patch", { command });
		expect(warnings).toHaveLength(3);

		const noNearMiss = analyzeApplyPatchDoom("apply_patch", {
			command: patchFor([" qwerty completely unrelated text", "-still unrelated", "+replacement"]),
		});
		expect(noNearMiss).toHaveLength(1);
		expect(noNearMiss[0]?.warning).not.toContain("```");
	});

	it("keeps the first hunk as rescue context when a later @@ marker appears", () => {
		const warnings = analyzeApplyPatchDoom("apply_patch", {
			command: patchFor([
				" function greet(nom) {",
				"@@ second hunk",
				" totally unrelated",
			]),
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.warning).toContain("function greet(name) {");
	});

	it("extracts deletion lines without their patch marker for rescue matching", () => {
		const warnings = analyzeApplyPatchDoom("apply_patch", {
			command: patchFor(["-function greet(nom) {"]),
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.warning).toContain("function greet(name) {");
	});

	it("stays silent for non-apply_patch tools and empty payloads", () => {
		expect(analyzeApplyPatchDoom("Edit", { command: "x" })).toEqual([]);
		expect(analyzeApplyPatchDoom("apply_patch", {})).toEqual([]);
	});

	it("stays silent when the update target exists but can't be read as a file (fail-open on fs errors other than 'missing')", () => {
		// `dir` exists (existsSync true) but is a directory, not a file, so
		// readFileSync throws EISDIR -- this is the catch-block path,
		// distinct from the "does not exist" branch covered above.
		const warnings = analyzeApplyPatchDoom("apply_patch", {
			command: ["*** Begin Patch", `*** Update File: ${dir}`, " a", "-b", "+c", "*** End Patch"].join(
				"\n",
			),
		});
		expect(warnings).toEqual([]);
	});
});
