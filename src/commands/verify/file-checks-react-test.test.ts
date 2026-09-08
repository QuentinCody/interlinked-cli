import { parseWire, wireArray, wireObject, wireRecord, wireString } from "../../lib/value-validation.js";
// ===========================================
// file-checks React / test-smell / taste group unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { type FileCheckContext, runPerFileChecks } from "./file-checks.js";
import { runReactAndTasteChecks } from "./file-checks-react-test.js";
import { type CodeQualityResults, emptyResults } from "./tool-results-types.js";

function ctx(content: string, file = "/tmp/sample.ts"): FileCheckContext {
	return { file, content, relPath: "sample.ts", cwd: "/tmp", r: emptyResults(), piiOpts: {} };
}

function orchestrate(content: string, file = "/tmp/sample.ts"): CodeQualityResults {
	const r = emptyResults();
	runPerFileChecks({
		file,
		content,
		cwd: "/tmp",
		r,
		moduleExportsCache: new Map(),
		allEnvRefs: new Map(),
		piiOpts: {},
	});
	return r;
}

type DelegationCase = {
	name: string;
	file: string;
	content: string;
	bucket: string;
	check: string;
};

function expectDelegatedCheck(testCase: DelegationCase): void {
	const c = ctx(testCase.content, testCase.file);
	runReactAndTasteChecks(c);
	const findings = (parseWire(c.r, wireRecord(wireArray(wireObject({ "check": wireString }))), "test JSON value"))[testCase.bucket];
	expect(findings, `${testCase.name} should produce a delegated finding`).toEqual(
		expect.arrayContaining([expect.objectContaining({ check: testCase.check })]),
	);
}

