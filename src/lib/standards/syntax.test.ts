import { expect, it } from "vitest";
import { scanStandardsSyntax } from "./syntax.js";

it("counts real type syntax while leaving comment and string text untouched", () => {
	const result = scanStandardsSyntax('const text = "as any; value!; throw"; // as any\nconst parsed = JSON.parse(input) as { value: any }; parsed.value!;', "source.ts");
	expect(result.state).toBe("measured");
	expect(result.findings.filter(row => row.rule === "type_assertion")).toHaveLength(1);
	expect(result.findings.filter(row => row.rule === "explicit_any")).toHaveLength(1);
	expect(result.findings.filter(row => row.rule === "non_null_ast")).toHaveLength(1);
	expect(result.findings.filter(row => row.rule === "throw_statement")).toHaveLength(0);
	expect(result.findings.every(row => row.startOffset >= 0 && row.endOffset > row.startOffset)).toBe(true);
});

it("recognizes eager direct, immediately invoked and static initialization without deferred bodies", () => {
	const result = scanStandardsSyntax("fetch(direct); (() => fetch(immediate))(); class Service { static value = fetch(staticValue); value = fetch(instance); } const deferred = () => fetch(later);", "source.ts");
	expect(result.findings.filter(row => row.rule === "module_init_effect")).toHaveLength(3);
	expect(result.findings.filter(row => row.rule === "module_init_effect").every(row => row.kind === "semantic_candidate")).toBe(true);
});

it("keeps transaction-shaped direct waits as candidates and excludes deferred nested callbacks", () => {
	const result = scanStandardsSyntax("db.transaction(async () => { await fetch(url); const deferred = () => fetch(later); });", "source.ts");
	expect(result.findings.filter(row => row.rule === "transaction_api_candidate")).toHaveLength(1);
	expect(result.findings.filter(row => row.rule === "transaction_external_effect_candidate")).toHaveLength(1);
});

it("distinguishes boolean argument syntax, named options and lifecycle-shape candidates", () => {
	const result = scanStandardsSyntax("type State = { ready: boolean; sent: boolean; at?: string }; function take(flag: boolean) {} take(true); take({ flag: true });", "source.ts");
	expect(result.findings.filter(row => row.rule === "boolean_state_bag_candidate")).toHaveLength(1);
	expect(result.findings.filter(row => row.rule === "boolean_parameter")).toHaveLength(1);
	expect(result.findings.filter(row => row.rule === "positional_boolean_argument")).toHaveLength(1);
});

it("reports unavailable parser and incomplete syntax explicitly", () => {
	expect(scanStandardsSyntax("const value = 1;", "source.ts", () => null)).toMatchObject({ state: "unsupported", findings: [] });
	expect(scanStandardsSyntax("function broken( {", "source.ts")).toMatchObject({ state: "inconclusive", findings: [] });
});

it("measures declaration documentation presence without claiming usefulness", () => {
	const result = scanStandardsSyntax("/** Public invariant. */ export function documented() {}\nexport const undocumented = 1;", "source.ts");
	expect(result.findings.filter(row => row.rule === "exported_declaration")).toHaveLength(2);
	expect(result.findings.filter(row => row.rule === "exported_without_jsdoc")).toHaveLength(1);
});

it("distinguishes type-only import forms, mixed bindings and side-effect imports", () => {
	const result = scanStandardsSyntax('import type { A } from "a"; import { type B } from "b"; import { type C, value } from "c"; import "side-effect";', "source.ts");
	expect(result.findings.filter(row => row.rule === "value_import_declaration")).toHaveLength(2);
});

it("recognizes static member names through trivia and parentheses", () => {
	const result = scanStandardsSyntax('(JSON) /* comment */ . parse(input); JSON["parse"](input); Math /* comment */ . random(); (process).env.KEY; db.transaction(async () => { await http /* comment */ . get(url); });', "source.ts");
	expect(result.findings.filter(row => row.rule === "raw_json_parse")).toHaveLength(2);
	expect(result.findings.filter(row => row.rule === "ambient_clock_random")).toHaveLength(1);
	expect(result.findings.filter(row => row.rule === "process_env_access")).toHaveLength(1);
	expect(result.findings.filter(row => row.rule === "transaction_external_effect_candidate")).toHaveLength(1);
});
