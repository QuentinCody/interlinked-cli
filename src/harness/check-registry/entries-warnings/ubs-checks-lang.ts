// UBS (Plan 04) language-specific bug-class detectors for JS/TS, Python,
// Java, Go, and C/C++ (rows 27–30 + additional Plan 04 entries). Split out
// of ubs-checks.ts to stay under the per-file line cap; spread back into
// UBS_ENTRIES there. Moving code, no logic change.

import {
	checkDeeplyNestedCallback,
	checkDeferInLoop,
	checkDivisionByVariable,
	checkEvalInputTainted,
	checkFloatEquality,
	checkGoroutineNoWaitgroup,
	checkJavaOptionalGet,
	checkJsLooseEquality,
	checkLargeFunction,
	checkMagicNumberNoConst,
	checkNumericComparisonChain,
	checkOsSystemTainted,
	checkPickleUntrustedLoad,
	checkPrintDebugLeak,
	checkPyMutableDefaultArg,
	checkRegexInLoopNoCompile,
	checkRustDebugAssertSideEffects,
	checkSqlEscapeHatchNonLiteral,
	checkSqlStringConcat,
	checkTempfileMktempRace,
	checkTimeFormatLocaleDep,
	checkUbsStringConcatInLoop,
	checkUncheckedRedirect,
	checkUnsafeFormatString,
	checkXmlExternalEntity,
} from "../../generic-checks.js";
import type { CheckRegistration } from "../types.js";

