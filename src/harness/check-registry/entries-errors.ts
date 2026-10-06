// Pre-block, severity=error checks for correctness/security issues with zero
// false-positive risk. See check-registry/types.ts for CheckPhase semantics.

import { checkRawControlBytes } from "../checks/control-bytes.js";
import { detectUnawaitedAsyncAssertions } from "../checks/test-async-assertions.js";
import {
	checkAsyncPromiseExecutor,
	checkChildProcessExecUserInput,
	checkCookieMissingSecurityFlags,
	checkDangerouslySetInnerHTML,
	checkEvalUsage,
	checkInnerHtmlUsage,
	checkLoggerFormatUserInput,
	checkMarshalLoad,
	checkMisusedPromises,
	checkMixedSyncAsyncFileApi,
	checkMutexLockUnwrap,
	checkNanComparison,
	checkPackageJsonPublishInvariants,
	checkPromiseRejectNonError,
	checkPyNoneEquality,
	checkPythonAssertTautology,
	checkSelfImport,
	checkShelveOpen,
	checkSubprocessShellTrue,
	checkThrowLiteral,
	checkTlsVerifyDisabled,
	checkUbsHardcodedLocalhost,
	checkUnsafeOptionalChaining,
	checkWeakHash,
	checkYamlUnsafeLoad,
} from "../generic-checks.js";
import type { CheckRegistration } from "./types.js";

