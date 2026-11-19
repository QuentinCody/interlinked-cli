// ===========================================
// file-checks agent-safety group unit tests
// ===========================================
// Direct tests for the extracted agent-safety helpers. The orchestrator
// `runPerFileChecks` is asserted to delegate to these helpers (same findings,
// same order) via an equivalence check.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCheckRoot } from "../../harness/checks/check-root.js";
import { nonNull } from "../../lib/non-null.js";
import { type FileCheckContext, runPerFileChecks } from "./file-checks.js";
import { runAgentSafetyChecks, runCrapCheck } from "./file-checks-agent-safety.js";
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

describe("runAgentSafetyChecks", () => {
	it("flags a thrown string literal (throw_literal)", () => {
		const c = ctx('throw "boom";\n');
		runAgentSafetyChecks(c);
		expect(c.r.throwLiteral.length).toBeGreaterThan(0);
		expect(nonNull(c.r.throwLiteral[0]).check).toBe("throw_literal");
	});

	it("flags eval usage (eval_usage)", () => {
		const c = ctx('const out = eval(userInput);\n');
		runAgentSafetyChecks(c);
		expect(c.r.evalUsage.length).toBeGreaterThan(0);
		expect(nonNull(c.r.evalUsage[0]).check).toBe("eval_usage");
	});

	it("flags a silently-swallowed promise rejection (silent_promise_catch)", () => {
		const c = ctx('fetch("/api").catch(() => {});\n');
		runAgentSafetyChecks(c);
		expect(c.r.silentPromiseSwallow.length).toBeGreaterThan(0);
		expect(nonNull(c.r.silentPromiseSwallow[0]).check).toBe("silent_promise_catch");
	});

	it("produces the same throw_literal findings as the orchestrator (delegation)", () => {
		const src = 'throw "boom";\n';
		const c = ctx(src);
		runAgentSafetyChecks(c);
		expect(orchestrate(src).throwLiteral).toEqual(c.r.throwLiteral.map(issue => ({ ...issue,
			sourceHash: createHash("sha256").update(src).digest("hex"),
		})));
	});

	it("is a no-op on benign content", () => {
		const c = ctx('export const value = 1;\n');
		runAgentSafetyChecks(c);
		expect(c.r.throwLiteral).toHaveLength(0);
		expect(c.r.evalUsage).toHaveLength(0);
		expect(c.r.silentPromiseSwallow).toHaveLength(0);
	});
});

describe("runCrapCheck", () => {
	it("is fail-open (no findings) when no coverage-final.json is present", () => {
		// cwd points at a dir with no coverage/coverage-final.json — the check
		// must emit nothing rather than throw.
		const c = ctx('function f() { return 1; }\n');
		expect(() => runCrapCheck(c)).not.toThrow();
		expect(c.r.crap).toHaveLength(0);
	});
});

// readme_script_drift wiring — a real tmp repo with a package.json so the
// production `resolveNearestPackageScripts` resolver runs end-to-end.
describe("runAgentSafetyChecks — readme_script_drift fixture repo", () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** Tmp repo whose package.json declares exactly one script: `build`. */
	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "readme-drift-repo-"));
		tmpDirs.push(dir);
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "fixture", scripts: { build: "tsup" } }),
			"utf-8",
		);
		return dir;
	}

	function runOnReadme(repo: string, markdown: string): CodeQualityResults {
		const file = join(repo, "README.md");
		writeFileSync(file, markdown, "utf-8");
		const c: FileCheckContext = {
			file,
			content: markdown,
			relPath: "README.md",
			cwd: repo,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		return c.r;
	}

	it("fires on a README referencing an npm script missing from package.json", () => {
		const r = runOnReadme(makeRepo(), "Ship with `npm run deploy`.\n");
		expect(r.readmeScriptDrift.length).toBe(1);
		expect(nonNull(r.readmeScriptDrift[0]).check).toBe("readme_script_drift");
		expect(nonNull(r.readmeScriptDrift[0]).message).toContain('"deploy"');
	});

	it("does not fire when the referenced script exists", () => {
		const r = runOnReadme(makeRepo(), "Build with `npm run build`.\n");
		expect(r.readmeScriptDrift).toHaveLength(0);
	});

	it("does not fire on non-markdown files (detector self-filters)", () => {
		const repo = makeRepo();
		const c: FileCheckContext = {
			file: join(repo, "notes.ts"),
			content: '// Run `npm run deploy` first\n',
			relPath: "notes.ts",
			cwd: repo,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.readmeScriptDrift).toHaveLength(0);
	});
});

