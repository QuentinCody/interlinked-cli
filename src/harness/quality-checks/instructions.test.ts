// ===========================================
// instructions.ts — exact-content regression tests
// ===========================================
//
// PROVEN_TOOL_CHECKS and TOOL_CHECK_INSTRUCTIONS are hand-authored constant
// tables, not detectors — there is no MUST-FIRE/MUST-NOT-FIRE fixture pair
// to build (no input to feed a parser or regex). The failure mode this file
// guards against is a StringLiteral silently truncated to "": a fragment of
// a multi-part instruction quietly disappearing, or a check id quietly
// dropping out of the proven-tool membership set. A substring match
// (`.toContain`) cannot catch every such truncation — when a multi-part
// instruction loses one of its OTHER parts, the substring you happened to
// pick can still be present. Exact-value equality is the only assertion
// shape strong enough: any single StringLiteral part turning into ""
// changes the assembled result, so every case below pins the precise
// expected value rather than a fragment of it.
//
// Golden values were extracted from the TypeScript AST of instructions.ts
// (StringLiteral concatenation, decoded via the compiler's own `.text`)
// and cross-validated against the actual running module before being
// embedded here — see scratch/probes/gen-instructions-test-data.mts and
// scratch/probes/instructions-golden.json. Kill-brief:
// scratch/fleet-r2/kill-briefs/src_harness_quality-checks_instructions.ts.json

import { describe, expect, it } from "vitest";
import { PROVEN_TOOL_CHECKS, TOOL_CHECK_INSTRUCTIONS } from "./instructions.js";

/** Every id PROVEN_TOOL_CHECKS should contain, sorted for stable diffing. */
const EXPECTED_PROVEN_MEMBERS = [
	"affected_tests",
	"affected_tests_deferred",
	"binary_content",
	"biome_lint",
	"dependency_audit",
	"empty_file",
	"eslint",
	"tseslint-types",
	"external_check_deferred",
	"export_ripple",
	"gitleaks",
	"lockfile_drift",
	"missing_return_types",
	"no_test_file",
	"package_json_consistency",
	"per-edit-mutation",
	"secrets_in_source",
	"semgrep",
	"typescript",
] as const;

/**
 * Exact assembled instruction text per check id, keyed the same as
 * TOOL_CHECK_INSTRUCTIONS. Cross-validated against the real module at
 * generation time — see the file header.
 */