export const ERROR_ENTRIES: CheckRegistration[] = [
	{
		id: "misused_promises",
		phase: "pre_block",
		name: "Misused Promises",
		description: "Detects floating promises and missing await",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Do not pass async functions to synchronous APIs like .forEach() or .reduce(). Use a for...of loop with await instead, or Promise.all() with .map().",
		fn: checkMisusedPromises,
		resultsPropName: "misusedPromises",
	},
	{
		id: "async_promise_executor",
		phase: "pre_block",
		name: "Async Promise Executor",
		description: "Detects async functions passed to Promise constructor",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Remove the async keyword from the Promise executor. If you need to await inside, restructure to use async/await outside the Promise constructor.",
		fn: checkAsyncPromiseExecutor,
		resultsPropName: "asyncPromiseExecutor",
	},
	{
		id: "self_import",
		phase: "pre_block",
		name: "Self Import",
		description: "Detects a module importing itself",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"This module imports from itself, which causes circular dependency issues or empty values at runtime. Move shared code to a separate module.",
		fn: checkSelfImport,
		resultsPropName: "selfImports",
	},
	{
		id: "eval_usage",
		phase: "pre_block",
		name: "Eval Usage",
		description: "Detects use of eval() and Function()",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"eval() and new Function() are security risks (code injection). Use JSON.parse() for data, or restructure to avoid dynamic code execution.",
		fn: checkEvalUsage,
		resultsPropName: "evalUsage",
	},
	{
		id: "inner_html",
		phase: "pre_block",
		name: "innerHTML Usage",
		description: "Detects direct innerHTML assignment (XSS risk)",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"innerHTML and dangerouslySetInnerHTML create XSS vulnerabilities. Use textContent for plain text, or a sanitization library for HTML.",
		fn: checkInnerHtmlUsage,
		resultsPropName: "innerHtml",
	},
	{
		id: "nan_comparison",
		phase: "pre_block",
		name: "NaN Comparison",
		description: "Detects direct comparison with NaN",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction: "NaN is never equal to itself. Use Number.isNaN(x) instead of x === NaN.",
		fn: checkNanComparison,
		resultsPropName: "nanComparison",
	},
	{
		id: "throw_literal",
		phase: "pre_block",
		name: "Throw Literal",
		description: "Detects throwing string literals instead of Error objects",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Always throw Error objects (throw new Error('message')), not strings or other values. Throwing non-Error values loses stack traces and breaks error handling patterns.",
		fn: checkThrowLiteral,
		resultsPropName: "throwLiteral",
	},
	{
		id: "promise_reject_non_error",
		phase: "pre_block",
		name: "Promise.reject with non-Error",
		description:
			"Detects Promise.reject() called with a string / number / boolean / null / undefined literal",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Reject with an Error instance: `Promise.reject(new Error('...'))`. Rejecting with a string/number/undefined drops the stack trace, breaks `instanceof Error` checks downstream, and forces catchers to `typeof`-narrow instead of using structured error types.",
		fn: checkPromiseRejectNonError,
		resultsPropName: "promiseRejectNonError",
	},
	{
		id: "raw_control_bytes",
		phase: "pre_block",
		name: "Raw Control Bytes in Source",
		description:
			"Detects a literal control character (NUL, ESC, DEL, ...) written into source instead of its escape sequence",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace the literal control character with its escape (e.g. the four characters backslash-x-0-0 for NUL). The escape produces an identical string at runtime, so the fix is lossless. A raw byte makes grep classify the ENTIRE file as binary and skip it, so the file becomes invisible to code search — an agent asking 'is this symbol referenced anywhere?' gets a confident, wrong 'no'. The diff renders identically to the escaped form, so review cannot catch it either. Both failure modes are silent, which is why this blocks.",
		fn: checkRawControlBytes,
		resultsPropName: "rawControlBytes",
	},
	{
		id: "unsafe_optional_chaining",
		phase: "pre_block",
		name: "Unsafe Optional Chaining",
		description: "Detects unsafe optional chaining patterns",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Wrapping an optional chain in parentheses then accessing a property defeats the safety of ?. — if the chain returns undefined, the outer access will throw.",
		fn: checkUnsafeOptionalChaining,
		resultsPropName: "unsafeOptionalChaining",
	},
	{
		id: "dangerously_set_inner_html",
		phase: "pre_block",
		name: "dangerouslySetInnerHTML",
		description: "Detects React dangerouslySetInnerHTML usage",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"innerHTML and dangerouslySetInnerHTML create XSS vulnerabilities. Use textContent for plain text, or a sanitization library for HTML.",
		fn: checkDangerouslySetInnerHTML,
		resultsPropName: "dangerouslySetInnerHtml",
	},
	{
		id: "package_json_publish_invariants",
		phase: "pre_block",
		name: "Package JSON Publish Invariants",
		description:
			"Detects edits to a publishable package.json that silently drop publish-critical fields (name/version/license/repository/homepage/bugs/keywords/author/engines/main/types/exports/bin/files/publishConfig/sideEffects/type/scripts.prepublishOnly)",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"A field that was present in the pre-edit package.json is missing from this edit. Restore it or publish will ship a broken tarball. Common causes: a rewrite that forgot to include publish metadata, or a subagent stripping fields it didn't recognise. Re-read the file on disk, keep the listed field(s), then retry.",
		fn: checkPackageJsonPublishInvariants,
		resultsPropName: "packageJsonPublishInvariants",
	},
	// ---- Plan 04 Phase-1 UBS critical-tier (rows 22–26) ----
	{
		id: "ubs_mutex_lock_unwrap",
		phase: "pre_block",
		name: "Mutex Lock Unwrap",
		description:
			"Detects Mutex<T>...lock().unwrap() in Rust source — panics on poisoned mutex.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Mutex::lock().unwrap() panics on a poisoned mutex (one that was held by a thread that panicked). Use .expect(\"reason\") to document why panic is acceptable, or recover with `match guard.lock() { Ok(g) => …, Err(poisoned) => poisoned.into_inner() }`.",
		fn: checkMutexLockUnwrap,
		resultsPropName: "mutexLockUnwrap",
		content_keywords: ["Mutex", "lock"],
	},
	{
		id: "ubs_subprocess_shell_true",
		phase: "pre_block",
		name: "Subprocess shell=True",
		description:
			"Detects subprocess.<fn>(..., shell=True) in Python — command-injection vector.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"subprocess.<run/Popen/check_output/...>(cmd, shell=True) is a command-injection vector when any part of `cmd` originates from user input. Pass a list of arguments instead — `subprocess.run([\"ls\", \"-la\"])` — so the shell is bypassed entirely.",
		fn: checkSubprocessShellTrue,
		resultsPropName: "subprocessShellTrue",
		content_keywords: ["subprocess"],
	},
	{
		id: "ubs_tls_verify_disabled",
		phase: "pre_block",
		name: "TLS Verify Disabled",
		description:
			"Detects TLS peer-cert verification turned off (verify=False / InsecureSkipVerify: true / rejectUnauthorized: false) — MitM vector.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Disabling TLS peer verification opens a man-in-the-middle hole on every request. Restore the default verification or, if a self-signed cert is genuinely needed, install the cert into the trust store and document why in a comment immediately above the call.",
		fn: checkTlsVerifyDisabled,
		resultsPropName: "tlsVerifyDisabled",
		// `verify` (no `=`) so the gate matches the spaced Python form
		// `verify = False` as well as `verify=False`. The detector regex
		// itself allows whitespace around the `=`, so the previous narrower
		// `verify=` gate was a strict subset of what the detector accepts —
		// the gate, not the detector, was the false-negative source.
		content_keywords: ["verify", "InsecureSkipVerify", "rejectUnauthorized"],
	},
	{
		id: "ubs_py_none_equality",
		phase: "pre_block",
		name: "Python None Equality",
		description:
			"Detects `x == None` / `x != None` in Python — should be `is None` / `is not None` per PEP 8.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"PEP 8: comparisons to singletons (None, True, False) must use `is`/`is not`. `x == None` triggers `__eq__`, which proxy/mock objects can override to return surprising results — the comparison silently lies.",
		fn: checkPyNoneEquality,
		resultsPropName: "pyNoneEquality",
		content_keywords: ["None"],
	},
	{
		id: "ubs_weak_hash",
		phase: "pre_block",
		name: "Weak Hash",
		description: "Detects MD5 / SHA-1 calls — broken hashes for security-bearing use.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"MD5 and SHA-1 are broken for collision resistance and must not back signatures, password hashing, or anything else the security model relies on. Use SHA-256 / SHA-3 / BLAKE3, or a password-grade KDF (bcrypt / scrypt / argon2) for credentials. If the hash is a non-security cache key, leave a comment to that effect so the next reader knows why MD5 stayed.",
		fn: checkWeakHash,
		resultsPropName: "weakHash",
		content_keywords: ["md5", "sha1"],
	},
	{
		id: "ubs_hardcoded_localhost",
		phase: "pre_block",
		name: "Hardcoded Localhost",
		description:
			"Detects `localhost` / `127.0.0.1` baked into source outside of test/config/example/dev paths and outside of non-source extensions (.md/.txt/.yaml/.json/etc.). Dev-gated lines are exempt: a dev-named identifier on the line (`config.devPort`, `DEV_URL`) or a dev-gated conditional within the previous three lines (`if (devMode)`, `NODE_ENV` checks) marks a declared local-dev value, not a leaked default. Deliberate loopback is exempt: server bind/listen addresses (`listen(p, \"127.0.0.1\")`, `--host=`), env-var fallbacks (`process.env.X ?? \"localhost\"`, `os.environ.get`), loopback detection/comparison, and the address of a local process the file itself launches or binds (Chrome `--remote-debugging-port` DevTools, an env-derived port, its own loopback server).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"`localhost` / `127.0.0.1` baked into production source breaks in deploy and is a frequent dev-default leak. Read it from an env var (`process.env.API_URL`) or a config file, with a clear default for local dev.",
		fn: checkUbsHardcodedLocalhost,
		resultsPropName: "ubsHardcodedLocalhost",
		content_keywords: ["localhost", "127.0.0.1"],
	},
	{
		id: "child_process_exec_user_input",
		phase: "pre_block",
		name: "Child Process Exec with User Input",
		description:
			"Detects Node `child_process.exec(userInput)` / `cp.execSync(req.body)` / `childProcess.spawn(input)` shapes where the first argument is a non-literal expression. Command-injection vector. Complements `ubs_subprocess_shell_true` (Python) and `ubs_eval_input_tainted` (bare `exec` after destructured import).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Never pass user-controllable input to child_process.exec/execSync/spawn with shell semantics. Use `execFile` (no shell) with a hardcoded program path, validate input against a strict allowlist, or invoke a typed library that doesn't shell out. If a shell is genuinely required, pass argv as an array and ensure the program path is a hardcoded constant.",
		fn: checkChildProcessExecUserInput,
		resultsPropName: "childProcessExecUserInput",
		content_keywords: ["child_process", "childProcess"],
	},
	{
		id: "mixed_sync_async_file_api",
		phase: "pre_block",
		name: "Mixed Sync/Async File API",
		description:
			"Detects function bodies mixing `fs.*Sync` calls with `await fs.*` calls — almost always a partial migration bug.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Pick one API style for the whole function: either all sync (`readFileSync`, `writeFileSync`) or all async (`await readFile(...)`, `await writeFile(...)`). Mixing them inside one function blocks the event loop on the sync calls while the async ones make the function `async`, which is misleading to callers and almost never intended.",
		fn: checkMixedSyncAsyncFileApi,
		resultsPropName: "mixedSyncAsyncFileApi",
		content_keywords: ["Sync(", "fs."],
	},
	{
		id: "cookie_missing_security_flags",
		phase: "pre_block",
		name: "Cookie Missing Security Flags",
		description:
			"Detects `res.cookie(...)` / `cookies.set(...)` / `setHeader('Set-Cookie', ...)` calls without both `httpOnly: true` and `secure: true`. Session theft / fixation vector.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Set `{ httpOnly: true, secure: true, sameSite: \"lax\" }` on every cookie. `httpOnly` blocks JS access (XSS-defense); `secure` blocks plaintext-channel transmission. If you genuinely need a JS-readable cookie (e.g., CSRF double-submit), document the exception inline and keep `secure` on.",
		fn: checkCookieMissingSecurityFlags,
		resultsPropName: "cookieMissingSecurityFlags",
		content_keywords: ["cookie"],
	},
	{
		id: "logger_format_user_input",
		phase: "pre_block",
		name: "Logger Format String with User Input",
		description:
			"Detects `logger.<level>(req|ctx|input|user|params|body|query)` patterns — passing request-bound values as the format string is log-injection / log-poisoning.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Pass user-controllable values as structured arguments, never as the format string itself. `logger.info({ userInput }, \"received input\")` (pino-style) or `logger.info(\"received input: %s\", userInput)` keeps the message template static and the data structured. The current shape lets attackers inject newlines / forge log lines / break log parsers.",
		fn: checkLoggerFormatUserInput,
		resultsPropName: "loggerFormatUserInput",
		content_keywords: ["logger.", "log.", "console."],
	},
	{
		id: "ubs_marshal_load",
		phase: "pre_block",
		name: "Python marshal.load(s)",
		description:
			"Detects `marshal.load(...)` / `marshal.loads(...)`. The `marshal` module deserializes Python bytecode and arbitrary objects; passing untrusted bytes through it executes attacker-controlled code on import.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"The `marshal` module is for internal-use bytecode caches, not for data interchange. Switch to JSON (`json.loads`), msgspec, or a schema-validated deserializer if the input represents data. Never feed externally-sourced bytes to `marshal.load(s)` — there is no safe form.",
		fn: checkMarshalLoad,
		resultsPropName: "marshalLoad",
		content_keywords: ["marshal."],
	},
	{
		id: "ubs_shelve_open",
		phase: "pre_block",
		name: "Python shelve.open",
		description:
			"Detects `shelve.open(...)`. `shelve` is a pickle-backed persistent dict; opening one from an untrusted path or shared filesystem exposes the same arbitrary-code-execution surface as `pickle.load`.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Replace with a safe key-value store (sqlite via `sqlite3`, dbm.dumb, or a JSON-on-disk dict) that does not unpickle on read. If you control both the writer and the reader and the storage location is private to your process, document the trust boundary in a comment — but prefer the safer alternatives.",
		fn: checkShelveOpen,
		resultsPropName: "shelveOpen",
		content_keywords: ["shelve."],
	},
	{
		id: "ubs_yaml_unsafe_load",
		phase: "pre_block",
		name: "PyYAML unsafe load",
		description:
			"Detects PyYAML `yaml.load(...)` without a `Safe`-class Loader, plus the explicit `yaml.unsafe_load(...)` alias. Both construct arbitrary Python objects from `!!python/object` tags — RCE on adversarial YAML input.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"Use `yaml.safe_load(...)`. It accepts only the standard YAML types (dict, list, str, int, float, bool, None, datetime) and rejects the `!!python/...` constructors that the unsafe loaders honor. If you need typed objects, deserialize with `safe_load` first and validate the result against a schema (pydantic, msgspec, marshmallow) — never use a custom Loader that constructs arbitrary Python types.",
		fn: checkYamlUnsafeLoad,
		resultsPropName: "yamlUnsafeLoad",
		content_keywords: ["yaml.load", "yaml.unsafe_load"],
	},
	{
		// DW test-adoption P0.5 class-breadth (2026-07-17): the pytest `assert
		// (cond, "msg")` tautology. Zero-FP deterministic (flat parenthesized tuple
		// only) → pre_block/error.
		id: "ubs_python_assert_tautology",
		phase: "pre_block",
		name: "Python assert tautology",
		description:
			'Detects `assert (cond, "msg")` — the parentheses make a 2-tuple, which is always truthy, so the assertion NEVER fails (the author meant `assert cond, "msg"`). Function calls (`assert isinstance(x, int)`) and tuple comparisons (`assert (a, b) == c`) are not matched.',
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			'Drop the parentheses: `assert cond, "msg"`. As written the assertion tests a non-empty tuple, which is always true — it silently passes for every input, giving false confidence.',
		fn: checkPythonAssertTautology,
		resultsPropName: "pythonAssertTautology",
		content_keywords: ["assert"],
	},
	{
		id: "unawaited_async_assertion",
		phase: "pre_block",
		name: "Unawaited Async Assertion",
		description:
			"Detects a statement-position expect(...).rejects/.resolves chain in a test file with no leading await/return/void — the matcher promise floats, so the assertion never reports and the test silently passes regardless of behavior. Awaited, returned, void-prefixed, and assigned-then-awaited forms are exempt (zero-FP by construction on stripped, paren-balanced content).",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "error",
		pipeline: "agent_safety",
		fix_instruction:
			"An unawaited expect(...).rejects/.resolves chain is a floating promise — vitest/jest cannot fail the test when the matcher fails. Prefix it with await (inside an async test), or return it from the test callback. If the chain is stored first, await the stored promise before the test ends.",
		fn: detectUnawaitedAsyncAssertions,
		resultsPropName: "unawaitedAsyncAssertion",
		content_keywords: [".rejects", ".resolves"],
	},
];
