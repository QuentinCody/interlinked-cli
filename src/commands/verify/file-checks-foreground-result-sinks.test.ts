import { expect, it, vi } from "vitest";
import type { CodeQualityIssue, CodeQualityResults } from "./tool-results-types.js";
import { emptyResults } from "./tool-results-types.js";
import { runAgentSafetyChecks } from "./file-checks-agent-safety.js";
import { runReactAndTasteChecks } from "./file-checks-react-test.js";
import { runPerFileChecks } from "./file-checks.js";
import { runTestDiscriminationChecks } from "./file-checks-test-discrimination.js";
import { runEndpointAndLazinessChecks } from "./file-checks-endpoint-laziness.js";

const emitted = vi.hoisted(() => ({ check: "", rows: [] as CodeQualityIssue[] }));
vi.mock("./file-checks-shared.js", () => ({ toIssues: (check: string) => check === emitted.check ? emitted.rows : [] }));

const cases = [
	["lossy_error_rethrow", "lossyErrorRethrow", runAgentSafetyChecks],
	["error_dispatch_by_instanceof", "errorDispatchByInstanceof", runAgentSafetyChecks],
	["discriminated_union_exhaustiveness", "discriminatedUnionExhaustiveness", runAgentSafetyChecks],
	["import_from_own_barrel", "importFromOwnBarrel", runAgentSafetyChecks],
	["promise_reject_non_error", "promiseRejectNonError", runAgentSafetyChecks],
	["non_null_assertion", "nonNullAssertions", runAgentSafetyChecks],
	["floating_promises", "floatingPromises", runAgentSafetyChecks],
	["boolean_trap", "booleanTrap", runAgentSafetyChecks],
	["positional_optional_boolean", "positionalOptionalBoolean", runAgentSafetyChecks],
	["many_optional_params", "manyOptionalParams", runAgentSafetyChecks],
	["same_typed_primitive_params", "sameTypedPrimitiveParams", runAgentSafetyChecks],
	["hybrid_class", "hybridClass", runReactAndTasteChecks],
	["fuzzy_responsibility_name", "fuzzyResponsibilityName", runReactAndTasteChecks],
	["assertion_free_test", "assertionFreeTest", runReactAndTasteChecks],
	["tautological_assertion", "tautologicalAssertion", runReactAndTasteChecks],
	["focused_tests", "focusedTests", runReactAndTasteChecks],
	["disabled_tests", "disabledTests", runReactAndTasteChecks],
	["vacuous_loop_assertion", "vacuousLoopAssertion", runTestDiscriminationChecks],
	["commented_out_assertion", "commentedOutAssertion", runTestDiscriminationChecks],
	["fallback_only_assertion", "fallbackOnlyAssertion", runTestDiscriminationChecks],
	["introverted_test", "introvertedTest", runEndpointAndLazinessChecks],
] as const;

it.each(cases)("retains %s results beyond the JavaScript spread argument ceiling", (check, bucket, run) => {
	const first = { check, file: "source.ts", line: 1, message: "first retained observation" };
	const last = { check, file: "source.ts", line: 150_001, message: "final retained observation" };
	emitted.check = check; emitted.rows = Array<CodeQualityIssue>(150_001).fill(first); emitted.rows[150_000] = last;
	const results: CodeQualityResults = emptyResults();
	run({ file: "/repo/source.ts", relPath: "source.ts", cwd: "/repo", content: "", r: results, piiOpts: {} });
	expect(results[bucket]).toHaveLength(150_001);
	expect(results[bucket][0]).toBe(first); expect(results[bucket].at(-1)).toBe(last);
	emitted.rows = [];
});

it("retains an unbounded mapped bucket through ordinary inline suppression processing", () => {
	emitted.check = "lossy_error_rethrow";
	const first = { check: emitted.check, file: "source.ts", line: 1, message: "retained observation" };
	const last = { ...first, line: 150_001, message: "final retained observation" };
	emitted.rows = Array<CodeQualityIssue>(150_001).fill(first); emitted.rows[150_000] = last;
	const results = emptyResults();
	runPerFileChecks({ file: "/repo/source.ts", cwd: "/repo",
		content: "// interlinked-ignore: other_check — separate reviewed scope\nconst value = 1;",
		r: results, moduleExportsCache: new Map(), allEnvRefs: new Map(), piiOpts: {} });
	expect(results.lossyErrorRethrow).toHaveLength(150_001);
	expect(results.lossyErrorRethrow.at(-1)).toBe(last);
	emitted.rows = [];
});