const EXPECTED_INSTRUCTIONS: Readonly<Record<string, string>> = {
	typescript:
		"Fix the type errors above. Use proper types (interfaces, generics, branded types). Do NOT use `as any`, `@ts-ignore`, or `@ts-expect-error` to suppress — fix the actual types.",
	biome_lint:
		"Fix the lint issues above by changing the code, not by adding suppression comments. Do NOT add `biome-ignore` comments — rewrite the code so it passes the check cleanly.",
	eslint:
		"Fix the lint issues above by changing the code, not by adding suppression comments. Do NOT add `eslint-disable` comments — rewrite the code so it passes the check cleanly.",
	strong_typing:
		"Replace `any` types with proper interfaces, generics, or branded types. Do NOT leave `any` in place — use `unknown` with type guards if the shape is genuinely dynamic. `unknown` is acceptable when paired with narrowing (type guards, instanceof, assertion functions).",
	software_version_regression:
		"PostToolUse attention required: the write already landed, so stop and verify the intended software version before continuing. You have a knowledge cutoff date; do not rely on remembered model/API/package timelines. search/fetch official docs, package registries, model provider docs, Docker tags, or release notes for the latest version. If this downgrade is intentional, keep it only after documenting why; otherwise restore or update to the current intended version.",
	freshness_sensitive_reference:
		"Verify the newly introduced reference against official current sources before relying on it: provider model docs, API versioning docs, package registries, Docker tags, or release notes. Do not claim the reference is deprecated or current from memory alone; cite or inspect the source of truth.",
	secrets_in_source:
		"Remove the detected secrets immediately. Use environment variables or a secrets manager instead. Do NOT commit secrets to source files under any circumstances.",
	semgrep:
		"Fix the security or correctness issue identified by Semgrep. Do NOT add nosemgrep comments to suppress findings — fix the underlying code.",
	dependency_audit:
		"Dependency vulnerabilities were found. Run `npm audit fix` to auto-fix compatible updates, or `npm audit` to review. For critical/high vulnerabilities, update the affected package immediately.",
	gitleaks:
		"Secrets or credentials were detected by gitleaks. Remove them immediately and rotate the exposed credential. Use environment variables or a secrets manager (e.g., Vault, AWS Secrets Manager) instead. If this was committed to git, the credential is already exposed — rotation is mandatory.",
	affected_tests:
		"The test file for this source file is failing. Fix the source code so the tests pass. Do NOT modify the tests to make them pass — fix the implementation.",
	affected_tests_deferred:
		"No test result exists for this check. Re-run the affected test after the active check finishes; do not interpret deferral as either passing or failing.",
	external_check_deferred:
		"No external-check verdict exists. Re-run the check after active work finishes; do not interpret deferral, timeout, or runner failure as a clean result.",
	inline_language_checks:
		"Each finding below lists the line and a fix_instruction from the language profile. Address the specific pattern (bare except, .unwrap() in non-test code, force cast, etc.). Do NOT suppress with comments — change the code.",
	binary_content:
		"This file contains binary data. Do NOT write binary files through text editing tools. Use appropriate binary-safe methods or download the file directly.",
	empty_file:
		"This file is empty. If content was intended, write it now. If the file is intentionally empty, add a comment explaining why.",
	lockfile_drift:
		"The lockfile is out of sync with the manifest. Run the package manager's install/lock command (`npm install`, `yarn install`, `cargo generate-lockfile`, `poetry lock`) to regenerate it. Do NOT commit a stale lockfile — it causes version resolution to diverge between environments.",
	package_json_consistency:
		"Fix the package.json issues: remove duplicates (keep in the correct section — dependencies vs devDependencies), and fix invalid version specifiers to valid semver ranges (e.g., ^1.2.3, ~2.0.0, >=3.0.0).",
	missing_return_types:
		"Add explicit return type annotations to all exported functions. This improves API documentation, enables better type inference for consumers, and catches accidental return type changes.",
	no_test_file:
		"This source file has no corresponding test file. Create a test file with at least basic coverage. Name it {filename}.test.ts or {filename}.spec.ts in the same directory.",
	complexity:
		"This function has high measured complexity. Extract helpers or use early returns to reduce nesting and parameter count.",
	export_ripple:
		"Other files import symbols from this file that no longer exist in its exports. Update the importing files to use the correct symbol names, or restore the removed exports.",
	generic_inline:
		"Fix the code quality issue indicated. Clean up trailing whitespace, resolve TODOs, and remove debug statements before committing.",
	python_bare_except:
		"Catch specific exceptions instead of bare `except:`. Use `except ValueError:` or `except Exception:` at minimum.",
	python_mutable_default:
		"Use `None` as the default and assign the mutable value inside the function body. Example: `def foo(x=None): x = x or []`",
	rust_unsafe:
		"Document safety invariants with a `// SAFETY:` comment above each unsafe block. Minimize the scope of unsafe code.",
	rust_unwrap:
		'Use `.expect("reason")` with a descriptive message, or propagate the error with `?`. Do NOT use `.unwrap()` in non-test code.',
	rust_todo_macro:
		"Replace `todo!()` and `unimplemented!()` with actual implementation or proper error handling. These macros panic at runtime.",
	rust_panic_in_lib:
		"Return `Result<T, E>` with a typed error instead of `panic!()`. If the failure is genuinely unrecoverable (corrupt invariant, exhausted resource), document why with a comment so the next reader knows it's intentional.",
	rust_expect_empty_msg:
		'`.expect("")` is `.unwrap()` with extra steps — the empty message gives no signal at crash time. Provide a descriptive `.expect("reason this cannot be None/Err")`, or propagate the error with `?`.',
	rust_box_dyn_error_in_pub_return:
		"`Box<dyn Error>` in a public return type erases information callers need to handle specific failures. Define a typed error enum with `thiserror`, or use `anyhow::Error` if you want chaining + context but do not need callers to match on variants. Reserve `Box<dyn Error>` for prototypes and `fn main`.",
	rust_dbg_macro:
		"Remove the `dbg!()` call before committing. Use the `tracing` or `log` crate for structured observability; use `eprintln!` for one-off debugging and then clean up afterward.",
	cuda_kernel_launch_unchecked:
		"After every kernel launch `kernel<<<grid, block>>>(...)`, call `cudaGetLastError()` (non-blocking) to surface launch-time failures. For blocking semantics, follow with `cudaDeviceSynchronize()` and check its return code. Otherwise launch errors stay silent until the next CUDA API call, with confusing attribution.",
	cuda_device_synchronize_debug:
		"`cudaDeviceSynchronize()` serializes across all streams and is rarely the right tool. Use `cudaStreamSynchronize(stream)` for per-stream barriers, or `cudaEventSynchronize(event)` for fine-grained waiting. Keep global sync only for shutdown / debugging — and comment why.",
	cuda_printf_in_device_code:
		"In device code (`__device__` / `__global__`), `printf` uses the GPU printf buffer and can serialize warps. Prefer copying values back to host before printing, or guard with `if (threadIdx.x == 0 && blockIdx.x == 0)` so only one thread emits. In host code (`__host__`) this is fine — the regex can't distinguish, so verify the call site is on the host.",
	cuda_syncthreads_in_conditional:
		"`__syncthreads()` is a block-wide barrier: every thread in the block must reach it, or the warp deadlocks. Move the call outside the conditional. If only some threads should act, branch around the work but bring all threads back to the barrier afterward.",
	go_error_ignored:
		"Handle errors explicitly. Do NOT discard errors with `_`. At minimum, log the error or return it to the caller.",
	c_header_guard:
		"Add `#pragma once` at the top of the header file, or use a traditional `#ifndef`/`#define` include guard.",
	java_wildcard_import:
		"Replace wildcard imports (`import java.util.*`) with explicit imports for each class used.",
	java_system_exit:
		"Throw an exception instead of calling `System.exit()`. Let the caller or main method decide when to terminate.",
	unreachable_code:
		"Remove or restructure the unreachable code. Code after return/throw/break/continue will never execute.",
	silent_catch:
		"Add error handling in the catch block. At minimum log the error: `catch (e) { console.error(e); }`",
	assertion_free_test:
		"Add assertions (expect/assert) to the test block. Tests without assertions don't verify behavior.",
	hardcoded_credentials:
		"Move credentials to environment variables or a secrets manager. Never hardcode passwords or API keys.",
	parseint_radix:
		"Add the radix parameter: `parseInt(value, 10)`. Without it, strings starting with '0' may be parsed as octal.",
	float_equality:
		"Use an epsilon comparison: `Math.abs(a - b) < Number.EPSILON` instead of direct equality.",
	infinite_recursion:
		"Add a base case guard (if/return) before the recursive call to prevent stack overflow.",
	sync_io_in_async:
		"Replace synchronous I/O with async equivalents (readFile instead of readFileSync) to avoid blocking the event loop.",
	perf_strlen_loop:
		"Cache strlen() result before the loop: `size_t len = strlen(s);` — strlen is O(n) and the compiler cannot hoist it.",
	perf_collect_iterate:
		"Remove the .collect() call and continue chaining iterators. Collecting breaks Rust's zero-cost iterator fusion.",
	perf_spread_reduce:
		"Replace `[...acc, item]` with `acc.push(item); return acc;` — spread copies the entire array on each iteration.",
	perf_await_loop:
		"Collect promises in an array and use `await Promise.all(promises)` instead of awaiting sequentially in the loop.",
	perf_query_loop:
		"Batch the IDs/keys and do a single `WHERE id IN (...)` query, then map results. Each loop iteration is a database round-trip.",
	perf_string_concat_loop:
		"Python: collect parts in a list, use `''.join(parts)`. Go: use `strings.Builder` with `WriteString()`. String += creates a new object each iteration.",
	perf_json_clone:
		"Use `structuredClone(obj)` — single traversal, handles Date/RegExp/Map/Set/ArrayBuffer. JSON round-trip is two full traversals and loses non-serializable types.",
	perf_filter_length:
		"Use `arr.reduce((n, x) => pred(x) ? n + 1 : n, 0)` or a simple loop counter. `.filter().length` allocates an intermediate array just to read its length.",
	perf_regex_loop:
		"Hoist regex construction above the loop. Regex compilation is expensive — V8/Python re-compiles on every call inside the loop.",
	perf_clone_loop:
		"Borrow (`&`) instead of cloning. If shared ownership is needed, use `Rc<T>` or `Arc<T>`. Each `.clone()` is a heap allocation.",
	perf_math_spread:
		"Use `arr.reduce((a, b) => Math.max(a, b))` or a loop. `Math.max(...arr)` pushes every element as a function argument and crashes at ~65K elements.",
	perf_sort_loop:
		"Sort the data once before the loop. Sorting inside a loop is O(n² log n) when O(n log n) suffices.",
	perf_json_loop:
		"Move JSON serialization/deserialization outside the loop. Each call traverses the entire object tree.",
	perf_array_from_map:
		"Use `Array.from(iterable, mapFn)` — the second argument applies the map during construction (single pass instead of two).",
	perf_malloc_loop:
		"Either move allocation outside the loop, call `free()` before the next iteration, or store pointers for later cleanup. This leaks memory proportional to iteration count.",
	perf_sprintf_loop:
		"Use `strings.Builder` with `b.WriteString()` and `fmt.Fprintf(&b, ...)` instead. `Sprintf` allocates a new string on each call.",
	perf_double_cast:
		"Fix the underlying type definitions so a direct cast is valid. `as unknown as T` bypasses TypeScript's type checker entirely — it cannot verify or optimize the conversion.",
	perf_len_list:
		"Use `sum(1 for x in gen)` to count without materializing the entire sequence into memory.",
	"bare-catch-block":
		"Empty catch blocks silently swallow errors. At minimum log the error, or use a Result type to make failure handling explicit. If the error genuinely cannot occur, add a comment explaining why.",
	"catch-return-null":
		"Returning null/undefined from catch loses the error context. Return a Result type or a typed error object instead. Callers cannot distinguish 'no value' from 'operation failed' when both return null.",
	"throw-as-control-flow":
		"Throwing for expected conditions (not found, validation failure) forces callers to use try/catch. Return a Result or error value instead — expected failures are values, not exceptions.",
	"untyped-catch":
		"catch(e) without narrowing is unsafe — e is unknown. Use instanceof, a type guard, or a tagged error's .is() method to narrow before accessing properties. Consider using Result types to avoid catch blocks entirely.",
	"error-string-comparison":
		"Comparing error.message strings is fragile — messages change between versions and locales. Use error codes, instanceof checks, or tagged errors (._tag) for reliable error discrimination.",
	"inconsistent-error-strategy":
		"This file mixes throw, return null, and return {error}. Pick one strategy. Prefer Result types or typed error returns — they compose cleanly and make every failure path visible in the type system.",
	swift_force_cast:
		"Use conditional cast (`as?`) with optional binding instead of force cast (`as!`). Force casts crash at runtime if the type doesn't match.",
	swift_force_try:
		"Use `do/catch` or `try?` instead of `try!`. Force try crashes at runtime if the call throws.",
	swift_force_unwrap:
		"Use optional binding (`if let`/`guard let`) or nil-coalescing (`??`) instead of force unwrap (`!`). Force unwrap crashes at runtime if the value is nil.",
	swift_implicitly_unwrapped:
		"Use regular optionals (`Type?`) with proper unwrapping instead of implicitly unwrapped optionals (`Type!`). Only acceptable for `@IBOutlet` properties and two-phase initialization.",
	swift_delegate_not_weak:
		"Declare delegate properties as `weak var delegate: SomeDelegate?` to avoid retain cycles. Delegates typically have shorter lifetimes than the delegating object.",
	swift_legacy_random:
		"Use `Int.random(in:)`, `Bool.random()`, or `Collection.randomElement()` instead of `arc4random`. Modern Swift random APIs are type-safe and cross-platform.",
	swift_legacy_hashvalue:
		"Implement `hash(into hasher: inout Hasher)` instead of `var hashValue: Int`. The legacy `hashValue` property is deprecated since Swift 4.2.",
	swift_fileid:
		"Use `#fileID` instead of `#file` or `#filePath`. It produces smaller strings and avoids leaking the developer's file system path.",
	swift_abbreviation:
		"Avoid non-standard abbreviations in identifiers (Apple API Design Guidelines). Use the full word: `button` not `btn`, `manager` not `mgr`, `label` not `lbl`.",
	swift_task_detached:
		"`Task.detached` breaks structured concurrency. Use `Task {}` or `TaskGroup` instead. Detached tasks don't inherit the parent's priority, task-local values, or cancellation.",
	swift_unhandled_task_error:
		"Errors in `Task { try ... }` are silently swallowed. Wrap in `do/catch` or use `try?`. Unhandled task errors make debugging extremely difficult.",
	swift_global_var:
		"Global mutable `var` without actor isolation is a data race in Swift 6. Use `let`, annotate with `@MainActor`, or wrap in an actor.",
	swift_self_escaping:
		"Referencing `self` in an `@escaping` closure without `[weak self]` risks a retain cycle. Use a capture list: `{ [weak self] in guard let self else { return } ... }`.",
	swift_filter_count:
		"Use `.count(where:)` instead of `.filter { ... }.count`. `.filter` allocates a throwaway array just to read its length.",
	perf_sort_loop_swift: "Sort the data once before the loop. `.sorted()` inside a loop is O(n² log n).",
	perf_json_loop_swift:
		"Move `JSONDecoder`/`JSONEncoder` construction outside the loop. Creating a new instance per iteration is wasteful.",
	perf_regex_loop_swift:
		"Hoist `NSRegularExpression` or `Regex` construction above the loop. Regex compilation is expensive.",
	perf_query_loop_swift:
		"Batch Core Data/database fetches outside the loop. Each `fetch()` inside the loop is an N+1 query.",
};