// These are public diagnostic-contract probes: each fixture is a smallest
// realistic source shape that should produce the named check in the result
// bucket. In particular, asserting `check` catches a mutated diagnostic label
// while still allowing detector wording and line anchors to evolve.
const delegatedChecks: DelegationCase[] = [
	{
		name: "dangerouslySetInnerHTML",
		file: "src/Component.tsx",
		content: '<div dangerouslySetInnerHTML={{ __html: renderHtml() }} />',
		bucket: "dangerouslySetInnerHtml",
		check: "dangerously_set_inner_html",
	},
	{
		name: "excessive useState",
		file: "src/Component.tsx",
		content: Array.from({ length: 8 }, (_, i) => `const [s${i}, setS${i}] = useState(0);`).join("\n"),
		bucket: "excessiveUseState",
		check: "excessive_use_state",
	},
	{
		name: "direct DOM access",
		file: "src/Component.tsx",
		content: "document.querySelector(\"#app\");",
		bucket: "directDomAccess",
		check: "direct_dom_access",
	},
	{
		name: "inline object props",
		file: "src/Component.tsx",
		content: [
			"<Widget one={{ value: 1 }} />",
			"<Widget two={{ value: 2 }} />",
			"<Widget three={{ value: 3 }} />",
		].join("\n"),
		bucket: "inlineObjectProps",
		check: "inline_object_props",
	},
	{
		name: "async event handler",
		file: "src/Component.tsx",
		content: "<button onClick={async () => save()} />",
		bucket: "asyncEventHandler",
		check: "async_event_handler",
	},
	{
		name: "catch and log",
		file: "src/work.ts",
		content: "try {\nwork();\n} catch (error) {\nconsole.error(error);\n}",
		bucket: "catchAndLog",
		check: "catch_and_log",
	},
	{
		name: "unvalidated JSON boundary",
		file: "src/work.ts",
		content: "const data = JSON.parse(raw);\nuse(data.id);",
		bucket: "unvalidatedJsonBoundary",
		check: "unvalidated_json_boundary",
	},
	{
		name: "unsafe JSON.parse",
		file: "src/work.ts",
		content: "const data = JSON.parse(raw);",
		bucket: "jsonParseUnsafe",
		check: "json_parse_unsafe",
	},
	{
		name: "hardcoded timeout",
		file: "src/work.ts",
		content: "setTimeout(run, 100);",
		bucket: "hardcodedTimeout",
		check: "hardcoded_timeout",
	},
	{
		name: "disabled test",
		file: "src/work.test.ts",
		content: 'it.skip("later", () => {});',
		bucket: "disabledTests",
		check: "disabled_tests",
	},
	{
		name: "placeholder test",
		file: "src/work.test.ts",
		content: 'it.todo("implement this");',
		bucket: "placeholderTest",
		check: "placeholder_test",
	},
	{
		name: "target blank without rel",
		file: "src/Link.tsx",
		content: '<a href="/docs" target="_blank">docs</a>',
		bucket: "targetBlankNoRel",
		check: "target_blank_no_rel",
	},
	{
		name: "snapshot overuse",
		file: "src/work.test.ts",
		content: Array.from({ length: 5 }, () => "expect(view).toMatchSnapshot();").join("\n"),
		bucket: "snapshotOveruse",
		check: "snapshot_overuse",
	},
	{
		name: "test importing test",
		file: "src/work.test.ts",
		content: 'import "./other.test.ts";',
		bucket: "testImportingTest",
		check: "test_importing_test",
	},
	{
		name: "excessive useEffect",
		file: "src/Component.tsx",
		content: Array.from({ length: 6 }, () => "useEffect(() => {}, []);").join("\n"),
		bucket: "excessiveUseEffect",
		check: "excessive_use_effect",
	},
	{
		name: "sequential independent awaits",
		file: "src/work.ts",
		content: "const first = await getFirst();\nconst second = await getSecond();",
		bucket: "sequentialAwaits",
		check: "sequential_awaits",
	},
	{
		name: "index as key",
		file: "src/Component.tsx",
		content: "items.map((item, index) => <Row key={index} item={item} />);",
		bucket: "indexAsKey",
		check: "index_as_key",
	},
	{
		name: "missing effect cleanup",
		file: "src/Component.tsx",
		content: "useEffect(() => { window.addEventListener(\"resize\", onResize); }, []);",
		bucket: "missingEffectCleanup",
		check: "missing_effect_cleanup",
	},
	{
		name: "focused test",
		file: "src/work.test.ts",
		content: 'it.only("one case", () => expect(true).toBe(true));',
		bucket: "focusedTests",
		check: "focused_tests",
	},
	{
		name: "over-mocking",
		file: "src/work.test.ts",
		content: Array.from({ length: 8 }, (_, i) => `vi.mock(\"./dep${i}.ts\");`).join("\n"),
		bucket: "overMocking",
		check: "over_mocking",
	},
	{
		name: "migration ordering",
		file: "src/migration.ts",
		content: "sql.exec(`CREATE TABLE users (id TEXT); CREATE INDEX idx ON users(email);`);",
		bucket: "migrationOrdering",
		check: "migration_ordering",
	},
	{
		name: "SQL schema consistency",
		file: "src/migration.ts",
		content: "sql.exec(`CREATE TABLE users (id TEXT); INSERT INTO users (id, email) VALUES (?, ?);`);",
		bucket: "sqlSchemaConsistency",
		check: "sql_schema_consistency",
	},
	{
		name: "visibility filter missing",
		file: "src/migration.ts",
		content: "sql.exec(`CREATE TABLE users (id TEXT, deleted_at TEXT); SELECT id FROM users;`);",
		bucket: "visibilityFilterMissing",
		check: "visibility_filter_missing",
	},
	{
		name: "PII detection",
		file: "src/work.ts",
		content: 'const ssn = "587-65-4321";\nrecord(ssn);',
		bucket: "piiDetection",
		check: "pii_detection",
	},
	{
		name: "assertion-free test",
		file: "src/work.test.ts",
		content: 'it("runs the work", () => { doWork(); });',
		bucket: "assertionFreeTest",
		check: "assertion_free_test",
	},
	{
		name: "tautological assertion",
		file: "src/work.test.ts",
		content: 'it("checks", () => { expect(value).toBe(value); });',
		bucket: "tautologicalAssertion",
		check: "tautological_assertion",
	},
	{
		name: "mocking the SUT",
		file: "src/work.test.ts",
		content: 'vi.mock("./work.ts");',
		bucket: "mockingTheSut",
		check: "mocking_the_sut",
	},
	{
		name: "private member test access",
		file: "src/work.test.ts",
		content: 'it("checks", () => { expect((sut as any)._secret).toBe(1); });',
		bucket: "privateMemberTestAccess",
		check: "private_member_test_access",
	},
	{
		name: "loop nesting depth",
		file: "src/work.ts",
		content: "for (const a of as) {\nfor (const b of bs) {\nfor (const c of cs) {\nwork(a, b, c);\n}\n}\n}",
		bucket: "loopNestingDepth",
		check: "loop_nesting_depth",
	},
	{
		name: "duplicate switch discriminant",
		file: "src/work.ts",
		content: "switch (value.kind) {}\nswitch (value.kind) {}",
		bucket: "duplicateSwitchDiscriminant",
		check: "duplicate_switch_discriminant",
	},
	{
		name: "fuzzy responsibility name",
		file: "src/work.ts",
		content: "class UserManager {}",
		bucket: "fuzzyResponsibilityName",
		check: "fuzzy_responsibility_name",
	},
	{
		name: "hybrid class",
		file: "src/work.ts",
		content: "class User {\nname = \"x\";\nrun() {}\n}",
		bucket: "hybridClass",
		check: "hybrid_class",
	},
	{
		name: "law of Demeter",
		file: "src/work.ts",
		content: "return user.account.profile.settings.theme.value;",
		bucket: "lawOfDemeter",
		check: "law_of_demeter",
	},
	{
		name: "conditional in test",
		file: "src/work.test.ts",
		content: 'it("checks", () => {\nif (enabled) {\nwork();\n}\nexpect(true).toBe(true);\n});',
		bucket: "conditionalInTest",
		check: "conditional_in_test",
	},
	{
		name: "commented-out code",
		file: "src/work.ts",
		content: "// const first = 1;\n// const second = 2;\n// const third = 3;",
		bucket: "commentedOutCode",
		check: "commented_out_code",
	},
	{
		name: "flag argument",
		file: "src/work.ts",
		content: "configure(options, true);",
		bucket: "flagArgument",
		check: "flag_argument",
	},
	{
		name: "non-deterministic test",
		file: "src/work.test.ts",
		content: 'it("checks", () => { const now = Date.now(); expect(now).toBeDefined(); });',
		bucket: "nonDeterministicTest",
		check: "non_deterministic_test",
	},
	{
		name: "timing flake",
		file: "src/work.test.ts",
		content: 'it("waits", async () => {\nawait sleep(300);\nexpect(done).toBe(true);\n});',
		bucket: "timingFlake",
		check: "timing_flake",
	},
	{
		name: "empty catch",
		file: "src/work.ts",
		content: "try { work(); } catch (error) {}",
		bucket: "emptyCatch",
		check: "empty_catch",
	},
	{
		name: "test without description",
		file: "src/work.test.ts",
		content: "it(() => { expect(true).toBe(true); });",
		bucket: "testWithoutDescription",
		check: "test_without_description",
	},
	{
		name: "assertion roulette",
		file: "src/work.test.ts",
		content: `it("many checks", () => {
${Array.from({ length: 8 }, (_, i) => `expect(value${i}).toBe(value${i});`).join("\n")}
});`,
		bucket: "assertionRoulette",
		check: "assertion_roulette",
	},
	{
		name: "magic number",
		file: "src/work.ts",
		content: "configure(1234);",
		bucket: "magicNumber",
		check: "magic_number",
	},
	{
		name: "function argument count",
		file: "src/work.ts",
		content: "function configure(a, b, c, d) {}",
		bucket: "functionArgCount",
		check: "function_arg_count",
	},
	{
		name: "duplicate describe",
		file: "src/work.test.ts",
		content: 'describe("same", () => {});\ndescribe("same", () => {});',
		bucket: "duplicateDescribe",
		check: "duplicate_describe",
	},
	{
		name: "data clump",
		file: "src/work.ts",
		content: "function configure(a: string, b: string, c: string) {}",
		bucket: "dataClump",
		check: "data_clump",
	},
];

