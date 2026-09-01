// ===========================================
// Verify tool-result types
// ===========================================
// Type-only module so other verify modules can depend on `CodeQualityIssue`
// and `CodeQualityResults` without pulling the full check implementation.

import type { CheckResult } from "../../harness/check-engine/index.js";

/** Public API — consumed by verify submodules. Re-alias for backward compatibility. */
export type DiagnosticResult = CheckResult;

/** Public API — consumed by verify submodules. */
export type AuditResult = import("../../harness/check-engine/types.js").AuditResult;

/** Public API — consumed by verify submodules. */
export interface CodeQualityIssue {
	check: string;
	file: string;
	line: number;
	message: string;
}

/**
 * Public API — consumed by verify submodules.
 *
 * One bucket per check. `runCodeQualityChecks` populates these, `outputJson`
 * formats them, and `streamCqSection` walks them for the human-readable
 * streaming output.
 */
export interface CodeQualityResults {
	strongTyping: CodeQualityIssue[];
	suppressions: CodeQualityIssue[];
	largeFiles: CodeQualityIssue[];
	/**
	 * Source files with NEITHER a companion test NOR line coverage at/above the
	 * threshold — the every-file-tested ratchet (`untested_files`). Current
	 * offenders are grandfathered in `.interlinked/untested-files-baseline.json`;
	 * see harness/tested-file-policy.ts. Default gate, report-only tier.
	 */
	untestedFiles: CodeQualityIssue[];
	jsonValidity: CodeQualityIssue[];
	phantomImports: CodeQualityIssue[];
	consoleStatements: CodeQualityIssue[];
	silentCatches: CodeQualityIssue[];
	testRegressions: CodeQualityIssue[];
	undocumentedEnvVars: CodeQualityIssue[];
	mockDrift: CodeQualityIssue[];
	incompleteRenames: CodeQualityIssue[];
	missingReturnTypes: CodeQualityIssue[];
	noTestFile: CodeQualityIssue[];
	complexity: CodeQualityIssue[];
	exportRipple: CodeQualityIssue[];
	deadExports: CodeQualityIssue[];
	deadTypeExports: CodeQualityIssue[];
	duplicateTypeDeclaration: CodeQualityIssue[];
	circularImports: CodeQualityIssue[];
	untestedInversePair: CodeQualityIssue[];
	untestedIdempotent: CodeQualityIssue[];
	lifecycleCleanup: CodeQualityIssue[];
	defaultExport: CodeQualityIssue[];
	codeClones: CodeQualityIssue[];
	// Agent safety checks
	misusedPromises: CodeQualityIssue[];
	floatingPromises: CodeQualityIssue[];
	broadObjectTypes: CodeQualityIssue[];
	booleanTrap: CodeQualityIssue[];
	positionalOptionalBoolean: CodeQualityIssue[];
	manyOptionalParams: CodeQualityIssue[];
	sameTypedPrimitiveParams: CodeQualityIssue[];
	// Comment-vs-behavior drift detectors (Mythos Phase 2 verify-side wiring).
	commentClaimsLimitNoGuard: CodeQualityIssue[];
	commentClaimsNullThrowsInstead: CodeQualityIssue[];
	commentClaimsValidationMissing: CodeQualityIssue[];
	commentClaimsIdempotentMutates: CodeQualityIssue[];
	commentClaimsThrowsDoesnt: CodeQualityIssue[];
	iteratorInvalidation: CodeQualityIssue[];
	freshCollectionKeyLookup: CodeQualityIssue[];
	discriminatedUnionExhaustiveness: CodeQualityIssue[];
	indexBoundsUnchecked: CodeQualityIssue[];
	cleanupSkippedOnEarlyExit: CodeQualityIssue[];
	taintedToPrivilegedSink: CodeQualityIssue[];
	awaitStateToctou: CodeQualityIssue[];
	cleanupReentrancy: CodeQualityIssue[];
	boundaryCopyNoRevalidation: CodeQualityIssue[];
	magicLiteralInConditional: CodeQualityIssue[];
	/** NaN-from-coercion used unguarded in a relational comparison (fail-open). */
	nanCoercionGuard: CodeQualityIssue[];
	/** expect(...).rejects/.resolves chain not awaited/returned in a test (silently-passing test). */
	unawaitedAsyncAssertion: CodeQualityIssue[];
	/** AI-generated design "tells" in frontend files (overused fonts, accent stripes, gradient text, AI palettes, bounce easing, gray-on-color, broken images, copy tells). */
	designSlop: CodeQualityIssue[];
	/** Array#push()/unshift() return value (the new length) returned, bound, or arrow-returned. */
	arrayPushReturnUsed: CodeQualityIssue[];
	/** parseInt passed bare as a .map()/.flatMap()/Array.from iteratee (index → radix). */
	arrayIterateeVariadicBuiltin: CodeQualityIssue[];
	/** writeFile-family / createWriteStream on a nested path with no prior mkdir-recursive / existsSync guard. */
	writeWithoutMkdir: CodeQualityIssue[];
	/** Write-family calls whose path derives from the user's real home directory. */
	homedirWriteEscape: CodeQualityIssue[];
	/** Bare numeric literal duplicating a same-file named policy constant. */
	duplicatedPolicyConstant: CodeQualityIssue[];
	typePredicateDrift: CodeQualityIssue[];
	/** Snapshot-review artifact (*.snap.new / *.pending-snap) written — never commit. */
	snapshotHygiene: CodeQualityIssue[];
	/** Raw hook-payload contract field read in one casing with no other-casing fallback. */
	payloadFieldCasing: CodeQualityIssue[];
	anonymousRegistration: CodeQualityIssue[];
	/** Verify-only: file-write to a path excluded by .gitignore (no `!` carve-out). */
	gitignoredWrittenConfig: CodeQualityIssue[];
	propertyTestCandidate: CodeQualityIssue[];
	halsteadDifficulty: CodeQualityIssue[];
	/** Verify-only: markdown `npm run <script>` / `npm test` referencing a script absent from package.json. */
	readmeScriptDrift: CodeQualityIssue[];
	/** Verify-only: present-tense claim that a path exists in-repo when the working tree lacks it (Sol D-3). */
	specPathRef: CodeQualityIssue[];
	/** Numeric constant whose own comment confesses it is a temporary stand-in (Bun #31503 class). */
	placeholderRuntimeConstant: CodeQualityIssue[];
	/** Rust `unsafe { ... }` block spanning >5 nonblank interior lines (78% of Bun's post-port unsafe blocks are one line). */
	rustUnsafeSpan: CodeQualityIssue[];
	/** Block-form eslint-disable → eslint-enable region spanning >10 lines. */
	suppressionBlockSpan: CodeQualityIssue[];
	asyncPromiseExecutor: CodeQualityIssue[];
	selfImports: CodeQualityIssue[];
	extraneousDeps: CodeQualityIssue[];
	nonNullAssertions: CodeQualityIssue[];
	evalUsage: CodeQualityIssue[];
	innerHtml: CodeQualityIssue[];
	nanComparison: CodeQualityIssue[];
	constantCondition: CodeQualityIssue[];
	unsafeOptionalChaining: CodeQualityIssue[];
	numberPrecisionLoss: CodeQualityIssue[];
	throwLiteral: CodeQualityIssue[];
	promiseRejectNonError: CodeQualityIssue[];
	rawControlBytes: CodeQualityIssue[];
	lossyErrorRethrow: CodeQualityIssue[];
	importFromOwnBarrel: CodeQualityIssue[];
	errorDispatchByInstanceof: CodeQualityIssue[];
	silentPromiseSwallow: CodeQualityIssue[];
	requireAwait: CodeQualityIssue[];
	accumulatingSpread: CodeQualityIssue[];
	manualFieldCopy: CodeQualityIssue[];
	// 13 additional agent safety checks
	excessiveUseState: CodeQualityIssue[];
	dangerouslySetInnerHtml: CodeQualityIssue[];
	directDomAccess: CodeQualityIssue[];
	inlineObjectProps: CodeQualityIssue[];
	asyncEventHandler: CodeQualityIssue[];
	nestedTernaries: CodeQualityIssue[];
	catchAndLog: CodeQualityIssue[];
	jsonParseUnsafe: CodeQualityIssue[];
	unvalidatedJsonBoundary: CodeQualityIssue[];
	hardcodedTimeout: CodeQualityIssue[];
	disabledTests: CodeQualityIssue[];
	placeholderTest: CodeQualityIssue[];
	suppressionHygiene: CodeQualityIssue[];
	targetBlankNoRel: CodeQualityIssue[];
	snapshotOveruse: CodeQualityIssue[];
	testImportingTest: CodeQualityIssue[];
	// 5 additional agent safety checks
	excessiveUseEffect: CodeQualityIssue[];
	sequentialAwaits: CodeQualityIssue[];
	indexAsKey: CodeQualityIssue[];
	missingEffectCleanup: CodeQualityIssue[];
	overMocking: CodeQualityIssue[];
	// Coding-agent feedback checks
	focusedTests: CodeQualityIssue[];
	migrationOrdering: CodeQualityIssue[];
	sqlSchemaConsistency: CodeQualityIssue[];
	visibilityFilterMissing: CodeQualityIssue[];
	// PII detection
	piiDetection: CodeQualityIssue[];
	// Taste checks (sourced from Robert C. Martin's essays)
	assertionFreeTest: CodeQualityIssue[];
	tautologicalAssertion: CodeQualityIssue[];
	mockingTheSut: CodeQualityIssue[];
	privateMemberTestAccess: CodeQualityIssue[];
	loopNestingDepth: CodeQualityIssue[];
	elseIfChain: CodeQualityIssue[];
	duplicateSwitchDiscriminant: CodeQualityIssue[];
	hybridClass: CodeQualityIssue[];
	fuzzyResponsibilityName: CodeQualityIssue[];
	lawOfDemeter: CodeQualityIssue[];
	flagArgument: CodeQualityIssue[];
	commentedOutCode: CodeQualityIssue[];
	// AI test-smell checks
	conditionalInTest: CodeQualityIssue[];
	nonDeterministicTest: CodeQualityIssue[];
	/** Fixed `await sleep(N)` before an assertion — passes idle, fails under load. */
	timingFlake: CodeQualityIssue[];
	emptyCatch: CodeQualityIssue[];
	testWithoutDescription: CodeQualityIssue[];
	assertionRoulette: CodeQualityIssue[];
	magicNumber: CodeQualityIssue[];
	// Structural checks
	functionArgCount: CodeQualityIssue[];
	dataClump: CodeQualityIssue[];
	duplicateDescribe: CodeQualityIssue[];
	// Verify-parity: project-wide scans (static equivalents of PostToolUse checks)
	crossFileSwitchDiscriminant: CodeQualityIssue[];
	singleImplementationInterface: CodeQualityIssue[];
	filesWithoutTest: CodeQualityIssue[];
	projectLocRatio: CodeQualityIssue[];
	/** CRAP (Change Risk Anti-Patterns) — comp² · (1 − cov)³ + comp. Advisory. */
	crap: CodeQualityIssue[];
	// === UBS Plan 04 — rows 27–30 ===
	/** Row 27: `==` / `!=` in JS/TS (allows `x == null` idiom). */
	jsLooseEquality: CodeQualityIssue[];
	/** Row 28: `===` / `!==` against a non-IEEE-safe float literal. */
	floatEquality: CodeQualityIssue[];
	/** Row 29: Java `Optional<T>....get()` without an isPresent/orElse guard. */
	javaOptionalGet: CodeQualityIssue[];
	/** Bun Rust-port class: `debug_assert*` arguments whose side effects disappear in release. */
	rustDebugAssertSideEffect: CodeQualityIssue[];
	/** C sibling: `assert(...)` side effects erased under -DNDEBUG. */
	cAssertSideEffect: CodeQualityIssue[];
	/** Python sibling: `assert` operand side effects stripped under `python -O`. */
	pythonAssertSideEffect: CodeQualityIssue[];
	/** Java sibling: `assert` side effects never run without `-ea` (JVM default OFF). */
	javaAssertSideEffect: CodeQualityIssue[];
	/** Rust byte-buffer reinterpret with no length/alignment proof — cast_slice panics on odd byteLength (Bun #31188). */
	rustUncheckedCastSlice: CodeQualityIssue[];
	/** JS/TS typed-array view over an ArrayBuffer with no byteLength % BYTES_PER_ELEMENT guard (Bun #31188 class). */
	unalignedReinterpret: CodeQualityIssue[];
	/** Row 30: `expr / identifier` — divisor might be zero (advisory). */
	divisionByVariable: CodeQualityIssue[];
	// === UBS Plan 04 — rows 22–26 (critical-tier) ===
	/** Row 22: Mutex<T>...lock().unwrap() in Rust — panics on poisoned mutex. */
	mutexLockUnwrap: CodeQualityIssue[];
	/** Row 23: subprocess.<fn>(..., shell=True) in Python — command injection. */
	subprocessShellTrue: CodeQualityIssue[];
	/** Row 24: TLS verification disabled (verify=False / InsecureSkipVerify / rejectUnauthorized). */
	tlsVerifyDisabled: CodeQualityIssue[];
	/** Row 25: `x == None` / `x != None` in Python — should be `is None`. */
	pyNoneEquality: CodeQualityIssue[];
	/** Row 26: MD5 / SHA-1 calls — broken hashes for security-bearing use. */
	weakHash: CodeQualityIssue[];
	// === Plan 04 D.1 partial — high-leverage backlog (security + Py) ===
	/** D.1.a: eval/Function/exec/compile invoked with a non-literal first arg. */
	evalInputTainted: CodeQualityIssue[];
	/** D.1.b: SQL keyword inside a quoted string with `+` / template-literal interpolation. */
	sqlStringConcat: CodeQualityIssue[];
	/** Effect §2.6: SQL library escape hatch (`sql.unsafe`/`raw`/`lit`) called with non-literal. */
	sqlEscapeHatchNonLiteral: CodeQualityIssue[];
	/** D.1.c: Python `def f(x=[])` / `def f(x={})` — mutable default shared across calls. */
	pyMutableDefaultArg: CodeQualityIssue[];
	// === Plan 04 D.1 backlog (17 of 20) ===
	/** D.1.4: Python tempfile.mktemp — TOCTOU race. */
	tempfileMktempRace: CodeQualityIssue[];
	/** D.1.5: pickle.load / pickle.loads — RCE on attacker-controlled bytes. */
	pickleUntrustedLoad: CodeQualityIssue[];
	/** D.1.6: xml.etree / xml.dom / xml.sax / lxml — XXE without defusedxml. */
	xmlExternalEntity: CodeQualityIssue[];
	/** D.1.7: os.system / os.popen with non-literal arg — command injection. */
	osSystemTainted: CodeQualityIssue[];
	/** D.1.8: C/C++ printf / sprintf / fprintf with non-literal format. */
	unsafeFormatString: CodeQualityIssue[];
	/** D.1.9: JS redirect(url) / location.href = url with non-literal URL. */
	uncheckedRedirect: CodeQualityIssue[];
	/** D.1.10: Go `go func()` without WaitGroup / errgroup. */
	goroutineNoWaitgroup: CodeQualityIssue[];
	/** D.1.11: Go `defer` inside a `for` loop. */
	deferInLoop: CodeQualityIssue[];
	/** D.1.12: `result += chunk` inside a loop in Py/Java/JS/Go — O(n²). */
	ubsStringConcatInLoop: CodeQualityIssue[];
	/** D.1.13: Java 3+ consecutive instanceof / compareTo lines. */
	numericComparisonChain: CodeQualityIssue[];
	/** D.1.14: console.log / print / fmt.Println in non-test, non-CLI code. */
	printDebugLeak: CodeQualityIssue[];
	/** D.1.15: dev-default loopback host literal baked into source outside test/config/example paths. */
	ubsHardcodedLocalhost: CodeQualityIssue[];
	/** D.1.16: 3+ digit numeric literals in expression context without named constant. */
	magicNumberNoConst: CodeQualityIssue[];
	/** D.1.17: function spanning 80+ body lines. */
	largeFunction: CodeQualityIssue[];
	/** D.1.18: 4+ levels of nested function/arrow callbacks. */
	deeplyNestedCallback: CodeQualityIssue[];
	/** D.1.19: JS toLocaleString / Java DateTimeFormatter.ofLocalized* without explicit locale. */
	timeFormatLocaleDep: CodeQualityIssue[];
	/** D.1.20: Python re.match / re.search / re.sub inside loop without re.compile. */
	regexInLoopNoCompile: CodeQualityIssue[];
	/** Phase 1: Node child_process.exec/execSync/spawn with non-literal first arg — RCE. */
	childProcessExecUserInput: CodeQualityIssue[];
	/** Phase 1: function bodies mixing fs.*Sync with await fs.* — partial migration bug. */
	mixedSyncAsyncFileApi: CodeQualityIssue[];
	/** Phase 1: cookie-set calls without httpOnly + secure flags — session theft vector. */
	cookieMissingSecurityFlags: CodeQualityIssue[];
	/** Phase 1: logger.<level>(<request-bound-ident>) — log-injection / format-string. */
	loggerFormatUserInput: CodeQualityIssue[];
	// === Batch 1: agent-laziness (11 entries) ===
	/** Agent thumbprint phrases ("for now", "in a real implementation", etc.) in comments. */
	agentThumbprintProse: CodeQualityIssue[];
	/** `throw new Error("not implemented")` and variants in non-test source. */
	stubNotImplementedThrow: CodeQualityIssue[];
	/** `if (true)` / `if (false)` literal branch conditions. */
	deadBranchLiteral: CodeQualityIssue[];
	/** ts-nocheck / eslint-disable (no rule list) / biome-ignore-all at file head. */
	fileLevelSuppression: CodeQualityIssue[];
	/** Inline Date.now / Math.random / crypto.randomUUID / new Date() in non-test source. */
	untestableTimeInSource: CodeQualityIssue[];
	/** `as unknown as Foo` double-cast escape hatch. */
	doubleCastUnknown: CodeQualityIssue[];
	/** `as T` cast where source type doesn't structurally overlap with target. */
	typeSmuggling: CodeQualityIssue[];
	/** `"a" | "b" | string` union widened with bare string. */
	unionWidenedWithString: CodeQualityIssue[];
	/** `process.env.NODE_ENV === "test"` (etc.) in production source. */
	nodeenvBranchInProd: CodeQualityIssue[];
	/** fetch() / axios without `signal:` / `timeout:` / AbortController. */
	fetchWithoutTimeout: CodeQualityIssue[];
	/** `Promise.all(<ident>.map(...))` on unbounded source array. */
	unboundedPromiseAll: CodeQualityIssue[];
	/** *Sync I/O calls inside HTTP handler / route / middleware files. */
	syncIoOnHotPath: CodeQualityIssue[];
	// === Batch 2: test-hygiene (6 entries) ===
	/** Duplicate it() / test() name strings within a single file. */
	duplicateTestNames: CodeQualityIssue[];
	/** Real network / filesystem calls inside test files (non-loopback / non-tmp). */
	realIoInTests: CodeQualityIssue[];
	/** Date.now / Math.random in test bodies without fake-timers / mocked clock. */
	testNondeterminism: CodeQualityIssue[];
	/** setTimeout / setImmediate with literal ms delays inside test bodies. */
	hardcodedTimeoutInTests: CodeQualityIssue[];
	/** Test files (foo.test.ts) that don't import their SUT. */
	testMissingSutImport: CodeQualityIssue[];
	/** vi.mock / jest.mock targeting the file under test from inside its own test. */
	mockingTheSutSelf: CodeQualityIssue[];
	/** it() / test() spawning a known-slow subprocess with no explicit timeout. */
	testSubprocessDefaultTimeout: CodeQualityIssue[];
	// === Test-quality checks (2 entries) ===
	/** it() / test() blocks asserting only mock-call interactions, no value / state. */
	mockOnlyTest: CodeQualityIssue[];
	/** Test files with 3+ cases that never assert a failure path. */
	happyPathOnlyTest: CodeQualityIssue[];
	/** it()/test() blocks whose assertions never trace to a non-mocked SUT call/read. */
	introvertedTest: CodeQualityIssue[];
	/** Mutation-directed contract receipts and brittle white-box assertion surfaces. */
	testLegitimacy: CodeQualityIssue[];
	/** Test files using a `/proc/…` path as an unwritable-path fixture (hangs Linux CI). */
	procfsProbeInTest: CodeQualityIssue[];
	// === Batch 5: cross-file (4 entries) ===
	/** Handler-named functions with empty / no-op bodies. */
	emptyBodyHandler: CodeQualityIssue[];
	/** Listener registrations without paired cleanup. */
	listenerPairing: CodeQualityIssue[];
	/** Same-file Zod schema vs TS interface drift. */
	schemaTypeDrift: CodeQualityIssue[];
	/** Migration *_up.sql without paired *_down.sql. */
	migrationParity: CodeQualityIssue[];
	// === Batch 8: demo-data (3 entries) ===
	/** Fake-data signatures without `@demo-data:` directive. */
	demoDataUnmarked: CodeQualityIssue[];
	/** try { real API } catch { return literal } pattern. */
	silentDemoFallback: CodeQualityIssue[];
	/** Root layout imports demo runtime but doesn't render DemoBanner. */
	demoRuntimeMissingBanner: CodeQualityIssue[];
	/** Filler/mock data rendered into a user-facing UI surface. */
	placeholderDataInUi: CodeQualityIssue[];
	/** tsconfig*.json missing high-leverage strictness flags not implied by `strict: true`. */
	tsconfigStrictness: CodeQualityIssue[];
	// === Plan 04 D.2 (2026-05): pattern-parity expansion ===
	/** Python marshal.load(s) — pickle-equivalent RCE surface. */
	marshalLoad: CodeQualityIssue[];
	/** Python shelve.open — pickle-backed persistent dict. */
	shelveOpen: CodeQualityIssue[];
	/** PyYAML `yaml.load` without Safe loader / explicit `yaml.unsafe_load`. */
	yamlUnsafeLoad: CodeQualityIssue[];
	/** PyTorch torch.load without `weights_only=True`. */
	torchUnsafeLoad: CodeQualityIssue[];
	/** joblib.load / pandas.read_pickle / np.load(allow_pickle=True). */
	pickleWrapperLoad: CodeQualityIssue[];
	/** AES in ECB mode (Python / Node / Go shapes). */
	aesEcbMode: CodeQualityIssue[];
	/** Weak (non-crypto) RNG generating a security value — ubs_weak_random_security. */
	weakRandom: CodeQualityIssue[];
	/** Node deprecated createCipher / createDecipher (no IV). */
	nodeCreateCipher: CodeQualityIssue[];
	/** External `<script src>` without `integrity=` (SRI). */
	scriptWithoutSri: CodeQualityIssue[];
	/** Go exec.Command("sh"|"bash"|...) — shell-out injection. */
	goShellInjection: CodeQualityIssue[];
	/** GitHub Actions workflow injection — attacker-controlled github.event fields. */
	githubActionsInjection: CodeQualityIssue[];
	/** document.write / document.writeln — XSS sink + render-blocking. */
	documentWrite: CodeQualityIssue[];
	/** `.outerHTML =` assignment — XSS sink. */
	outerHtmlAssignment: CodeQualityIssue[];
	/** `.insertAdjacentHTML(...)` — XSS sink. */
	insertAdjacentHtml: CodeQualityIssue[];
	/** if/else or ternary whose branches are identical — the condition has no effect. */
	identicalConditionalBranches: CodeQualityIssue[];
	// === Phase B endpoint-security pack (2026-05) ===
	/** HTTP endpoint with no recognized auth middleware (per-framework heuristic). */
	endpointAuthMissing: CodeQualityIssue[];
	/** Handler reads a path param and uses it as a DB key with no auth-context predicate. */
	endpointIdorShape: CodeQualityIssue[];
	/** DB query inside a handler that omits every configured tenant column. */
	endpointMissingTenantFilter: CodeQualityIssue[];
	/** Handler reads a URL-shaped value and fetches it without an allow-list sanitizer. */
	endpointSsrfShape: CodeQualityIssue[];
	/** Handler spreads request body into a model create/update without an allowlist. */
	endpointMassAssignment: CodeQualityIssue[];
}

// `CQ_RESULT_KEYS` and `emptyResults` were split into
// `tool-results-types-keys.ts` to keep this module under the file-size cap.
// Re-exported here so importers of the public module path are unaffected.
export { CQ_RESULT_KEYS, emptyResults } from "./tool-results-types-keys.js";