describe("PROVEN_TOOL_CHECKS — positive (must contain each real member)", () => {
	it.each(EXPECTED_PROVEN_MEMBERS)("P: has(%s) is true", (id) => {
		expect(PROVEN_TOOL_CHECKS.has(id)).toBe(true);
	});

	it("P: membership is exactly the expected id set, no more and no fewer", () => {
		expect(Array.from(PROVEN_TOOL_CHECKS).sort()).toEqual([...EXPECTED_PROVEN_MEMBERS].sort());
	});
});

describe("PROVEN_TOOL_CHECKS — negative (must not fire)", () => {
	it('N: does not contain "" (the StringLiteral-mutator replacement value)', () => {
		expect(PROVEN_TOOL_CHECKS.has("")).toBe(false);
	});

	it("N: does not contain an unrelated made-up check id", () => {
		expect(PROVEN_TOOL_CHECKS.has("definitely_not_a_real_check_id")).toBe(false);
	});
});

describe("TOOL_CHECK_INSTRUCTIONS — positive (exact assembled text)", () => {
	const cases = Object.entries(EXPECTED_INSTRUCTIONS);

	it.each(cases)("P: %s assembles to the exact expected instruction text", (key, expected) => {
		expect(TOOL_CHECK_INSTRUCTIONS[key]).toBe(expected);
	});

	it("P: has exactly the expected key set, no more and no fewer", () => {
		expect(Object.keys(TOOL_CHECK_INSTRUCTIONS).sort()).toEqual(
			Object.keys(EXPECTED_INSTRUCTIONS).sort(),
		);
	});
});