// spec_path_ref wiring (round-2 #25) — proves the 3-arg detector fires through
// the production battery with the real existsSync-backed resolver, not only in
// its direct unit tests.
describe("runAgentSafetyChecks — spec_path_ref fixture repo", () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function runOnDoc(markdown: string, seedExistingPath?: string): CodeQualityResults {
		const dir = mkdtempSync(join(tmpdir(), "spec-pathref-repo-"));
		tmpDirs.push(dir);
		if (seedExistingPath) writeFileSync(join(dir, seedExistingPath), "seed", "utf-8");
		const file = join(dir, "PLAN.md");
		writeFileSync(file, markdown, "utf-8");
		const c: FileCheckContext = {
			file,
			content: markdown,
			relPath: "PLAN.md",
			cwd: dir,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		return c.r;
	}

	it("fires on a present-tense claim that a missing path exists in-repo", () => {
		const r = runOnDoc("# Plan\nThe full `invariants.toml` exists in-repo today.\n");
		expect(r.specPathRef.length).toBe(1);
		expect(nonNull(r.specPathRef[0]).check).toBe("spec_path_ref");
		expect(nonNull(r.specPathRef[0]).message).toContain("invariants.toml");
	});

	it("stays quiet when the claimed path actually exists (resolver end-to-end)", () => {
		const r = runOnDoc(
			"# Plan\nThe full `invariants.toml` exists in-repo today.\n",
			"invariants.toml",
		);
		expect(r.specPathRef).toHaveLength(0);
	});
});

// ===========================================
// Mutation-kill coverage for the low-signal survivors: every `toIssues(<id>, …)`
// call in `runAgentSafetyChecks` mutates the check-id StringLiteral to `""`
// under Stryker. Each block below drives ONE detector to a real MUST-FIRE
// finding and asserts the exact `.check` id — a `""` mutant fails the
// assertion because the id no longer matches. Positive/negative pairs are
// added where cheap; the id-string mutation only needs the positive half to
// die, so single-direction blocks are intentional, not an oversight.
// ===========================================

