// Red-team 2026-10-21 — "Exemption-marker laundering (`@codegen-data` header
// on hand-written code)". A `// @codegen-data` header the edit itself added
// reached `isCappableFile` through the projected after-content and silenced the
// cyclomatic and cognitive gates (and every other consumer of that predicate)
// for a hand-written CC-72 function. Fix (large-file-policy.ts): the marker is
// honored only for branch-free content — `isCodegenDataModule`. Round 2
// (exemption-marker-budget.ts): the budget counts code INSIDE `${...}`
// interpolations (recursively), and every generator header `isGeneratedFile`
// honours gets the same budget. These pins
// drive the REAL gates inside a disposable OS-temp root; the live
// `.interlinked/*.json` of this repository is never read or written.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetFunctionComplexityBaselineCache } from "../function-complexity-baseline.js";
import {
	CODEGEN_DATA_BRANCH_BUDGET,
	codegenDataMarkerDenial,
	generatorMarkerDenial,
	isCappableFile,
	isCodegenDataModule,
	isHonoredGeneratedFile,
} from "../large-file-policy.js";
import { resetMetricCapsCache } from "../metric-caps.js";
import { __setTsParserForTesting, branchTokenCount } from "../exemption-marker-budget.js";
import { isTestableSourceFile } from "../tested-file-policy.js";
import { checkCognitiveComplexityWrite } from "./cognitive-write-guard.js";
import { checkFunctionComplexityWrite } from "./complexity-write-guard.js";

/** The exact header the red-team record used. */
const MARKER = "// @codegen-data — route table (see route-dispatch.gen.mjs)\n";

/** The red-team's laundered route table: 34 `if (a && b)` arms + a 4-way switch
 *  in one function (cyclomatic ≈ 72, cognitive ≈ 69 under this tree's analyzers). */
function launderedRouteTable(): string {
	const arms: string[] = [];
	for (let i = 0; i < 34; i++) arms.push(`\tif (kind === "k${i}" && input.x${i}) return "R${i}";`);
	return (
		"export function dispatchRoute(kind: string, input: Record<string, unknown>): string {\n" +
		`${arms.join("\n")}\n` +
		'\tswitch (input.mode) { case 1: return "m1"; case 2: return "m2"; case 3: return "m3"; default: return "m0"; }\n' +
		"}\n"
	);
}

/** A disposable guarded root carrying this repo's cap shape (cyclomatic 16,
 *  cognitive 15, empty ledger) — written fresh, never copied from the live tree. */
function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "red-team-codegen-marker-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(
		join(root, ".interlinked/metric-caps.json"),
		`${JSON.stringify({ version: 1, max_cyclomatic: 16, max_cognitive: 15 }, null, 2)}\n`,
	);
	writeFileSync(
		join(root, ".interlinked/function-complexity-baseline.json"),
		`${JSON.stringify(
			{ version: 1, metrics: { cyclomatic: { cap: 16, entries: [] }, cognitive: { cap: 15, entries: [] } } },
			null,
			2,
		)}\n`,
	);
	return root;
}

let root: string;