describe("TOOL_CHECK_INSTRUCTIONS — negative (must not fire)", () => {
	const keys = Object.keys(EXPECTED_INSTRUCTIONS);

	it.each(keys)("N: %s is never the empty string", (key) => {
		expect(TOOL_CHECK_INSTRUCTIONS[key]).not.toBe("");
	});

	it("N: an unrelated made-up check id has no instruction", () => {
		expect(TOOL_CHECK_INSTRUCTIONS.definitely_not_a_real_check_id).toBeUndefined();
	});
});

describe("TOOL_CHECK_INSTRUCTIONS — spot checks on tricky literal forms (positive, must fire)", () => {
	// Single-quoted source literals with an embedded double-quoted fragment —
	// the mutator can blank either half of a 2-part concatenation built from
	// single-quoted strings just as easily as double-quoted ones.
	it("P: rust_unwrap keeps both the expect() guidance and the unwrap() prohibition", () => {
		expect(TOOL_CHECK_INSTRUCTIONS.rust_unwrap).toBe(
			'Use `.expect("reason")` with a descriptive message, or propagate the error with `?`. ' +
				"Do NOT use `.unwrap()` in non-test code.",
		);
	});

	it("P: rust_expect_empty_msg keeps both single-quoted parts intact", () => {
		expect(TOOL_CHECK_INSTRUCTIONS.rust_expect_empty_msg).toBe(
			'`.expect("")` is `.unwrap()` with extra steps — the empty message gives no signal at crash time. ' +
				'Provide a descriptive `.expect("reason this cannot be None/Err")`, or propagate the error with `?`.',
		);
	});

	// A 4-part concatenation (the longest in the file) — a mid-sequence part
	// going missing collapses two adjacent words together with no separator,
	// which only an exact match (not a substring probe of either neighbor)
	// reliably catches.
	it("P: cuda_kernel_launch_unchecked keeps all four concatenated parts in order", () => {
		expect(TOOL_CHECK_INSTRUCTIONS.cuda_kernel_launch_unchecked).toBe(
			"After every kernel launch `kernel<<<grid, block>>>(...)`, call `cudaGetLastError()` " +
				"(non-blocking) to surface launch-time failures. For blocking semantics, follow with " +
				"`cudaDeviceSynchronize()` and check its return code. Otherwise launch errors stay silent " +
				"until the next CUDA API call, with confusing attribution.",
		);
	});
});