describe("runAgentSafetyChecks — check-id mutation coverage (positive, exact ids)", () => {
	it("misused_promises — .forEach(async …)", () => {
		const c = ctx('arr.forEach(async (x) => { doStuff(x); });\n');
		runAgentSafetyChecks(c);
		expect(c.r.misusedPromises).toHaveLength(1);
		expect(nonNull(c.r.misusedPromises[0]).check).toBe("misused_promises");
	});

	it("floating_promises — bare call to an in-file async function", () => {
		const c = ctx("async function loadData() {\n  return 1;\n}\nloadData();\n");
		runAgentSafetyChecks(c);
		expect(c.r.floatingPromises).toHaveLength(1);
		expect(nonNull(c.r.floatingPromises[0]).check).toBe("floating_promises");
	});

	it("async_promise_executor — new Promise(async …)", () => {
		const c = ctx("new Promise(async (resolve, reject) => {});\n");
		runAgentSafetyChecks(c);
		expect(c.r.asyncPromiseExecutor).toHaveLength(1);
		expect(nonNull(c.r.asyncPromiseExecutor[0]).check).toBe("async_promise_executor");
	});

	it("broad_object_types — Record<string, any>", () => {
		const c = ctx("type X = Record<string, any>;\n");
		runAgentSafetyChecks(c);
		expect(c.r.broadObjectTypes).toHaveLength(1);
		expect(nonNull(c.r.broadObjectTypes[0]).check).toBe("broad_object_types");
	});

	it("boolean_trap — 2+ boolean literal call args", () => {
		const c = ctx('createUser("alice", true, false);\n');
		runAgentSafetyChecks(c);
		expect(c.r.booleanTrap).toHaveLength(1);
		expect(nonNull(c.r.booleanTrap[0]).check).toBe("boolean_trap");
	});

	it("positional_optional_boolean — signature-side positional optional bool", () => {
		const c = ctx("function setUser(name, force?: boolean) {}\n");
		runAgentSafetyChecks(c);
		expect(c.r.positionalOptionalBoolean).toHaveLength(1);
		expect(nonNull(c.r.positionalOptionalBoolean[0]).check).toBe("positional_optional_boolean");
	});

	it("many_optional_params — 3+ optional params", () => {
		const c = ctx("function config(a?: string, b?: number, c?: boolean) {}\n");
		runAgentSafetyChecks(c);
		expect(c.r.manyOptionalParams).toHaveLength(1);
		expect(nonNull(c.r.manyOptionalParams[0]).check).toBe("many_optional_params");
	});

	it("same_typed_primitive_params — two adjacent same-typed non-allowlisted params", () => {
		const c = ctx("export function schedule(delayMs: number, timeoutMs: number) {}\n");
		runAgentSafetyChecks(c);
		expect(c.r.sameTypedPrimitiveParams).toHaveLength(1);
		expect(nonNull(c.r.sameTypedPrimitiveParams[0]).check).toBe("same_typed_primitive_params");
	});

	it("comment_claims_limit_no_guard — 'at most N' claim with no guard mentioning N", () => {
		const c = ctx(
			"// Accepts at most 5 items in the batch.\nfunction addItems(items) {\n  items.forEach(function(x) { list.push(x); });\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.commentClaimsLimitNoGuard).toHaveLength(1);
		expect(nonNull(c.r.commentClaimsLimitNoGuard[0]).check).toBe("comment_claims_limit_no_guard");
	});

	it("comment_claims_null_throws_instead — 'returns null on' claim + unguarded throw", () => {
		const c = ctx(
			'// returns null on failure to parse the input.\nfunction parseValue(x) {\n  throw new Error("bad input");\n}\n',
		);
		runAgentSafetyChecks(c);
		expect(c.r.commentClaimsNullThrowsInstead).toHaveLength(1);
		expect(nonNull(c.r.commentClaimsNullThrowsInstead[0]).check).toBe(
			"comment_claims_null_throws_instead",
		);
	});

	it("comment_claims_validation_missing — 'validates' claim with no validation evidence", () => {
		const c = ctx("// validates the user input before use.\nfunction checkInput(x) {\n  return x;\n}\n");
		runAgentSafetyChecks(c);
		expect(c.r.commentClaimsValidationMissing).toHaveLength(1);
		expect(nonNull(c.r.commentClaimsValidationMissing[0]).check).toBe(
			"comment_claims_validation_missing",
		);
	});

	it("comment_claims_idempotent_mutates — 'idempotent' claim + unconditional mutation", () => {
		const c = ctx(
			"// idempotent - safe to call multiple times.\nfunction bump(counter) {\n  counter.value++;\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.commentClaimsIdempotentMutates).toHaveLength(1);
		expect(nonNull(c.r.commentClaimsIdempotentMutates[0]).check).toBe(
			"comment_claims_idempotent_mutates",
		);
	});

	it("comment_claims_throws_doesnt — @throws tag never thrown in body", () => {
		const c = ctx(
			"/**\n * @throws {ValidationError} when x is invalid\n */\nfunction validate(x) {\n  return x;\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.commentClaimsThrowsDoesnt).toHaveLength(1);
		expect(nonNull(c.r.commentClaimsThrowsDoesnt[0]).check).toBe("comment_claims_throws_doesnt");
	});

	it("iterator_invalidation — mutating the collection inside its own for-of", () => {
		const c = ctx("for (const x of items) {\n  items.push(x);\n}\n");
		runAgentSafetyChecks(c);
		expect(c.r.iteratorInvalidation).toHaveLength(1);
		expect(nonNull(c.r.iteratorInvalidation[0]).check).toBe("iterator_invalidation");
	});

	it("fresh_collection_key_lookup — Map.set({}) fresh-identity key", () => {
		const c = ctx("const m = new Map();\nm.set({}, 1);\n");
		runAgentSafetyChecks(c);
		expect(c.r.freshCollectionKeyLookup).toHaveLength(1);
		expect(nonNull(c.r.freshCollectionKeyLookup[0]).check).toBe("fresh_collection_key_lookup");
	});

	it("discriminated_union_exhaustiveness — string-literal union switch missing a case", () => {
		const c = ctx(
			"function handle(status: 'a' | 'b' | 'c') {\n  switch (status) {\n    case 'a': return 1;\n    case 'b': return 2;\n    default: return 0;\n  }\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.discriminatedUnionExhaustiveness).toHaveLength(1);
		expect(nonNull(c.r.discriminatedUnionExhaustiveness[0]).check).toBe(
			"discriminated_union_exhaustiveness",
		);
	});

	it("index_bounds_unchecked — external input coerced straight into an array subscript", () => {
		const c = ctx("const rows = [];\nconst out = rows[Number(req.query.idx)];\n");
		runAgentSafetyChecks(c);
		expect(c.r.indexBoundsUnchecked).toHaveLength(1);
		expect(nonNull(c.r.indexBoundsUnchecked[0]).check).toBe("index_bounds_unchecked");
	});

	it("cleanup_skipped_on_early_exit — throw before clearInterval", () => {
		const c = ctx(
			"function bug() {\n  const id = setInterval(() => tick(), 1000);\n  if (cond) throw new Error('bad');\n  clearInterval(id);\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.cleanupSkippedOnEarlyExit).toHaveLength(1);
		expect(nonNull(c.r.cleanupSkippedOnEarlyExit[0]).check).toBe("cleanup_skipped_on_early_exit");
	});

	it("tainted_to_privileged_sink — eval(req.body.code)", () => {
		const c = ctx("function handler(req) {\n  return eval(req.body.code);\n}\n");
		runAgentSafetyChecks(c);
		expect(c.r.taintedToPrivilegedSink).toHaveLength(1);
		expect(nonNull(c.r.taintedToPrivilegedSink[0]).check).toBe("tainted_to_privileged_sink");
	});

	it("await_state_toctou — re-derefs state.entry after an await with no re-check", () => {
		const c = ctx(
			"async function bug(state) {\n  if (state.entry) {\n    await sync();\n    state.entry.touch();\n  }\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.awaitStateToctou).toHaveLength(1);
		expect(nonNull(c.r.awaitStateToctou[0]).check).toBe("await_state_toctou");
	});

	it("cleanup_reentrancy — dispose() calling this.dispose()", () => {
		const c = ctx("class Bug {\n  dispose() {\n    this.dispose();\n  }\n}\n");
		runAgentSafetyChecks(c);
		expect(c.r.cleanupReentrancy).toHaveLength(1);
		expect(nonNull(c.r.cleanupReentrancy[0]).check).toBe("cleanup_reentrancy");
	});

	it("boundary_copy_no_revalidation — Object.assign(slot, req.body) with no validator", () => {
		const c = ctx("function bug(slot, req) {\n  Object.assign(slot, req.body);\n}\n");
		runAgentSafetyChecks(c);
		expect(c.r.boundaryCopyNoRevalidation).toHaveLength(1);
		expect(nonNull(c.r.boundaryCopyNoRevalidation[0]).check).toBe("boundary_copy_no_revalidation");
	});

	it("magic_literal_in_conditional — opaque numeric comparison", () => {
		const c = ctx("if (status === 42) { doStuff(); }\n");
		runAgentSafetyChecks(c);
		expect(c.r.magicLiteralInConditional).toHaveLength(1);
		expect(nonNull(c.r.magicLiteralInConditional[0]).check).toBe("magic_literal_in_conditional");
	});

	it("nan_coercion_guard — Date.parse() <= now with no isFinite/isNaN guard", () => {
		const c = ctx(
			"function isExpired(rec) {\n  const now = Date.now();\n  if (Date.parse(rec.expires_at) <= now) return true;\n  return false;\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.nanCoercionGuard).toHaveLength(1);
		expect(nonNull(c.r.nanCoercionGuard[0]).check).toBe("nan_coercion_guard");
	});

	it("unawaited_async_assertion — expect(p).rejects chain with no await, in a test file", () => {
		const c = ctx(
			'it("rejects on bad input", async () => {\n  expect(doWork("bad")).rejects.toThrow("nope");\n});\n',
			"/tmp/sample.test.ts",
		);
		runAgentSafetyChecks(c);
		expect(c.r.unawaitedAsyncAssertion).toHaveLength(1);
		expect(nonNull(c.r.unawaitedAsyncAssertion[0]).check).toBe("unawaited_async_assertion");
	});

	it("design_slop — Inter font-family on a design surface", () => {
		const c: FileCheckContext = {
			file: "/tmp/a.css",
			content: "h1 { font-family: Inter; }\n",
			relPath: "a.css",
			cwd: "/tmp",
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.designSlop.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(c.r.designSlop[0]).check).toBe("design_slop");
	});

	it("array_push_return_used — return items.push(item)", () => {
		const c = ctx("function add(item) { return items.push(item); }\n");
		runAgentSafetyChecks(c);
		expect(c.r.arrayPushReturnUsed).toHaveLength(1);
		expect(nonNull(c.r.arrayPushReturnUsed[0]).check).toBe("array_push_return_used");
	});

	it("array_iteratee_variadic_builtin — .map(parseInt)", () => {
		const c = ctx("const nums = ['1','2','3'].map(parseInt);\n");
		runAgentSafetyChecks(c);
		expect(c.r.arrayIterateeVariadicBuiltin).toHaveLength(1);
		expect(nonNull(c.r.arrayIterateeVariadicBuiltin[0]).check).toBe(
			"array_iteratee_variadic_builtin",
		);
	});

	it("write_without_mkdir — writeFileSync(join(...)) with no prior mkdirSync", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd) {",
			"  writeFileSync(join(cwd, '.interlinked', 'metric-caps.json'), data);",
			"}",
		].join("\n");
		const c = ctx(code);
		runAgentSafetyChecks(c);
		expect(c.r.writeWithoutMkdir).toHaveLength(1);
		expect(nonNull(c.r.writeWithoutMkdir[0]).check).toBe("write_without_mkdir");
	});

	it("homedir_write_escape — appendFileSync(join(homedir(), ...)) reaches verify results", () => {
		const code = [
			"import { appendFileSync, mkdirSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"function log(row) {",
			"  mkdirSync(join(homedir(), '.tool'), { recursive: true });",
			"  appendFileSync(join(homedir(), '.tool', 'log.jsonl'), row);",
			"}",
		].join("\n");
		const c = ctx(code);
		runAgentSafetyChecks(c);
		expect(c.r.homedirWriteEscape.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(c.r.homedirWriteEscape[0]).check).toBe("homedir_write_escape");
	});

	it("duplicated_policy_constant — bare literal duplicating a same-file DEFAULT_* constant", () => {
		const c = ctx(
			"const MAX_RETRIES = 7;\n\nfunction runWithRetry(fn) {\n  let attempts = 0;\n  while (attempts < 7) {\n    fn();\n    attempts++;\n  }\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.duplicatedPolicyConstant.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(c.r.duplicatedPolicyConstant[0]).check).toBe("duplicated_policy_constant");
	});

	it("snapshot_hygiene — *.snap.new review artifact under __snapshots__/", () => {
		const c: FileCheckContext = {
			file: "/tmp/__snapshots__/Button.test.tsx.snap.new",
			content: "// snapshot bytes\n[]",
			relPath: "__snapshots__/Button.test.tsx.snap.new",
			cwd: "/tmp",
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.snapshotHygiene).toHaveLength(1);
		expect(nonNull(c.r.snapshotHygiene[0]).check).toBe("snapshot_hygiene");
	});

	it("payload_field_casing — snake_case payload field read with no camelCase fallback", () => {
		const c = ctx("const tp = rawInput.transcript_path;\n");
		runAgentSafetyChecks(c);
		expect(c.r.payloadFieldCasing).toHaveLength(1);
		expect(nonNull(c.r.payloadFieldCasing[0]).check).toBe("payload_field_casing");
	});

	it("placeholder_runtime_constant — comment confesses a temporary stand-in value", () => {
		const c = ctx("const MAX_RETRIES = 3; // hardcoded for now\n");
		runAgentSafetyChecks(c);
		expect(c.r.placeholderRuntimeConstant).toHaveLength(1);
		expect(nonNull(c.r.placeholderRuntimeConstant[0]).check).toBe("placeholder_runtime_constant");
	});

	it("rust_unsafe_span — unsafe block spanning 6 nonblank lines", () => {
		const c = ctx(
			"fn init(p: *mut u8) {\n    unsafe {\n        let a = p.add(1);\n        let b = p.add(2);\n        let c = p.add(3);\n        let d = p.add(4);\n        let e = p.add(5);\n        let f = p.add(6);\n    }\n}\n",
			"/tmp/s.rs",
		);
		runAgentSafetyChecks(c);
		expect(c.r.rustUnsafeSpan).toHaveLength(1);
		expect(nonNull(c.r.rustUnsafeSpan[0]).check).toBe("rust_unsafe_span");
	});

	it("suppression_block_span — eslint-disable/enable spanning 15 lines", () => {
		const src =
			["/* eslint-disable */", ...Array.from({ length: 13 }, () => "a();"), "/* eslint-enable */"].join(
				"\n",
			) + "\n";
		const c = ctx(src);
		runAgentSafetyChecks(c);
		expect(c.r.suppressionBlockSpan).toHaveLength(1);
		expect(nonNull(c.r.suppressionBlockSpan[0]).check).toBe("suppression_block_span");
	});

	it("non_null_assertion — identifier! before a member/index access", () => {
		const c = ctx("const x = foo!.bar;\n");
		runAgentSafetyChecks(c);
		expect(c.r.nonNullAssertions).toHaveLength(1);
		expect(nonNull(c.r.nonNullAssertions[0]).check).toBe("non_null_assertion");
	});

	it("inner_html — direct .innerHTML assignment", () => {
		const c = ctx('el.innerHTML = "<b>hi</b>";\n');
		runAgentSafetyChecks(c);
		expect(c.r.innerHtml).toHaveLength(1);
		expect(nonNull(c.r.innerHtml[0]).check).toBe("inner_html");
	});

	it("nan_comparison — x === NaN", () => {
		const c = ctx("if (x === NaN) {}\n");
		runAgentSafetyChecks(c);
		expect(c.r.nanComparison).toHaveLength(1);
		expect(nonNull(c.r.nanComparison[0]).check).toBe("nan_comparison");
	});

	it("constant_condition — if (true)", () => {
		const c = ctx("if (true) { doStuff(); }\n");
		runAgentSafetyChecks(c);
		expect(c.r.constantCondition).toHaveLength(1);
		expect(nonNull(c.r.constantCondition[0]).check).toBe("constant_condition");
	});

	it("unsafe_optional_chaining — (obj?.foo).bar", () => {
		const c = ctx("const y = (obj?.foo).bar;\n");
		runAgentSafetyChecks(c);
		expect(c.r.unsafeOptionalChaining).toHaveLength(1);
		expect(nonNull(c.r.unsafeOptionalChaining[0]).check).toBe("unsafe_optional_chaining");
	});

	it("number_precision_loss — integer literal above MAX_SAFE_INTEGER", () => {
		const c = ctx("const big = 90071992547409910;\n");
		runAgentSafetyChecks(c);
		expect(c.r.numberPrecisionLoss).toHaveLength(1);
		expect(nonNull(c.r.numberPrecisionLoss[0]).check).toBe("number_precision_loss");
	});

	it("promise_reject_non_error — Promise.reject(<string literal>)", () => {
		// interlinked-ignore: promise_reject_non_error — fixture for the detector that flags exactly this pattern
		const c = ctx('Promise.reject("bad");\n');
		runAgentSafetyChecks(c);
		expect(c.r.promiseRejectNonError).toHaveLength(1);
		expect(nonNull(c.r.promiseRejectNonError[0]).check).toBe("promise_reject_non_error");
	});

	it("raw_control_bytes — a raw NUL byte inside a template literal", () => {
		const nul = String.fromCharCode(0);
		const c = ctx(`const key = \`\${file}${nul}\${anchor}\`;\n`);
		runAgentSafetyChecks(c);
		expect(c.r.rawControlBytes).toHaveLength(1);
		expect(nonNull(c.r.rawControlBytes[0]).check).toBe("raw_control_bytes");
	});

	it("lossy_error_rethrow — throw new Error(...) in catch(e) without { cause: e }", () => {
		const c = ctx('function f() {\n  try {\n    risky();\n  } catch (e) {\n    throw new Error("boom");\n  }\n}\n');
		runAgentSafetyChecks(c);
		expect(c.r.lossyErrorRethrow).toHaveLength(1);
		expect(nonNull(c.r.lossyErrorRethrow[0]).check).toBe("lossy_error_rethrow");
	});

	it("import_from_own_barrel — a resolved index re-exports its importing module", () => {
		const root = mkdtempSync(join(process.cwd(), "scratch", "verify-own-barrel-"));
		try {
			const content = 'import { bar } from "./index.js";\nexport const foo = bar;\n';
			writeFileSync(join(root, "foo.ts"), content);
			writeFileSync(join(root, "index.ts"), 'export * from "./foo.js";\nexport const bar = 1;\n');
			const c: FileCheckContext = {
				file: join(root, "foo.ts"), content, relPath: "foo.ts", cwd: root,
				r: emptyResults(), piiOpts: {},
			};
			withCheckRoot(root, () => runAgentSafetyChecks(c));
			expect(c.r.importFromOwnBarrel).toHaveLength(1);
			expect(nonNull(c.r.importFromOwnBarrel[0]).check).toBe("import_from_own_barrel");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("error_dispatch_by_instanceof — instanceof TypeError inside a catch block", () => {
		const c = ctx(
			"function f() {\n  try {\n    risky();\n  } catch (e) {\n    if (e instanceof TypeError) {\n      handle();\n    }\n  }\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.errorDispatchByInstanceof).toHaveLength(1);
		expect(nonNull(c.r.errorDispatchByInstanceof[0]).check).toBe("error_dispatch_by_instanceof");
	});

	it("require_await — async function with a long body and no await", () => {
		const c = ctx(
			"async function longWorker() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = a + b + c + d + e;\n  console.log(f);\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.requireAwait).toHaveLength(1);
		expect(nonNull(c.r.requireAwait[0]).check).toBe("require_await");
	});

	it("accumulating_spread — .reduce with an accumulator spread", () => {
		const c = ctx("arr.reduce((acc, x) => ({...acc, [x]: 1}), {});\n");
		runAgentSafetyChecks(c);
		expect(c.r.accumulatingSpread).toHaveLength(1);
		expect(nonNull(c.r.accumulatingSpread[0]).check).toBe("accumulating_spread");
	});

	it("manual_field_copy — 5 consecutive target.k = source.k field copies", () => {
		const c = ctx(
			[
				"target.a = source.a;",
				"target.b = source.b;",
				"target.c = source.c;",
				"target.d = source.d;",
				"target.e = source.e;",
			].join("\n") + "\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.manualFieldCopy).toHaveLength(1);
		expect(nonNull(c.r.manualFieldCopy[0]).check).toBe("manual_field_copy");
	});

	it("halstead_difficulty — flat but operator-dense function (no branching)", () => {
		const denseFlat = [
			"export function serialize(a, b) {",
			"\tconst r1 = a + b - a * b / a % b ** a & b | a ^ b;",
			"\tconst r2 = (a << b) >>> (b >> a) | (~a & ~b) ^ (a || b) ?? (a && b);",
			"\tconst r3 = a > b ? a < b : a >= b ? a <= b : a === b ? a !== b : !a;",
			"\tconst r4 = a + b + a - b - a * b * a / b / a % b % a ** b ** a;",
			"\tconst r5 = (a & b) | (a ^ b) | (a << b) | (a >> b) | (a >>> b);",
			"\tconst r6 = a + a + a + b + b + b - a - a - b - b + a * a * b * b;",
			"\tconst r7 = a | b | a | b | a & b & a & b ^ a ^ b ^ a ^ b;",
			"\tconst r8 = a + b * a - b / a % b + a ** b - (a & b) + (a | b);",
			"\treturn r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8 + a + b;",
			"}",
			"",
		].join("\n");
		const c = ctx(denseFlat);
		runAgentSafetyChecks(c);
		expect(c.r.halsteadDifficulty).toHaveLength(1);
		expect(nonNull(c.r.halsteadDifficulty[0]).check).toBe("halstead_difficulty");
	});

	it("default_export — anonymous default export object literal", () => {
		const c = ctx("export default {};\n");
		runAgentSafetyChecks(c);
		expect(c.r.defaultExport).toHaveLength(1);
		expect(nonNull(c.r.defaultExport[0]).check).toBe("default_export");
	});

	it("lifecycle_cleanup — setInterval acquired with no clearInterval anywhere in a lifecycle method", () => {
		const c = ctx(
			"class Poller {\n  start() {\n    this.id = setInterval(() => this.tick(), 1000);\n  }\n  stop() {\n    this.running = false;\n  }\n}\n",
		);
		runAgentSafetyChecks(c);
		expect(c.r.lifecycleCleanup).toHaveLength(1);
		expect(nonNull(c.r.lifecycleCleanup[0]).check).toBe("lifecycle_cleanup");
	});

	it("code_clones — two near-identical functions in the same file", () => {
		const cloneBody =
			"{\n\tconst out = [];\n\tfor (const row of rows) {\n\t\tif (row.enabled) {\n\t\t\tout.push(row.value);\n\t\t}\n\t}\n\treturn out;\n}";
		const content = `\nfunction collectA(rows) ${cloneBody}\nfunction collectB(rows) ${cloneBody}\n`;
		const c = ctx(content);
		runAgentSafetyChecks(c);
		expect(c.r.codeClones.length).toBeGreaterThanOrEqual(1);
		expect(nonNull(c.r.codeClones[0]).check).toBe("code_clones");
	});
});

// untested_inverse_pair / untested_idempotent — same FAKE-basename strategy as
// property-testing.integration.test.ts: a basename that appears in NO real
// test-file path under process.cwd() so the git-listing prefilter finds zero
// candidate suites, reading as "untested" and firing.
describe("runAgentSafetyChecks — untested_inverse_pair / untested_idempotent (real cwd git listing)", () => {
	const cwd = process.cwd();

	it("untested_inverse_pair — bare encode/decode pair with no round-trip test", () => {
		const c: FileCheckContext = {
			file: "zzqp_inverse_fixture_module.ts",
			content: "export function encode(x) { return x; }\nexport function decode(x) { return x; }\n",
			relPath: "zzqp_inverse_fixture_module.ts",
			cwd,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.untestedInversePair).toHaveLength(1);
		expect(nonNull(c.r.untestedInversePair[0]).check).toBe("untested_inverse_pair");
	});

	it("untested_idempotent — idempotent-shaped export with no property test", () => {
		const c: FileCheckContext = {
			file: "zzqp_idempotent_fixture_module.ts",
			content: "export function normalize(x) { return x.trim(); }\n",
			relPath: "zzqp_idempotent_fixture_module.ts",
			cwd,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.untestedIdempotent).toHaveLength(1);
		expect(nonNull(c.r.untestedIdempotent[0]).check).toBe("untested_idempotent");
	});
});

// export_ripple / dead_exports — both wrap real `git ls-files` + real fs reads
// (getGitSourceFiles), so they need an actual tmp git repo, not a bare cwd.
describe("runAgentSafetyChecks — export_ripple / dead_exports (real tmp git repo)", () => {
	const tmpDirs: string[] = [];
	afterEach(() => {
		for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function makeRepo(): string {
		const dir = mkdtempSync(join(tmpdir(), "agent-safety-repo-"));
		tmpDirs.push(dir);
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
		return dir;
	}

	it("export_ripple — an importer names an export that no longer exists", () => {
		const repo = makeRepo();
		mkdirSync(join(repo, "src"), { recursive: true });
		const targetSrc = "export const stillHere = 1;\n";
		writeFileSync(join(repo, "src", "target.ts"), targetSrc);
		writeFileSync(
			join(repo, "src", "importer.ts"),
			'import { stillHere, gone } from "./target.js";\nconst __ref = "target";\nvoid __ref;\n',
		);
		execFileSync("git", ["add", "-A"], { cwd: repo });

		const c: FileCheckContext = {
			file: join(repo, "src", "target.ts"),
			content: targetSrc,
			relPath: "src/target.ts",
			cwd: repo,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.exportRipple).toHaveLength(1);
		expect(nonNull(c.r.exportRipple[0]).check).toBe("export_ripple");
	});

	it("dead_exports — an export nothing imports, resolver proven working via a used sibling", () => {
		const repo = makeRepo();
		mkdirSync(join(repo, "src"), { recursive: true });
		const libSrc = "export const used = 1;\nexport const zzqpDead = 2;\n";
		writeFileSync(join(repo, "src", "lib.ts"), libSrc);
		writeFileSync(
			join(repo, "src", "main.ts"),
			'import { used } from "./lib.js";\nconsole.log(used);\n',
		);
		execFileSync("git", ["add", "-A"], { cwd: repo });

		const c: FileCheckContext = {
			file: join(repo, "src", "lib.ts"),
			content: libSrc,
			relPath: "src/lib.ts",
			cwd: repo,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.deadExports).toHaveLength(1);
		expect(nonNull(c.r.deadExports[0]).check).toBe("dead_exports");
		expect(nonNull(c.r.deadExports[0]).message).toContain("zzqpDead");
	});
});

// circular_imports — a self-contained DFS walk over real files on disk; no git
// repo required (plain fs reads), mirroring the existing coverage-integration
// fixture for this detector.
describe("runAgentSafetyChecks — circular_imports (real files on disk)", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("flags a two-file import cycle (a → b → a)", () => {
		dir = mkdtempSync(join(tmpdir(), "agent-safety-cyc-"));
		const aPath = join(dir, "a.ts");
		const aContent = 'import { b } from "./b.js";\nexport const a = () => b();\n';
		writeFileSync(aPath, aContent);
		writeFileSync(join(dir, "b.ts"), 'import { a } from "./a.js";\nexport const b = () => a();\n');

		const c: FileCheckContext = {
			file: aPath,
			content: aContent,
			relPath: "a.ts",
			cwd: dir,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.circularImports).toHaveLength(1);
		expect(nonNull(c.r.circularImports[0]).check).toBe("circular_imports");
	});
});

// gitignored_written_config — exercises `makeGitIgnoreResolver` end to end: the
// resolver must resolve a RELATIVE written-path argument against the
// CONTAINING FILE's directory, not the file itself. A subdirectory fixture
// pins this: `fileDir = resolve(containingFileAbs, "..")` (StringLiteral
// mutant `""` collapses this to the file path itself, breaking resolution),
// and the resolver arrow's body (BlockStatement mutant `{}` returns
// `undefined` unconditionally, i.e. "never ignored").
describe("runAgentSafetyChecks — gitignored_written_config (makeGitIgnoreResolver, real git repo)", () => {
	let repo: string;
	afterEach(() => {
		if (repo) rmSync(repo, { recursive: true, force: true });
	});

	it("flags a relative write whose path resolves (via the file's directory) to a gitignored target", () => {
		repo = mkdtempSync(join(tmpdir(), "agent-safety-gitignore-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		mkdirSync(join(repo, "sub"), { recursive: true });
		writeFileSync(join(repo, ".gitignore"), "sub/policy.json\n");
		const writerFile = join(repo, "sub", "writer.ts");
		const content = 'writeFileSync("policy.json", data);\n';
		writeFileSync(writerFile, content);

		const c: FileCheckContext = {
			file: writerFile,
			content,
			relPath: "sub/writer.ts",
			cwd: repo,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.gitignoredWrittenConfig).toHaveLength(1);
		expect(nonNull(c.r.gitignoredWrittenConfig[0]).check).toBe("gitignored_written_config");
	});

	it("does NOT flag the same write when the target is not gitignored", () => {
		repo = mkdtempSync(join(tmpdir(), "agent-safety-gitignore-neg-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		mkdirSync(join(repo, "sub"), { recursive: true });
		// No .gitignore at all this time.
		const writerFile = join(repo, "sub", "writer.ts");
		const content = 'writeFileSync("policy.json", data);\n';
		writeFileSync(writerFile, content);

		const c: FileCheckContext = {
			file: writerFile,
			content,
			relPath: "sub/writer.ts",
			cwd: repo,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.gitignoredWrittenConfig).toHaveLength(0);
	});
});

// property_test_candidate — real tmp files on disk (the detector reads the
// module's companion test file via the filesystem, mirroring
// property-candidate.test.ts's own fixture).
describe("runAgentSafetyChecks — property_test_candidate (real companion test file)", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("fires on a pure branchy exported function whose companion test uses no properties", () => {
		dir = mkdtempSync(join(tmpdir(), "agent-safety-propcand-"));
		const algorithmic = [
			"export function classify(a: number, b: number): string {",
			'\tif (a < 0) return "neg-a";',
			'\tif (b < 0) return "neg-b";',
			'\tif (a === b) return "equal";',
			'\tif (a > b) return a % 2 === 0 ? "a-even" : "a-odd";',
			'\tif (b > a) return b % 2 === 0 ? "b-even" : "b-odd";',
			"\tfor (let i = 0; i < a; i++) {",
			'\t\tif (i === b) return "crossed";',
			"\t}",
			'\treturn "none";',
			"}",
			"",
		].join("\n");
		const srcFile = join(dir, "m.ts");
		writeFileSync(srcFile, algorithmic, "utf-8");
		writeFileSync(
			join(dir, "m.test.ts"),
			'import { classify } from "./m.js";\nit("works", () => { classify(1, 2); });\n',
			"utf-8",
		);
		const c: FileCheckContext = {
			file: srcFile,
			content: algorithmic,
			relPath: "m.ts",
			cwd: dir,
			r: emptyResults(),
			piiOpts: {},
		};
		runAgentSafetyChecks(c);
		expect(c.r.propertyTestCandidate).toHaveLength(1);
		expect(nonNull(c.r.propertyTestCandidate[0]).check).toBe("property_test_candidate");
	});
});

// runCrapCheck — real coverage-final.json fixture (Istanbul shape, matching the
// pattern in coverage-final-reader.test.ts) with a 6-branch, 0%-covered
// function. CRAP at 0% coverage = cyclomatic^2 + cyclomatic = 42 >= the 30
// threshold, so this MUST produce a finding — which pins the "coverage" and
// "coverage-final.json" path-segment literals (an empty-string mutant on
// either resolves to a path with no file there, so `loadCoverageFinal` returns
// null and the check fails open) and the `perFile === undefined` guard (a
// `true` mutant would always early-return, producing no finding here either).
describe("runCrapCheck — real coverage-final.json fixture (kills the path + guard mutants)", () => {
	let tmp: string;
	afterEach(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it("reports a CRAP finding for a high-complexity, zero-coverage function", () => {
		tmp = mkdtempSync(join(tmpdir(), "agent-safety-crap-"));
		mkdirSync(join(tmp, "coverage"), { recursive: true });
		const absPath = join(tmp, "src", "foo.ts");
		const fixture = {
			[absPath]: {
				path: absPath,
				fnMap: { "0": { name: "risky", decl: { start: { line: 1 }, end: { line: 8 } } } },
				f: { "0": 0 },
				statementMap: {
					"0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
					"1": { start: { line: 8, column: 0 }, end: { line: 8, column: 10 } },
				},
				s: { "0": 0, "1": 0 },
			},
		};
		writeFileSync(join(tmp, "coverage", "coverage-final.json"), JSON.stringify(fixture), "utf-8");

		const content = [
			"function risky(x) {",
			"  if (x === 1) return 1;",
			"  if (x === 2) return 2;",
			"  if (x === 3) return 3;",
			"  if (x === 4) return 4;",
			"  if (x === 5) return 5;",
			"  return 0;",
			"}",
			"",
		].join("\n");

		const c: FileCheckContext = {
			file: absPath,
			content,
			relPath: "src/foo.ts",
			cwd: tmp,
			r: emptyResults(),
			piiOpts: {},
		};
		runCrapCheck(c);
		expect(c.r.crap).toHaveLength(1);
		expect(nonNull(c.r.crap[0]).check).toBe("crap");
		expect(nonNull(c.r.crap[0]).message).toContain("risky");
		expect(nonNull(c.r.crap[0]).message).toContain("CRAP=42");
	});
});