describe("runReactAndTasteChecks diagnostic labels", () => {
	it.each(delegatedChecks)("preserves the $check label for $name", (testCase) => {
		expectDelegatedCheck(testCase);
	});
});

describe("runReactAndTasteChecks", () => {
	it("flags nested ternaries (nested_ternaries)", () => {
		const c = ctx('const x = a ? (b ? 1 : 2) : (c ? 3 : 4);\n');
		runReactAndTasteChecks(c);
		expect(c.r.nestedTernaries.length).toBeGreaterThan(0);
		expect(nonNull(c.r.nestedTernaries[0]).check).toBe("nested_ternaries");
	});

	it("flags an else-if chain (else_if_chain)", () => {
		// ELSE_IF_CHAIN requires `if (...){...}` + 2+ braced `else if` blocks.
		const c = ctx(
			"if (n === 1) { a(); } else if (n === 2) { b(); }" +
				" else if (n === 3) { c(); } else if (n === 4) { d(); }\n",
		);
		runReactAndTasteChecks(c);
		expect(c.r.elseIfChain.length).toBeGreaterThan(0);
		expect(nonNull(c.r.elseIfChain[0]).check).toBe("else_if_chain");
	});

	it("produces the same nested_ternaries findings as the orchestrator (delegation)", () => {
		const src = 'const x = a ? (b ? 1 : 2) : (c ? 3 : 4);\n';
		const c = ctx(src);
		runReactAndTasteChecks(c);
		expect(c.r.nestedTernaries).toEqual(orchestrate(src).nestedTernaries);
	});

	it("runs PII detection into piiDetection bucket without throwing", () => {
		const c = ctx('export const value = 1;\n');
		expect(() => runReactAndTasteChecks(c)).not.toThrow();
		expect(Array.isArray(c.r.piiDetection)).toBe(true);
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value = 1;\n');
		runReactAndTasteChecks(c);
		expect(c.r.nestedTernaries).toHaveLength(0);
		expect(c.r.elseIfChain).toHaveLength(0);
	});
});