beforeEach(() => {
	resetMetricCapsCache();
	resetFunctionComplexityBaselineCache();
	root = makeRoot();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("red-team 2026-10-21 codegen-marker laundering — positive (must block)", () => {
	it("P1: Exemption-marker laundering — a Write whose header adds @codegen-data to a CC-72 function is blocked by the cyclomatic gate", () => {
		const content = MARKER + launderedRouteTable();
		const verdict = checkFunctionComplexityWrite({ file_path: "src/route-dispatch.ts", content }, root);
		expect(verdict).not.toBeNull();
		expect(verdict?.block).toContain("dispatchRoute");
		// The control the red team ran: without the marker the same write blocks —
		// the marker must make no difference.
		const control = checkFunctionComplexityWrite(
			{ file_path: "src/route-dispatch.ts", content: launderedRouteTable() },
			root,
		);
		expect(control).not.toBeNull();
	});

	it("P2: Exemption-marker laundering — the same marked Write is blocked by the cognitive gate", () => {
		const content = MARKER + launderedRouteTable();
		const verdict = checkCognitiveComplexityWrite({ file_path: "src/route-dispatch.ts", content }, root);
		expect(verdict).not.toBeNull();
		expect(verdict?.block).toContain("dispatchRoute");
	});

	it("P3: Exemption-marker laundering — an Edit that adds the marker AND the function to a clean cappable file is blocked", () => {
		const clean = "export const x = 1;\n";
		writeFileSync(join(root, "src/clean.ts"), clean);
		const verdict = checkFunctionComplexityWrite(
			{ file_path: "src/clean.ts", old_string: clean, new_string: MARKER + clean + launderedRouteTable() },
			root,
		);
		expect(verdict).not.toBeNull();
		expect(verdict?.block).toContain("dispatchRoute");
	});

	it("P4: Exemption-marker laundering — two-step: a marker landed first on branch-free data stops counting the moment branches arrive", () => {
		// Step 1 is a legitimate data module and lands.
		const data = `${MARKER}export const TABLE = \`row\`;\n`;
		expect(isCappableFile({ filePath: join(root, "src/table.ts"), content: data, root })).toBe(false);
		writeFileSync(join(root, "src/table.ts"), data);
		// Step 2 appends hand-written branches under the already-present header.
		const verdict = checkFunctionComplexityWrite(
			{ file_path: "src/table.ts", old_string: "export const TABLE = `row`;\n", new_string: launderedRouteTable() },
			root,
		);
		expect(verdict).not.toBeNull();
		expect(verdict?.block).toContain("dispatchRoute");
	});

	it("P5: Exemption-marker laundering — the predicate itself refuses the marker on branchy content and names the evidence", () => {
		const content = MARKER + launderedRouteTable();
		expect(isCodegenDataModule(content)).toBe(false);
		expect(isCappableFile({ filePath: "src/route-dispatch.ts", content })).toBe(true);
		const denial = codegenDataMarkerDenial(content);
		expect(denial).toContain("@codegen-data refused");
		expect(denial).toContain("`if` at line 3");
		// Operators alone launder nothing either: a `&&`/`||`/`??`/ternary chain
		// is what cyclomatic-ast.ts counts, so it is what the budget counts.
		const operatorsOnly =
			`${MARKER}export function pick(a: number, b: number): number {\n` +
			"\treturn a && b || a ?? b ? a : b;\n}\n";
		expect(isCodegenDataModule(operatorsOnly)).toBe(false);
		// Branches hidden in a template literal are data; branches outside are not.
		const hiddenThenReal = `${MARKER}export const T = \`if (x) { if (y) {} }\`;\nexport const v = a ? b : c ? d : e ? f : g;\n`;
		expect(isCodegenDataModule(hiddenThenReal)).toBe(false);
	});
});

describe("red-team 2026-10-21 codegen-marker laundering — negative (must not fire)", () => {
	it("N1: a genuine codegen-DATA module (template-string carrier with one `??` default) stays exempt and passes the gate", () => {
		const carrier =
			"// hook-chunk.ts @codegen-data: template DATA emitted verbatim into the .mjs\n" +
			"export function renderChunk(mode?: string): string {\n" +
			'\tconst preset = mode ?? "quality";\n' +
			// The template body is the emitted script: branches INSIDE it are data.
			"\treturn `if (a) { if (b) { for (const x of xs) { while (x) { switch (x) { case 1: break; } } } } } ${preset}`;\n" +
			"}\n";
		expect(codegenDataMarkerDenial(carrier)).toBeNull();
		expect(isCodegenDataModule(carrier)).toBe(true);
		expect(isCappableFile({ filePath: "src/lib/hook-chunk.ts", content: carrier })).toBe(false);
		expect(checkFunctionComplexityWrite({ file_path: "src/lib/hook-chunk.ts", content: carrier }, root)).toBeNull();
		expect(checkCognitiveComplexityWrite({ file_path: "src/lib/hook-chunk.ts", content: carrier }, root)).toBeNull();
	});

	it("N2: every live @codegen-data carrier in this tree is still honored", () => {
		const carriers = [
			"src/harness/language-profiles-data.ts",
			"src/lib/hooks-template.ts",
			"src/commands/verify/section-table-agent-safety-taste.ts",
			"src/lib/hook-template-chunks/redaction.ts",
			"src/lib/hook-template-chunks/event-normalizers-claude.ts",
			"src/lib/hook-template-chunks/guards-inline.ts",
			"src/lib/hook-template-chunks/event-normalizers-copilot.ts",
			"src/lib/hook-template-chunks/session-state.ts",
			"src/lib/hook-template-chunks/event-normalizers-gemini.ts",
			"src/lib/hook-template-chunks/event-normalizers-cursor.ts",
		].filter((rel) => existsSync(join(process.cwd(), rel)));
		expect(carriers.length).toBeGreaterThan(0);
		for (const rel of carriers) {
			const content = readFileSync(join(process.cwd(), rel), "utf8");
			expect(codegenDataMarkerDenial(content), rel).toBeNull();
			expect(isCappableFile({ filePath: rel, content }), rel).toBe(false);
		}
	});

	it("N3: an honest unmarked write of a small function passes the gate and stays governed", () => {
		const honest =
			"export function route(kind: string): string {\n" +
			'\tif (kind === "a") return "A";\n' +
			'\treturn kind === "b" ? "B" : "other";\n' +
			"}\n";
		expect(checkFunctionComplexityWrite({ file_path: "src/route.ts", content: honest }, root)).toBeNull();
		expect(checkCognitiveComplexityWrite({ file_path: "src/route.ts", content: honest }, root)).toBeNull();
		expect(isCappableFile({ filePath: "src/route.ts", content: honest })).toBe(true);
		// No marker ⇒ nothing to refuse.
		expect(codegenDataMarkerDenial(honest)).toBeNull();
	});

	it("N4: the budget boundary — exactly CODEGEN_DATA_BRANCH_BUDGET branch tokens are honored, one more is refused", () => {
		const atBudget = `${MARKER}export const a = x ?? y;\nexport const b = p || q;\n`;
		const overBudget = `${atBudget}export const c = m && n;\n`;
		expect(CODEGEN_DATA_BRANCH_BUDGET).toBe(2);
		expect(isCodegenDataModule(atBudget)).toBe(true);
		expect(isCodegenDataModule(overBudget)).toBe(false);
		// Optional property / optional chaining are not branches.
		const optional = `${MARKER}export interface R { m?: string }\nexport const g = (r: R) => r.m?.length;\n`;
		expect(isCodegenDataModule(optional)).toBe(true);
	});
});

// ---------- round 2: interpolation code and generator headers ----------

const SIGNATURE = "export function dispatchRoute(kind: string, input: Record<string, unknown>): string {\n";

/** V4: the 34-arm chain as a ternary INSIDE a template interpolation. */
function ternaryInInterpolation(): string {
	const arms: string[] = [];
	for (let i = 0; i < 34; i++) arms.push(`kind === "k${i}" && input.x${i} ? "R${i}"`);
	return `${SIGNATURE}\treturn \`route=\${${arms.join(" : ")} : "none"}\`;\n}\n`;
}

/** V5: the original `if` arms + switch inside an IIFE inside an interpolation. */
function iifeInInterpolation(): string {
	const body = launderedRouteTable().split("\n").slice(1, -2).join("\n");
	return `${SIGNATURE}\treturn \`\${(() => {\n${body}\n\t})()}\`;\n}\n`;
}

/** The V4 chain wrapped in `depth` nested templates (`\`${\`${ … }\`}\``). */
function nestedTemplates(depth: number): string {
	const arms: string[] = [];
	for (let i = 0; i < 34; i++) arms.push(`kind === "k${i}" && input.x${i} ? "R${i}"`);
	let expr = `${arms.join(" : ")} : "none"`;
	for (let d = 0; d < depth; d++) expr = `\`t${d} \${${expr}}\``;
	return `${SIGNATURE}\treturn ${expr};\n}\n`;
}

const GENERATED = "// @generated by routegen\n";
const GO_STYLE = "// Code generated by routegen. DO NOT EDIT.\n";

/** Both caps gates must decide a marked write exactly as the unmarked control:
 *  the header may change nothing about a body that carries control flow. */
function expectMarkerChangesNothing(header: string, body: string, file = "src/route-dispatch.ts"): void {
	const marked = { file_path: file, content: header + body };
	const control = { file_path: file, content: body };
	// The header shifts line numbers in the plan sub-lines, so compare the
	// verdict line that names each over-cap function.
	const verdictLine = (block: string | undefined): string | undefined =>
		block?.split("\n").find((line) => line.trimStart().startsWith("•"));
	const cyclo = checkFunctionComplexityWrite(control, root);
	expect(cyclo, "unmarked control must block").not.toBeNull();
	const markedCyclo = checkFunctionComplexityWrite(marked, root);
	expect(markedCyclo, "marked write must block").not.toBeNull();
	expect(verdictLine(markedCyclo?.block)).toBe(verdictLine(cyclo?.block));
	const cog = checkCognitiveComplexityWrite(control, root);
	const markedCog = checkCognitiveComplexityWrite(marked, root);
	expect(markedCog === null).toBe(cog === null);
	expect(verdictLine(markedCog?.block)).toBe(verdictLine(cog?.block));
	expect(isCappableFile({ filePath: file, content: header + body, root })).toBe(true);
}

describe("red-team 2026-10-21 round 2 — positive (must block)", () => {
	it("P6: V4 — a 34-arm ternary chain inside a template interpolation under @codegen-data is blocked", () => {
		expectMarkerChangesNothing(MARKER, ternaryInInterpolation());
		expect(codegenDataMarkerDenial(MARKER + ternaryInInterpolation())).toContain("@codegen-data refused");
	});

	it("P7: V5 — an IIFE with if/switch inside an interpolation under @codegen-data is blocked", () => {
		expectMarkerChangesNothing(MARKER, iifeInInterpolation());
	});

	it("P8: a nested template inside an interpolation is counted, at any depth", () => {
		expectMarkerChangesNothing(MARKER, nestedTemplates(2));
		// Deeper than the shared extractor's recursion limit (3).
		expectMarkerChangesNothing(MARKER, nestedTemplates(6));
	});

	it("P9: V2 — an @generated header on the CC-72 body is not an exemption", () => {
		expectMarkerChangesNothing(GENERATED, launderedRouteTable());
		expect(generatorMarkerDenial(GENERATED + launderedRouteTable(), "src/r.ts")).toContain("refused");
	});

	it('P10: V3 — a "Code generated … DO NOT EDIT." header on the CC-72 body is not an exemption', () => {
		expectMarkerChangesNothing(GO_STYLE, launderedRouteTable());
		expectMarkerChangesNothing("/* This file is auto-generated, do not edit */\n", launderedRouteTable());
	});

	it("P11: an Edit that adds a generator header AND the function to a clean file is blocked", () => {
		const clean = "export const x = 1;\n";
		writeFileSync(join(root, "src/clean.ts"), clean);
		for (const header of [GENERATED, GO_STYLE, MARKER]) {
			const edit = { file_path: "src/clean.ts", old_string: clean, new_string: header + clean + iifeInInterpolation() };
			expect(checkFunctionComplexityWrite(edit, root), header).not.toBeNull();
		}
	});

	it("P12: class variant — a `x! / y` division cannot pose as a regex that hides branches", () => {
		const ifs = Array.from({ length: 20 }, (_, i) => `if (a${i}) return ${i};`).join(" ");
		const body = `export function f(x: number | null, ${Array.from({ length: 20 }, (_, i) => `a${i}: boolean`).join(", ")}): number { const r = x! / 2; ${ifs} return r / 3; }\n`;
		expectMarkerChangesNothing(MARKER, body);
	});

	it("P13: class variant — a backtick inside a string cannot open a template that hides branches", () => {
		const body = `export const OPEN = "\`";\n${launderedRouteTable()}export const CLOSE = "\`";\n`;
		expectMarkerChangesNothing(GENERATED, body);
	});

	it("P14: class variant — a Python generator header on a branchy module, or an f-string carrying branches, is cappable", () => {
		const arms = Array.from({ length: 20 }, (_, i) => `    ${i === 0 ? "if" : "elif"} kind == "k${i}" and x${i}:\n        return ${i}`);
		const py = `# Code generated by routegen. DO NOT EDIT.\ndef route(kind, ${Array.from({ length: 20 }, (_, i) => `x${i}`).join(", ")}):\n${arms.join("\n")}\n    return -1\n`;
		expect(isCappableFile({ filePath: "src/route.py", content: py, root })).toBe(true);
		const fstring = `# @generated\nX = f"{a if b else c if d else e if g else h}"\n`;
		expect(isCappableFile({ filePath: "src/x.py", content: fstring, root })).toBe(true);
	});
});

describe("red-team 2026-10-21 round 2 — negative (must not fire)", () => {
	it("N5: a 2,000-line literal data table under @codegen-data stays exempt and passes both gates", () => {
		const rows = Array.from(
			{ length: 2000 },
			(_, i) => `\t{ id: ${i}, name: "row-${i} if/for", tags: ["case", "while"], re: /a|b?/g, ok: true },`,
		);
		const table = `${MARKER}export const TABLE = [\n${rows.join("\n")}\n];\n`;
		expect(isCodegenDataModule(table, "src/table.ts")).toBe(true);
		expect(isCappableFile({ filePath: "src/table.ts", content: table, root })).toBe(false);
		expect(checkFunctionComplexityWrite({ file_path: "src/table.ts", content: table }, root)).toBeNull();
		expect(checkCognitiveComplexityWrite({ file_path: "src/table.ts", content: table }, root)).toBeNull();
	});

	it("N6: a generated file whose only interpolation is a `${preset}` carrier stays exempt", () => {
		const carrier =
			"// @generated by hookgen — DO NOT EDIT.\n" +
			"export function render(preset: string): string {\n" +
			"\treturn `#!/usr/bin/env node\nif (a) { while (b) { switch (c) { case 1: break; } } }\nconst mode = ${preset};\n`;\n" +
			"}\n";
		expect(isHonoredGeneratedFile(carrier, "src/lib/hook.ts")).toBe(true);
		expect(isCappableFile({ filePath: "src/lib/hook.ts", content: carrier, root })).toBe(false);
	});

	it("N7: simple `${a.b}` property interpolations carry no branch", () => {
		const tpl =
			`${MARKER}export const render = (cfg: { a: { b: string }; c: string }) =>\n` +
			"\t`if (x) ${cfg.a.b} for ${cfg.c} while ${cfg.a.b}`;\n";
		expect(codegenDataMarkerDenial(tpl, "src/t.ts")).toBeNull();
		expect(isCappableFile({ filePath: "src/t.ts", content: tpl, root })).toBe(false);
	});
});

// ---------- round 3: the branch count comes from the TypeScript parser ----------

const LINE_SEPARATOR = String.fromCharCode(0x2028);

function ifArms(): string {
	return Array.from({ length: 34 }, (_, i) => `\tif (kind === "k${i}" && input.x${i}) return "R${i}";`).join("\n");
}

/** SIGNATURE, `before`, the 34 `if (a && b)` arms, `after`, a closing return. */
function wrapArms(before: string, after: string): string {
	return `${SIGNATURE}${before}\n${ifArms()}\n${after}\n\treturn "none";\n}\n`;
}

/** The P14 Python route table (20 `if`/`elif` arms with `and`). */
function pythonRouteTable(): string {
	const arms = Array.from({ length: 20 }, (_, i) => `    ${i === 0 ? "if" : "elif"} kind == "k${i}" and x${i}:\n        return ${i}`);
	const params = Array.from({ length: 20 }, (_, i) => `x${i}`).join(", ");
	return `# Code generated by routegen. DO NOT EDIT.\ndef route(kind, ${params}):\n${arms.join("\n")}\n    return -1\n`;
}

describe("red-team 2026-10-21 round 3 — positive (must block)", () => {
	it("P15: B6 — CR-only line endings cannot end the header comment late and hide the body", () => {
		const header = MARKER.replace("\n", "\r");
		const body = launderedRouteTable().replace(/\n/g, "\r");
		expectMarkerChangesNothing(header, body);
		expect(branchTokenCount(header + body, "src/route-dispatch.ts")).toBeGreaterThan(CODEGEN_DATA_BRANCH_BUDGET);
	});

	it("P16: B7 — U+2028 line separators cannot hide the body behind a line comment", () => {
		const header = `// @codegen-data\n// note${LINE_SEPARATOR}`;
		const body = launderedRouteTable().split("\n").join(LINE_SEPARATOR);
		expectMarkerChangesNothing(header, body);
	});

	it("P17: B8 — `o.in / 2` (a reserved word as a property name) is division, not a regex opener", () => {
		const arms = ifArms().replace(/\n\t/g, " ").trim();
		const body =
			"export function dispatchRoute(kind: string, input: Record<string, unknown>): string { " +
			"const o = { in: 4, return: 6, delete: 8, typeof: 10 }; " +
			"const q = o.in / 2 + o.return / 3 + o.delete / 4 + o.typeof / 5; " +
			`${arms} return String(q / 2); }\n`;
		expectMarkerChangesNothing(MARKER, body);
	});

	it("P18: B10 — a regex after `)` cannot pose as division and open a template that hides the body", () => {
		const probe = "\tif (kind) /`/.test(kind);";
		expectMarkerChangesNothing(MARKER, wrapArms(probe, probe));
	});

	it("P19: B13 — a statement-position regex after a block `}` is a regex, not division", () => {
		const probe = "\t{ }\n\t/`/.test(kind);";
		expectMarkerChangesNothing(MARKER, wrapArms(probe, probe));
	});

	it("P20: B11 — `/*` and `*/` in JSX text are text, not a block comment that hides the body", () => {
		expectMarkerChangesNothing(MARKER, wrapArms("\tconst a = <p>/*</p>;", "\tconst b = <p>*/</p>;"), "src/route-dispatch.tsx");
	});

	it("P21: B12 — a backtick in JSX text is text, not a template that hides the body", () => {
		expectMarkerChangesNothing(MARKER, wrapArms("\tconst a = <p>`</p>;", "\tconst b = <p>`</p>;"), "src/route-dispatch.tsx");
	});

	it("P22: B15 — a Python generator header on a CR-only branchy module is not an exemption", () => {
		const lf = pythonRouteTable();
		const cr = lf.replace(/\n/g, "\r");
		expect(isCappableFile({ filePath: "src/route.py", content: cr, root })).toBe(true);
		expect(branchTokenCount(cr, "src/route.py")).toBe(branchTokenCount(lf, "src/route.py"));
		expect(branchTokenCount(cr, "src/route.py")).toBeGreaterThan(CODEGEN_DATA_BRANCH_BUDGET);
	});

	it("P23: `typescript` unavailable — the marker is DENIED (fail closed) and a NOT MEASURED warning says so", () => {
		const data = `${MARKER}export const TABLE = ["if", "for"];\n`;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		__setTsParserForTesting(() => null);
		try {
			const denial = codegenDataMarkerDenial(data, "src/table.ts");
			expect(denial).toContain("@codegen-data refused");
			expect(denial).toContain("NOT MEASURED");
			expect(denial).toContain("`typescript` is not resolvable");
			expect(isCodegenDataModule(data, "src/table.ts")).toBe(false);
			expect(isCappableFile({ filePath: "src/table.ts", content: data, root })).toBe(true);
			expect(isHonoredGeneratedFile(`${GENERATED}export const X = 1;\n`, "src/x.ts")).toBe(false);
			const warned = stderr.mock.calls.map((call) => String(call[0])).join("");
			expect(warned).toContain("[interlinked:codegen-marker] NOT MEASURED for src/table.ts");
		} finally {
			__setTsParserForTesting();
			stderr.mockRestore();
		}
		expect(isCodegenDataModule(data, "src/table.ts")).toBe(true);
	});

	it("P24: a marked file that does not parse is DENIED, never counted by a fallback lexer", () => {
		const broken = `${MARKER}export const TABLE = [1, 2;\n`;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(codegenDataMarkerDenial(broken, "src/broken.ts")).toContain("does not parse");
			expect(isCappableFile({ filePath: "src/broken.ts", content: broken, root })).toBe(true);
		} finally {
			stderr.mockRestore();
		}
	});

	it("P25: tested-file-policy routes through the same budget — a header on branchy code leaves it testable", () => {
		for (const header of [MARKER, GENERATED, GO_STYLE]) {
			expect(isTestableSourceFile({ filePath: "src/route-dispatch.ts", content: header + launderedRouteTable() }), header).toBe(true);
		}
		const cr = (MARKER + launderedRouteTable()).replace(/\n/g, "\r");
		expect(isTestableSourceFile({ filePath: "src/route-dispatch.ts", content: cr })).toBe(true);
	});
});

describe("red-team 2026-10-21 round 3 — negative (must not fire)", () => {
	const carrier =
		"// @codegen-data — template DATA emitted verbatim into the .mjs\n" +
		"export function renderChunk(mode?: string): string {\n" +
		'\tconst preset = mode ?? "quality";\n' +
		"\treturn `if (a) { for (;;) { while (b) {} } } ${preset}`;\n" +
		"}\n";

	it("N8: a genuine carrier stays exempt under CR-only and U+2028 line endings", () => {
		for (const content of [carrier.replace(/\n/g, "\r"), carrier.split("\n").join(LINE_SEPARATOR)]) {
			expect(codegenDataMarkerDenial(content, "src/lib/chunk.ts")).toBeNull();
			expect(isCappableFile({ filePath: "src/lib/chunk.ts", content, root })).toBe(false);
		}
	});

	it("N9: a .tsx data module whose JSX text mentions branches stays exempt", () => {
		const tsx = `${MARKER}export const Help = () => <p>if a && b, for each case: x ? y : z /* not code */</p>;\n`;
		expect(branchTokenCount(tsx, "src/help.tsx")).toBe(0);
		expect(isCappableFile({ filePath: "src/help.tsx", content: tsx, root })).toBe(false);
	});

	it("N10: tested-file-policy still exempts an honoured carrier and an honoured generated table", () => {
		expect(isTestableSourceFile({ filePath: "src/lib/chunk.ts", content: carrier })).toBe(false);
		const table = `${GENERATED}export const ROWS = [{ id: 1, name: "if" }];\n`;
		expect(isTestableSourceFile({ filePath: "src/lib/rows.ts", content: table })).toBe(false);
	});

	it("N11: a CR-only Python data module with branch words in comments and strings stays honoured", () => {
		const py = '# @generated\r# if for while\rROWS = ["if", "and", \'or\']\r';
		expect(branchTokenCount(py, "src/rows.py")).toBe(0);
		expect(isCappableFile({ filePath: "src/rows.py", content: py, root })).toBe(false);
	});
});
