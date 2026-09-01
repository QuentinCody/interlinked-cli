// General code-quality warning entries: JS/TS correctness smells, React hooks
// hygiene, test hygiene, and SQL schema/visibility checks. Two severity=error
// project entries (focused_tests, migration_ordering) sit here because they
// run alongside related project rules. Extracted from entries-warnings.ts —
// re-exported there as part of WARNING_ENTRIES.

import { checkPublicApiLeaksInternalType } from "../../checks/api-surface.js";
import { findUnjustifiedCasts } from "../../checks/cast-justification.js";
import { checkFetchWithoutAbortSignal } from "../../checks/fetch-abort.js";
import { findProcessEnvOutsideConfig } from "../../checks/env-access-scope.js";
import { findTopLevelSideEffects } from "../../checks/module-load-side-effects.js";
import {
	checkAccumulatingSpread,
	checkAsyncEventHandler,
	checkCatchAndLog,
	checkConstantCondition,
	checkDirectDomAccess,
	checkDisabledTests,
	checkErrorDispatchByInstanceof,
	checkExcessiveUseState,
	checkExtraneousDependencies,
	checkFloatingPromises,
	checkHardcodedTimeout,
	checkImportFromOwnBarrel,
	checkInlineObjectProps,
	checkJsonParseUnsafe,
	checkLossyErrorRethrow,
	checkNestedTernaries,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkPlaceholderMarkdownLinks,
	checkRequireAwait,
	checkSilentPromiseSwallow,
	checkSnapshotOveruse,
	checkTargetBlankNoRel,
	checkTestImportingTest,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";
import { CODE_QUALITY_ENTRIES_EXTRA } from "./code-quality-extra.js";

export const CODE_QUALITY_ENTRIES: CheckRegistration[] = [
	{
		id: "floating_promises",
		phase: "pre_warn",
		name: "Floating Promises",
		description:
			"Detects calls to async-declared functions (or fetch) at statement position without await, return, void, assignment, or .catch()/.finally() handling",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"An async function's return value is being ignored at statement position. Unhandled rejections silently fail and trigger `unhandledRejection` warnings. Add `await` if the caller is async, `return` if the caller propagates, or `.catch(err => ...)` to explicitly handle the rejection. Only use `void foo()` when fire-and-forget is intentional and documented.",
		fn: checkFloatingPromises,
		resultsPropName: "floatingPromises",
	},
	{
		id: "extraneous_deps",
		phase: "pre_warn",
		name: "Extraneous Dependencies",
		description: "Detects imported packages not in package.json",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This import references a package not listed in package.json. Run `npm install <package>` or remove the import.",
		fn: checkExtraneousDependencies,
		resultsPropName: "extraneousDeps",
	},
	{
		id: "non_null_assertion",
		phase: "post",
		name: "Non-Null Assertion",
		description: "Detects TypeScript non-null assertions (!)",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Avoid the non-null assertion operator (!). Use optional chaining (?.), nullish coalescing (??), or add a proper null check instead.",
		fn: checkNonNullAssertions,
		resultsPropName: "nonNullAssertions",
	},
	{
		id: "constant_condition",
		phase: "post",
		name: "Constant Condition",
		description: "Detects always-true/false conditions",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This condition is always true or always false. Remove the dead branch or fix the logic.",
		fn: checkConstantCondition,
		resultsPropName: "constantCondition",
	},
	{
		id: "number_precision_loss",
		phase: "pre_warn",
		name: "Number Precision Loss",
		description: "Detects integer literals beyond safe precision",
		tier: 2,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This integer exceeds Number.MAX_SAFE_INTEGER (2^53-1) and will lose precision. Use BigInt (append 'n') for large integers.",
		fn: checkNumberPrecisionLoss,
		resultsPropName: "numberPrecisionLoss",
	},
	{
		id: "require_await",
		phase: "post",
		name: "Require Await",
		description: "Detects async functions without await",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This async function never uses await. Remove the async keyword — it unnecessarily wraps the return value in a Promise and misleads callers about the function's behavior.",
		fn: checkRequireAwait,
		resultsPropName: "requireAwait",
	},
	{
		id: "accumulating_spread",
		phase: "post",
		name: "Accumulating Spread",
		description: "Detects spread operator in reduce (O(n^2))",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Spreading the accumulator in .reduce() creates a new copy on every iteration (O(n²)). Use a for loop with mutation, Object.fromEntries(), or Map instead.",
		fn: checkAccumulatingSpread,
		resultsPropName: "accumulatingSpread",
	},
	{
		id: "excessive_use_state",
		phase: "post",
		name: "Excessive useState",
		description: "Detects components with too many useState hooks",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Too many useState hooks in one component. Consider useReducer or extracting state into a custom hook.",
		fn: checkExcessiveUseState,
		resultsPropName: "excessiveUseState",
	},
	{
		id: "direct_dom_access",
		phase: "post",
		name: "Direct DOM Access",
		description: "Detects direct DOM manipulation in React components",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Avoid direct DOM access in React components. Use refs (useRef) or state-driven rendering.",
		fn: checkDirectDomAccess,
		resultsPropName: "directDomAccess",
	},
	{
		id: "inline_object_props",
		phase: "post",
		name: "Inline Object Props",
		description: "Detects inline object/array creation in JSX props",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Move inline object/array props to a const outside the component to prevent unnecessary re-renders.",
		fn: checkInlineObjectProps,
		resultsPropName: "inlineObjectProps",
	},
	{
		id: "async_event_handler",
		phase: "post",
		name: "Async Event Handler",
		description: "Detects async event handlers that may cause unmounted-component issues",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Async event handlers should handle errors internally. Wrap the body in try/catch.",
		fn: checkAsyncEventHandler,
		resultsPropName: "asyncEventHandler",
	},
	{
		id: "nested_ternaries",
		phase: "post",
		name: "Nested Ternaries",
		description: "Detects nested ternary expressions",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Nested ternaries hurt readability. Use if/else blocks or extract to a helper function.",
		fn: checkNestedTernaries,
		resultsPropName: "nestedTernaries",
	},
	{
		id: "catch_and_log",
		phase: "post",
		name: "Catch and Log",
		description: "Detects catch blocks that only log and rethrow",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Catching and only logging an error swallows it. Re-throw, return an error value, or add explicit recovery logic.",
		fn: checkCatchAndLog,
		resultsPropName: "catchAndLog",
	},
	{
		id: "lossy_error_rethrow",
		phase: "post",
		name: "Lossy Error Rethrow",
		description:
			"Detects catch (e) { throw new Error('...') } that constructs a fresh Error without forwarding the caught exception via the ES2022 { cause: e } option — drops the original stack trace and breaks downstream error.cause inspection.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Pass the original error through as the rethrow's cause: `throw new Error('wrapped', { cause: e })`. Without it the caught exception's stack and metadata are silently discarded — debuggers, logs, and any code walking `error.cause` see only the new prose message. If the caught error is genuinely uninteresting, document why with a comment alongside the rethrow.",
		fn: checkLossyErrorRethrow,
		resultsPropName: "lossyErrorRethrow",
		content_keywords: ["catch"],
	},
	{
		id: "import_from_own_barrel",
		phase: "pre_warn",
		name: "Import From Own Barrel",
		description:
			"Detects a non-barrel source file importing from its own-directory barrel ('./index', './', or the file's own published package name). The barrel re-exports the importing file, so loading order becomes file-resolution-dependent and forms latent module-init cycles. Mirrors Effect's `@effect/no-import-from-barrel-package` lint rule.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Import from the sibling submodule directly rather than from the barrel. In a file at `src/lib/foo.ts`, replace `import { Bar } from './index'` with `import { Bar } from './bar'`. The barrel re-exports your own module, so the import resolves through a partial cycle: at load time `index.js` is mid-evaluation, and `Bar`'s binding may not be set yet. Importing from the sibling's deep path also keeps tree-shaking effective and isolates the dependency graph for bundlers and IDEs.",
		fn: checkImportFromOwnBarrel,
		resultsPropName: "importFromOwnBarrel",
		content_keywords: ["from"],
	},
	{
		id: "fetch_without_abort_signal",
		phase: "post",
		name: "Fetch Without Abort Signal",
		description:
			"Detects a platform `fetch(...)` call whose options carry no `signal` — bare single-argument fetch, or an options literal with no `signal` key and no spread. The request cannot be cancelled and never times out: it leaks past component unmount and mismatches serverless deadlines. Non-literal options and wrapper `.fetch` methods are exempt (contents not visible). Effect-TS lessons port: Effect's HttpClient threads an interruption-bound AbortSignal into every underlying fetch.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Wire in a signal: `fetch(url, { signal: AbortSignal.timeout(10_000) })` for a deadline, or create an AbortController tied to the caller's lifetime (component unmount, request scope, process shutdown) and pass `controller.signal`. If the fetch is genuinely fire-and-forget for the process lifetime, say so in a comment.",
		fn: checkFetchWithoutAbortSignal,
		resultsPropName: "fetchWithoutAbortSignal",
		content_keywords: ["fetch"],
	},
	{
		id: "public_api_leaks_internal_type",
		phase: "post",
		name: "Public API Leaks Internal Type",
		description:
			"Detects an exported declaration whose signature (params, return type, heritage clause, type-alias RHS) references a same-file type that is not exported. Consumers cannot name the type to annotate their own bindings, and declaration emit fails with TS4023. Internal types used only inside function bodies are the normal pattern and never fire. Effect-TS lessons port: approximates Effect's custom oxlint rule `effect/no-unused-internal` at the same identifier-matching precision.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Export the referenced type alongside the declaration that uses it (`export interface Options {...}`), or keep the type private by removing it from the public signature — accept a wider structural type, or wrap the internal shape behind an exported one.",
		fn: checkPublicApiLeaksInternalType,
		resultsPropName: "publicApiLeaksInternalType",
		content_keywords: ["export"],
	},
	{
		id: "error_dispatch_by_instanceof",
		phase: "post",
		name: "Error Dispatch by instanceof",
		description:
			"Detects `e instanceof <BuiltinError>` (Error, TypeError, RangeError, SyntaxError, EvalError, URIError, ReferenceError, AggregateError) inside a catch block. `instanceof` against a JS-builtin error class fails across realm boundaries — iframes, worker contexts, vm.runInContext — so a real Error from another realm slips through the branch. Mirrors Effect's tag-dispatch convention (`Effect.catchTag`). User-defined error subclasses are exempt: the project controls construction so cross-realm leakage doesn't apply.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Dispatch on a structural field (e.g. `_tag`, `code`, `name`) rather than `instanceof Error`. Tag dispatch is realm-safe and survives serialization across worker / vm / cross-process boundaries. Common shapes: `if ((e as { _tag?: string })._tag === 'NetworkError') ...`, `if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') ...`, or `if (e instanceof MyCustomError) ...` (custom subclasses are fine because realm leakage doesn't apply). If the catch genuinely wants to ask 'is this any thrown Error at all?' rather than dispatching on a specific subtype, that's the rare legitimate case — leave a comment explaining why.",
		fn: checkErrorDispatchByInstanceof,
		resultsPropName: "errorDispatchByInstanceof",
		content_keywords: ["instanceof", "catch"],
	},
	{
		id: "silent_promise_catch",
		phase: "post",
		name: "Silent Promise Catch",
		description:
			"Detects .catch(() => {}), .catch(() => undefined), .catch(() => null), and .catch(function () {}) — a swallowed rejection silently masks bugs. The async cousin of bare-catch swallowing; promoted from the heuristic suggestion pipeline because the FP profile is tight (named handler refs, intent comments, and explicit param-ack bodies are exempt).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A `.catch(() => {})` swallows the rejection without reading it — anyone debugging a downstream symptom has no thread to pull. Either: (a) handle the error meaningfully (`.catch((e) => log.warn({ err: e }, 'failed'))`), (b) name the handler so its intent is documented (`.catch(reportAndContinue)`), or (c) if you genuinely don't care, leave an inline comment on the same line (`/* fire and forget */`) so the next reader knows the omission was deliberate.",
		fn: checkSilentPromiseSwallow,
		resultsPropName: "silentPromiseSwallow",
		content_keywords: [".catch"],
	},
	{
		id: "placeholder_markdown_link",
		phase: "post",
		name: "Placeholder Markdown Link",
		description:
			"Detects markdown links with an empty or anchor-only href — [text]() or [text](#) — placeholder links written but never given a real destination. Scoped to .md / .mdx / .markdown files; fenced code blocks are excluded so syntax examples don't fire.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This markdown link has no destination — `[text]()` / `[text](#)`. Fill in the real URL or path, or drop the link syntax if no link was intended. A same-page anchor needs a real slug after the `#` (e.g. `[text](#section-name)`).",
		fn: checkPlaceholderMarkdownLinks,
		resultsPropName: "placeholderMarkdownLinks",
		content_keywords: ["]("],
	},
	{
		id: "json_parse_unsafe",
		phase: "post",
		name: "JSON Parse Unsafe",
		description: "Detects JSON.parse without try/catch",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction: "Wrap JSON.parse() in a try/catch to handle malformed input gracefully.",
		fn: checkJsonParseUnsafe,
		resultsPropName: "jsonParseUnsafe",
	},
	{
		id: "hardcoded_timeout",
		phase: "post",
		name: "Hardcoded Timeout",
		description: "Detects magic number timeouts (setTimeout/setInterval)",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Extract magic timeout numbers into named constants (e.g., const POLL_INTERVAL_MS = 5000).",
		fn: checkHardcodedTimeout,
		resultsPropName: "hardcodedTimeout",
	},
	{
		// Promoted pre_warn → pre_block (2026-07-17, DW test-adoption P0.3a): the
		// skip-marker sibling of the already-pre_block `focused_tests`. Introducing
		// an UNCONDITIONAL skip in the same edit that changes prod is a test-signal
		// sabotage vector, so it blocks — but only INTRODUCED skips (the pre-block
		// gate is introduced-only; pre-existing repo skips surface as warnings), and
		// `findSkipMarkers` is conservative-by-construction (skipif / cfg_attr /
		// testing.Short are exempt), so this stays zero-FP. Escape: an
		// `// interlinked-ignore: disabled_tests — <reason>` directive.
		id: "disabled_tests",
		phase: "pre_block",
		name: "Disabled Tests",
		description:
			"Detects newly-introduced unconditional test skips (it.skip/xit/xdescribe, @pytest.mark.skip, #[ignore], t.Skip)",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Remove the skip marker — a disabled test masks regressions. If the skip is genuinely temporary, add `// interlinked-ignore: disabled_tests — <reason>` (audited).",
		fn: checkDisabledTests,
		resultsPropName: "disabledTests",
	},
	{
		id: "target_blank_no_rel",
		phase: "pre_warn",
		name: "Target Blank No Rel",
		description: 'Detects target="_blank" without rel="noopener"',
		tier: 2,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			'Add rel="noopener noreferrer" to links with target="_blank" to prevent reverse tabnapping.',
		fn: checkTargetBlankNoRel,
		resultsPropName: "targetBlankNoRel",
	},
	{
		id: "snapshot_overuse",
		phase: "pre_warn",
		name: "Snapshot Overuse",
		description: "Detects excessive snapshot testing",
		tier: 2,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Too many snapshot tests. Use targeted assertions (expect specific props, text content) instead of snapshots.",
		fn: checkSnapshotOveruse,
		resultsPropName: "snapshotOveruse",
	},
	{
		id: "test_importing_test",
		phase: "pre_warn",
		name: "Test Importing Test",
		description: "Detects test files importing from other test files",
		tier: 2,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Tests should not import from other test files. Extract shared test utilities to a separate helpers file.",
		fn: checkTestImportingTest,
		resultsPropName: "testImportingTest",
	},
	{
		id: "unjustified_cast",
		phase: "post",
		name: "Unjustified Cast",
		description:
			"Detects type-assertion casts (as X) that lack a // SAFETY: justification comment",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Every non-(as const) type assertion must carry a // SAFETY: comment explaining why the cast is sound; the assertion silences the type checker, so the reviewer needs the invariant spelled out. Put it on the same line or the line(s) directly above.",
		fn: findUnjustifiedCasts,
		resultsPropName: "unjustifiedCasts",
		content_keywords: [" as "],
	},
	{
		id: "process_env_outside_config",
		phase: "post",
		name: "process.env Outside Config",
		description:
			"Detects process.env reads outside the config boundary (config modules, .config.* files, /config/ dirs, setup/bootstrap)",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"process.env should be read only at a configuration boundary (a config module, .config.* file, /config/ directory, or setup/bootstrap file) and the parsed value passed through arguments. This keeps the config shape explicit, typed, and testable.",
		fn: findProcessEnvOutsideConfig,
		resultsPropName: "processEnvOutsideConfig",
		content_keywords: ["process.env"],
	},
	{
		id: "top_level_side_effect",
		phase: "post",
		name: "Top-Level Side Effect",
		description:
			"Detects I/O and side-effecting calls at module load time (not deferred inside a function/class)",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Modules should not perform I/O, open connections, start servers, or read env at import time. Move this call inside a function or export so the module is testable and import order cannot cause ordering bugs. Entrypoint modules (index/server/cli/hook-entry/bootstrap/setup) are exempt.",
		fn: findTopLevelSideEffects,
		resultsPropName: "topLevelSideEffects",
		content_keywords: ["readFileSync", "writeFileSync", "execSync", "spawnSync", "listen", "fetch"],
	},
	...CODE_QUALITY_ENTRIES_EXTRA,
];