export const UBS_ENTRIES_LANG: CheckRegistration[] = [
	{
		id: "ubs_js_loose_equality",
		phase: "pre_warn",
		name: "UBS JS Loose Equality",
		description:
			"Detects `==` / `!=` in JS/TS files. The triple-equality form (`===` / `!==`) avoids JS type coercion. The `x == null` / `x != null` idiom is allowed (Plan 04 §4.2 documented exception).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `===` / `!==` instead of `==` / `!=`. Loose equality triggers JavaScript type coercion (`'' == 0`, `null == undefined`, `'1' == 1` are all true) and is a documented bug source. The one allowed loose form is `x == null`, which checks both null AND undefined in one expression.",
		fn: checkJsLooseEquality,
		resultsPropName: "jsLooseEquality",
		content_keywords: ["==", "!="],
	},
	{
		id: "ubs_float_equality",
		phase: "pre_warn",
		name: "UBS Float Equality",
		description:
			"Detects `===` / `!==` against a non-IEEE-safe float literal — floating-point representation makes direct comparison unreliable.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Float equality is unreliable due to IEEE 754 representation: `0.1 + 0.2 === 0.3` is false. Compare with an epsilon: `Math.abs(a - b) < 1e-9`. Values exactly representable in binary (0.0, 0.5, 1.0, etc.) are skipped by the detector.",
		fn: checkFloatEquality,
		resultsPropName: "floatEquality",
		content_keywords: ["==", "!="],
	},
	{
		id: "ubs_java_optional_get",
		phase: "post",
		name: "UBS Java Optional.get()",
		description:
			"Detects Java `Optional<T>....get()` without an `isPresent()` / `orElse(...)` guard — NullPointerException risk.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`Optional.get()` throws `NoSuchElementException` when the optional is empty. Guard with `isPresent()` first, or replace with `orElse(default)` / `orElseGet(() -> ...)` / `orElseThrow(() -> new IllegalStateException(...))`. The whole point of `Optional` is to make absence explicit; `.get()` discards that signal.",
		fn: checkJavaOptionalGet,
		resultsPropName: "javaOptionalGet",
		content_keywords: ["Optional"],
	},
	{
		id: "ubs_rust_debug_assert_side_effect",
		phase: "post",
		name: "Rust debug_assert side effect",
		description:
			"Detects Rust `debug_assert!` / `debug_assert_eq!` / `debug_assert_ne!` arguments that contain a try operator, assignment, or mutating-looking call. Release builds erase debug_assert evaluation, so side effects inside it silently disappear.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Move side effects out of `debug_assert*` before the assertion. Compute the value first, propagate any `?` error normally, and assert only on the already-computed result. In release builds Rust removes `debug_assert*` argument evaluation entirely, so mutating calls like `insert_*()` or fallible calls with `?` would never run.",
		fn: checkRustDebugAssertSideEffects,
		resultsPropName: "rustDebugAssertSideEffect",
		content_keywords: ["debug_assert"],
	},
	{
		id: "ubs_division_by_variable",
		phase: "post",
		name: "UBS Division by Variable",
		description:
			"Detects `expr / identifier` — the divisor variable might be zero (advisory; high FP rate, ships in DEFAULT_ADVISORY_SKIPS).",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Division by a variable can throw `Division by zero` (Python) / produce `Infinity` / `NaN` (JS) at runtime. Add an explicit zero-check (`if (divisor === 0) ...`) or assert the precondition before the division. If the divisor is provably non-zero by construction, leave a comment so cold readers don't repeat the analysis.",
		fn: checkDivisionByVariable,
		resultsPropName: "divisionByVariable",
	},
	// ---- Plan 04 D.1 partial — three high-leverage backlog entries. ----
	// `eval_usage` (entries-errors.ts) and `cross-language.ts:checkSqlInjection`
	// already pre_block on broad eval / SQL cases; the two `error`-severity
	// pre_warn entries below specialize on the tainted-input subset (non-
	// literal first arg / template-literal interpolation) and add extra
	// pre-event signal without flipping decision semantics. The third entry
	// is a Python-specific post warning.
	{
		id: "ubs_eval_input_tainted",
		phase: "pre_warn",
		name: "Eval / Function / exec on tainted input",
		description:
			"Detects eval / Function / exec / compile invoked with a non-literal first argument (likely a parameter or external value).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Evaluating attacker-controllable input as code is the most direct RCE pattern. If you genuinely need dynamic dispatch, keep the input on a strict allowlist (lookup table → preset function); never pass it to eval / Function / exec / compile.",
		fn: checkEvalInputTainted,
		resultsPropName: "evalInputTainted",
		content_keywords: ["eval", "Function", "exec", "compile"],
	},
	{
		id: "ubs_sql_string_concat",
		phase: "pre_warn",
		name: "SQL string concatenation",
		description:
			"Detects SQL keywords inside a quoted string immediately followed by JS/Py concatenation or template-literal interpolation — the canonical SQL-injection shape.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Use parameterized queries / prepared statements: `db.query('SELECT * WHERE id = $1', [id])`. Concatenating input into the SQL string is a SQLi vector even on internal queries — values that look safe today get reached by external code paths tomorrow.",
		fn: checkSqlStringConcat,
		resultsPropName: "sqlStringConcat",
		content_keywords: ["SELECT", "INSERT", "UPDATE", "DELETE"],
	},
	{
		id: "sql_escape_hatch_non_literal",
		phase: "pre_warn",
		name: "SQL escape hatch with non-literal",
		description:
			"Detects SQL libraries' `sql.unsafe(...)` / `sql.raw(...)` / `sql.lit(...)` escape hatch invoked with a non-literal argument — runtime expressions reach the unparameterized path, restoring the SQL-injection vector the library otherwise prevents. Mirrors Effect's `Statement` discipline: `sql.unsafe` is reserved for compile-time constants like schema names. Effect-TS lessons port.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Wrap the value as a parameter, not via the escape hatch: `` sql`SELECT * FROM users WHERE id = ${userId}` `` (Effect/Drizzle) or `db.query('... WHERE id = $1', [userId])` (node-postgres). The escape hatch (`sql.unsafe` / `sql.raw` / `sql.lit`) is for compile-time constants only — schema names, version strings, hand-audited DDL fragments — never for runtime values. If you genuinely need to interpolate a column or table name from a closed allow-list, do the validation explicitly and then `sql.unsafe('<the_validated_constant>')` with the literal still hard-coded after the check.",
		fn: checkSqlEscapeHatchNonLiteral,
		resultsPropName: "sqlEscapeHatchNonLiteral",
		content_keywords: [".unsafe", ".raw", ".lit"],
	},
	{
		id: "ubs_python_mutable_default_arg",
		phase: "post",
		name: "Python mutable default argument",
		description:
			"Detects `def f(x=[])` / `def f(x={})` — Python evaluates default values once at def time, sharing them across calls.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Python evaluates default-argument values exactly once, at function-def time. Mutable defaults (`[]`, `{}`, `set()`) are shared across every invocation — appending to a default list mutates state visible to the next caller. Use `def f(x=None): if x is None: x = []` instead.",
		fn: checkPyMutableDefaultArg,
		resultsPropName: "pyMutableDefaultArg",
		content_keywords: ["def "],
	},
	// ---- Plan 04 D.1 backlog (17 of 20) ----
	{
		id: "ubs_tempfile_mktemp_race",
		phase: "pre_warn",
		name: "Tempfile mktemp Race",
		description:
			"Detects Python `tempfile.mktemp(...)` — TOCTOU race; an attacker can substitute a symlink between the name return and open.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"`tempfile.mktemp()` only generates a name — the caller has to open the file separately, leaving a window where an attacker can substitute a symlink. Use `tempfile.NamedTemporaryFile()` / `tempfile.mkstemp()` which atomically open the file with O_EXCL.",
		fn: checkTempfileMktempRace,
		resultsPropName: "tempfileMktempRace",
		content_keywords: ["mktemp", "tempfile.mktemp"],
	},
	{
		id: "ubs_pickle_untrusted_load",
		phase: "pre_warn",
		name: "Pickle Untrusted Load",
		description:
			"Detects Python `pickle.load(...)` / `pickle.loads(...)` / `cPickle` — unpickling attacker-controlled bytes executes arbitrary `__reduce__` code.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"`pickle.load`/`loads` is effectively `eval` for bytes — a crafted pickle can run any Python code via `__reduce__`. For data interchange use JSON / msgpack; if you must use pickle, sign the payload (HMAC) and verify before unpickling, and only ever unpickle bytes you produced yourself.",
		fn: checkPickleUntrustedLoad,
		resultsPropName: "pickleUntrustedLoad",
		content_keywords: ["pickle.load", "pickle.loads", "cPickle"],
	},
	{
		id: "ubs_xml_external_entity",
		phase: "pre_warn",
		name: "XML External Entity",
		description:
			"Detects `xml.etree` / `xml.dom` / `xml.sax` / `lxml` imports without `defusedxml` — XXE attacks read arbitrary files / cause DoS via billion-laughs.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Python's stdlib XML parsers do NOT disable external-entity resolution by default — XXE attacks can exfiltrate `/etc/passwd` or cause DoS via billion-laughs expansion. Use `defusedxml` (which mirrors the same APIs but with safe defaults) instead of `xml.etree` / `xml.dom` / `xml.sax` / `lxml`.",
		fn: checkXmlExternalEntity,
		resultsPropName: "xmlExternalEntity",
		content_keywords: ["etree", "xml.dom", "xml.sax"],
	},
	{
		id: "ubs_os_system_tainted",
		phase: "pre_warn",
		name: "os.system / os.popen with tainted input",
		description:
			"Detects Python `os.system(name)` / `os.popen(name)` invoked with a non-literal first argument — command-injection vector.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"`os.system` / `os.popen` always go through `/bin/sh`, so any non-literal argument is a command-injection vector. Use `subprocess.run([\"cmd\", \"arg\"])` (list form) so the shell is bypassed, or shell-quote with `shlex.quote(...)` if a shell really is needed.",
		fn: checkOsSystemTainted,
		resultsPropName: "osSystemTainted",
		content_keywords: ["os.system", "os.popen"],
	},
	{
		id: "ubs_unsafe_format_string",
		phase: "pre_warn",
		name: "Unsafe Format String",
		description:
			"Detects C/C++ `printf` / `sprintf` / `fprintf` with a non-literal format argument — `%n` writes arbitrary memory; `%x` leaks stack.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"A user-controlled format string can leak stack memory (`%x`) or write arbitrary bytes (`%n`). Always pass a literal format spec and route the variable into the value position: `printf(\"%s\", input)`, never `printf(input)`.",
		fn: checkUnsafeFormatString,
		resultsPropName: "unsafeFormatString",
		content_keywords: ["printf(", "sprintf(", "fprintf("],
	},
	{
		id: "ubs_unchecked_redirect",
		phase: "pre_warn",
		name: "Unchecked Redirect",
		description:
			"Detects JS/TS `redirect(url)` / `location.href = url` / `window.location = url` with a non-literal URL — open-redirect vector.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Open-redirect bugs let attackers craft links that go through your domain before bouncing to a phishing site. Validate the redirect target against an allowlist or ensure it's a relative path (`url.startsWith('/')`) before redirecting.",
		fn: checkUncheckedRedirect,
		resultsPropName: "uncheckedRedirect",
		// Mirror EVERY trigger surface in the regex: `redirect(`,
		// `location.href`, AND `window.location`. Omitting any one form
		// turns the gate into a silent false-negative — a JS/TS edit that
		// only adds `window.location = nextUrl` would bypass the
		// pre_warn check. Audit pass: keep this list 1:1 with `callRe` in
		// `checkUncheckedRedirect` (`src/harness/checks/ubs-language-specific.ts`).
		content_keywords: ["redirect(", "location.href", "window.location"],
	},
	{
		id: "ubs_goroutine_no_waitgroup",
		phase: "post",
		name: "Goroutine without WaitGroup",
		description:
			"Detects Go `go func()` started without an accompanying `wg.Add` / `wg.Done` / errgroup — fire-and-forget leak risk.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A bare `go func() { ... }()` leaks if the caller exits before the goroutine completes — work is silently dropped. Pair with `sync.WaitGroup` / `errgroup.Group`, or pass a context the goroutine respects so the lifetime is explicit.",
		fn: checkGoroutineNoWaitgroup,
		resultsPropName: "goroutineNoWaitgroup",
		content_keywords: ["go func", "goroutine"],
	},
	{
		id: "ubs_defer_in_loop",
		phase: "post",
		name: "Defer in Loop",
		description:
			"Detects Go `defer` inside a `for` loop — defers run at function return, accumulating resources across iterations.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Go `defer` runs at FUNCTION return, not loop iteration. `for { f, _ := os.Open(...); defer f.Close() }` accumulates open file handles across every iteration. Wrap the loop body in a closure or a helper function, or close the handle inline before the next iteration.",
		fn: checkDeferInLoop,
		resultsPropName: "deferInLoop",
		content_keywords: ["defer ", "for "],
	},
	{
		id: "ubs_string_concat_in_loop",
		phase: "post",
		name: "String Concat in Loop",
		description:
			"Detects `result += chunk` inside a loop in immutable-string languages (Python, Java, JS, Go) — O(n²).",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`s += chunk` in a loop is O(n²) in Python / Java / JS / Go because each `+=` allocates a new string. Use a `list.append` + `''.join` (Python), `StringBuilder` (Java), `[].push` + `.join('')` (JS), or `strings.Builder` (Go).",
		fn: checkUbsStringConcatInLoop,
		resultsPropName: "ubsStringConcatInLoop",
	},
	{
		id: "ubs_numeric_comparison_chain",
		phase: "post",
		name: "Numeric Comparison Chain",
		description:
			"Detects 3+ consecutive `instanceof` / `compareTo` lines in Java — typically missing polymorphism.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A chain of `if (x instanceof A)` / `if (x instanceof B)` is a sign of missing polymorphism. Move the per-type behavior onto the types themselves and call a virtual method, or use a `switch` on a sealed/enum discriminant.",
		fn: checkNumericComparisonChain,
		resultsPropName: "numericComparisonChain",
		content_keywords: ["instanceof", "compareTo"],
	},
	{
		id: "ubs_print_debug_leak",
		phase: "post",
		name: "Print Debug Leak",
		description:
			"Detects `console.log` / Python `print(...)` / Go `fmt.Println` left in non-test, non-CLI code — typically forgotten debug breadcrumbs.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`console.log` / `print` / `fmt.Println` left in library code is almost always a forgotten debug print. Use a structured logger (with a level) so the noise can be filtered, or remove the line if it was just a breadcrumb.",
		fn: checkPrintDebugLeak,
		resultsPropName: "printDebugLeak",
		content_keywords: ["console.log", "print(", "fmt.Println"],
	},
	// `ubs_hardcoded_localhost` was promoted to pre_block / error severity in
	// Phase 1 of the agent-quality rollout (see docs/plans/11-...md). After
	// the extension-gate tightening landed alongside the promotion, the
	// check's FP rate dropped to ~0 against the dogfood corpus. Entry now
	// lives in `entries-errors.ts`.
	{
		id: "ubs_magic_number_no_const",
		phase: "post",
		name: "Magic Number No Const",
		description:
			"Detects 3+ digit numeric literals in expression context (not initializer) — magic numbers without a named constant.",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`setTimeout(fn, 5000)` tells nobody what `5000` represents. Hoist into a named constant (`const RETRY_DELAY_MS = 5000`) so cold readers see intent without grepping for the value.",
		fn: checkMagicNumberNoConst,
		resultsPropName: "magicNumberNoConst",
	},
	{
		id: "ubs_large_function",
		phase: "post",
		name: "Large Function",
		description:
			"Detects a single function spanning 80+ body lines — review/refactor candidate.",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Functions over ~80 lines stretch the cold-reader's working memory. Extract internal stages (parse / validate / dispatch / serialize) into helpers with names that explain what each stage does.",
		fn: checkLargeFunction,
		resultsPropName: "largeFunction",
	},
	{
		id: "ubs_deeply_nested_callback",
		phase: "post",
		name: "Deeply Nested Callback",
		description:
			"Detects 4+ levels of nested function/arrow callbacks — callback-hell smell.",
		tier: 3,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Nesting 4+ callbacks deep is callback hell. Refactor with `async`/`await`, `Promise.all`, or extract each level into a named function so the structure is grep-able and the failure modes are isolatable.",
		fn: checkDeeplyNestedCallback,
		resultsPropName: "deeplyNestedCallback",
		content_keywords: ["function", "=>"],
	},
	{
		id: "ubs_time_format_locale_dep",
		phase: "post",
		name: "Time Format Locale Dependent",
		description:
			"Detects JS `toLocaleString()` / Java `DateTimeFormatter.ofLocalized*` without an explicit locale — formatting drifts by environment.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`date.toLocaleString()` (no args) or Java `DateTimeFormatter.ofLocalized*` (no `withLocale`) produces different strings depending on the JVM/Node locale. Pass an explicit locale (`'en-US'`) or use a fixed pattern (ISO-8601) when serializing for storage / wire formats.",
		fn: checkTimeFormatLocaleDep,
		resultsPropName: "timeFormatLocaleDep",
		content_keywords: ["toLocaleString", "DateTimeFormatter"],
	},
	{
		id: "ubs_regex_in_loop_no_compile",
		phase: "post",
		name: "Regex in Loop No Compile",
		description:
			"Detects Python `re.match` / `re.search` / `re.sub` inside a loop without `re.compile` — recompiles per iteration.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Calling `re.match(pattern, ...)` inside a loop recompiles `pattern` on every iteration. Hoist `re.compile(pattern)` outside the loop and call `pattern.match(...)` per iteration — Python caches compilations but the cache lookup itself is overhead.",
		fn: checkRegexInLoopNoCompile,
		resultsPropName: "regexInLoopNoCompile",
		content_keywords: ["re.match", "re.search", "re.compile"],
	},
];
