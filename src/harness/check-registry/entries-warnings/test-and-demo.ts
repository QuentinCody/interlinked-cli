// Batch 2/5/8 warning entries: test-hygiene checks (duplicate names, real I/O
// in tests, nondeterminism, performative tests), cross-file structural checks
// (empty handlers, listener pairing, schema/type drift, migration parity), and
// demo-data leak detectors. Extracted from entries-warnings.ts — re-exported
// there as part of WARNING_ENTRIES.

import {
	checkDemoDataUnmarked,
	checkDemoRuntimeMissingBanner,
	checkDuplicateTestNames,
	checkEmptyBodyHandler,
	checkHappyPathOnlyTest,
	checkHardcodedTimeoutInTests,
	checkIntrovertedTest,
	checkListenerPairing,
	checkManualFieldCopy,
	checkMigrationParity,
	checkMockingTheSutSelf,
	checkMockOnlyTest,
	checkPlaceholderDataInUi,
	checkPlaceholderTests,
	checkRealIoInTests,
	checkSchemaTypeDrift,
	checkSilentDemoFallback,
	checkTestMissingSutImport,
	checkTestLegitimacy,
	checkTestNondeterminism,
	checkTestSubprocessDefaultTimeout,
} from "../../generic-checks.js";
import { detectProcfsProbeInTest } from "../../checks/procfs-probe.js";
import type { CheckRegistration } from "../types.js";

export const TEST_AND_DEMO_ENTRIES: CheckRegistration[] = [
	// ========================================================================
	// Batch 2: test-hygiene checks (6 entries)
	// ========================================================================
	{
		id: "duplicate_test_names",
		phase: "pre_warn",
		name: "Duplicate Test Names",
		description:
			"Detects two `it()` / `test()` / `specify()` blocks with identical name strings within the same file — copy-paste-then-edit-half-of-it bug class.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Two test blocks share the same name. Either the second is a stale copy that should be deleted, or the assertions diverged and one of them needs a more specific name describing what makes it different. Reporters list both runs under the same name, so a regression in either one reads as ambiguous.",
		fn: checkDuplicateTestNames,
		resultsPropName: "duplicateTestNames",
	},
	{
		id: "real_io_in_tests",
		phase: "pre_warn",
		name: "Real Network / Filesystem in Tests",
		description:
			"Detects fetch / axios / http.request to a non-loopback URL or *Sync writes to non-tmp paths inside test files.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Tests that hit the real network or real filesystem are flaky and slow — and a real subprocess/fs/network call in a test can push it past a mutation runner's per-test dry-run cap (30s under Stryker here), which makes the whole file unmeasurable, not just slow. Mock the network with msw / nock / fetch-mock, and write only to os.tmpdir() / __fixtures__ / a memfs mock. Loopback (localhost / 127.0.0.1) is allowlisted for in-process test servers.",
		fn: checkRealIoInTests,
		resultsPropName: "realIoInTests",
	},
	{
		id: "test_nondeterminism",
		phase: "pre_warn",
		name: "Test Nondeterminism",
		description:
			"Detects Date.now / new Date() / Math.random / crypto.randomUUID / performance.now in test bodies without vi.useFakeTimers / equivalent mocking.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Tests that read the real clock / RNG flake under any timing or seed change. Replace Date.now / new Date() with vi.setSystemTime / a stubbed clock, and Math.random / crypto.randomUUID with a seeded RNG. If the file uses vi.useFakeTimers() at the top level, the check is suppressed for the whole file. Real-clock waits also slow the test under load — enough to breach a mutation runner's per-test dry-run cap (30s under Stryker here), which makes the whole file unmeasurable.",
		fn: checkTestNondeterminism,
		resultsPropName: "testNondeterminism",
	},
	{
		id: "hardcoded_timeout_in_tests",
		phase: "pre_warn",
		name: "Hardcoded Timeout in Tests",
		description:
			"Detects `setTimeout(_, NNNN)` / `setImmediate(_, NNNN)` waits with non-zero literal millisecond delays inside test bodies — \"I gave up debugging the timing condition\" tell.",
		tier: 2,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A literal millisecond wait is almost always wrong: too short and it flakes, too long and CI gets slow. Use `vi.waitFor(predicate)` / `await waitForElementToBeRemoved(...)` / poll a deterministic predicate. `setTimeout(_, 0)` is allowlisted because it's a microtask flush, not a wait.",
		fn: checkHardcodedTimeoutInTests,
		resultsPropName: "hardcodedTimeoutInTests",
	},
	{
		id: "test_missing_sut_import",
		phase: "pre_warn",
		name: "Test Missing SUT Import",
		description:
			"Detects test files (`foo.test.ts`) that don't import their SUT (`./foo` / `../foo`). Strong signal the test is performative — not actually exercising what its name claims.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"`foo.test.ts` should import `./foo` (or a parent-dir variant) so that the test exercises real code from the SUT. If the test is testing a different file, rename it (e.g., `something-else.test.ts`); if the SUT lives elsewhere, fix the import path. As written, the test claims to cover code it doesn't touch.",
		fn: checkTestMissingSutImport,
		resultsPropName: "testMissingSutImport",
	},
	{
		id: "mocking_the_sut_self",
		phase: "pre_warn",
		name: "Mocking the SUT in Its Own Test",
		description:
			"Detects `vi.mock(\"./foo\")` / `jest.mock(\"./foo\")` inside `foo.test.ts` where the relative path resolves to the SUT itself.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A test that mocks its own SUT is testing the mock, not the code. Either remove the `vi.mock(./foo)` and let the real implementation run, or rename the test file (e.g., `foo-integration.test.ts`) so it's clearly testing the contract some other consumer has with `./foo`. Mocking `./foo` inside `foo.test.ts` is almost always the agent silencing a failing test rather than fixing it.",
		fn: checkMockingTheSutSelf,
		resultsPropName: "mockingTheSutSelf",
	},
	{
		id: "test_subprocess_default_timeout",
		phase: "post",
		name: "Test Spawns Slow Subprocess Without Timeout",
		description:
			"Detects `it()` / `test()` callbacks that spawn a known-slow subprocess (tsc, biome, npx, tsx, eslint, vitest, the project CLI) via node:child_process exec/spawn primitives with no explicit `timeout` — neither the `{ timeout: N }` options-object form nor a trailing numeric-timeout argument.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A test that shells out to tsc / biome / npx / tsx / eslint / vitest / the CLI but relies on the default `testTimeout` flakes under CI's worker cap — a cold tsc start alone can exceed the 10s default. Pass an explicit timeout via the vitest options object: `it(name, { timeout: 60_000, retry: 2 }, fn)`. The trailing-numeric form `it(name, fn, 60_000)` also works. Match the established pattern in write.test.ts / verify.test.ts. Real subprocess spawns also breach a mutation runner's per-test dry-run cap under load (30s under Stryker here) — that times out the dry run and makes the whole file unmeasurable, so prefer mocking the spawn where the subprocess is not the thing under test.",
		fn: checkTestSubprocessDefaultTimeout,
		resultsPropName: "testSubprocessDefaultTimeout",
	},
	// checkPlaceholderTests existed (exported from generic-checks.js, wired into
	// interlinked verify's file-checks-react-test.ts, and named in modes.ts'
	// STRICT.check_overrides) but was never a CHECK_REGISTRY entry — so no
	// PostToolUse/pre_block gate, no PreToolUse write-gate, and no
	// evidence-contract coverage ever ran it. `phase: pre_block` is what
	// STRICT.check_overrides' `placeholder_test: "ask"` line actually needed —
	// registering it here restores the blocking behavior its siblings
	// (disabled_tests, focused_tests, assertion_free_test, tautological_assertion)
	// already have. `severity: warning` (not "error" like those siblings, which
	// live in a different registry file) matches this file's own
	// TEST_AND_DEMO_ENTRIES test contract, which asserts every entry here is
	// "warning" — blocking is governed by phase, not severity, so this loses
	// nothing.
	{
		id: "placeholder_test",
		phase: "pre_block",
		name: "Placeholder Test",
		description:
			"Detects `.todo` blocks, pending single-arg `it(\"name\")` calls, and empty or TODO/FIXME-marker-only test bodies — stub tests that contribute zero coverage while reading as done.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			'Write the real test body, or delete the placeholder. `it.todo("name")` and `it("name")` with no callback run nothing; an empty or TODO/FIXME-only body passes trivially and never kills a mutant.',
		fn: checkPlaceholderTests,
		resultsPropName: "placeholderTest",
	},
	// ========================================================================
	// Test-quality checks (2 entries)
	// ========================================================================
	{
		id: "mock_only_test",
		phase: "pre_warn",
		name: "Mock-Only Test",
		description:
			"Detects it() / test() blocks whose every assertion is a call-interaction matcher (toHaveBeenCalled* / toHaveReturned*) with no assertion on a return value, output, or state — a change-detector that verifies the call was made, not the behavior. Blocks whose call assertions are all negated (only `not.toHaveBeenCalled()`) are exempt.",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This test asserts only that a mock/spy was called — never that the code produced a correct value, output, or observable state, so it passes even when the behavior is wrong (it restates the call you wrote). Add an assertion on a return value, the rendered output, or post-state. `not.toHaveBeenCalled()` on its own is fine — asserting a call did NOT happen is a real guarantee; asserting it DID happen with no value check is not.",
		fn: checkMockOnlyTest,
		resultsPropName: "mockOnlyTest",
	},
	{
		id: "happy_path_only_test",
		phase: "post",
		name: "Happy-Path-Only Test File",
		description:
			"Detects test files with 3+ cases that never assert a failure path — no `.not.*`, toThrow, `.rejects`, false/null/undefined assertion, error-handling case, or failure-named test/describe block.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			'Every test in this file asserts a success outcome — nothing exercises a failure path. A suite that can only observe success still passes when a regression breaks the error path, so it gives false confidence. Add at least one negative case: an invalid input, a thrown error, a rejected promise, or an assertion that something did NOT happen. Naming one test for the failure it covers (e.g. "rejects malformed input") also clears the check.',
		fn: checkHappyPathOnlyTest,
		resultsPropName: "happyPathOnlyTest",
	},
	{
		id: "introverted_test",
		phase: "post",
		name: "Introverted Test",
		description:
			"Detects it() / test() blocks whose every assertion traces only to a literal, a test-local value, or a MOCKED symbol — never to a non-mocked system-under-test call/read. Static AST dataflow beneath mock_only_test / test_missing_sut_import (which check matcher KIND and the IMPORT); an introverted test is a guaranteed mutation survivor for the SUT it names.",
		tier: 2,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"This test's assertions are decoupled from the code under test — they check a literal, test-local data, or a mock's return value, so the test stays green even if the SUT is broken (it cannot kill a mutant). Assert on a value RETURNED BY (or state CHANGED BY) a real call into the SUT; if you must mock a dependency, still assert on the SUT's own output, not the mock's. Tests with no single SUT import, or that reach the SUT only through an unresolved helper, are deliberately not flagged.",
		fn: checkIntrovertedTest,
		resultsPropName: "introvertedTest",
		content_keywords: ["expect", "assert"],
	},
	{
		id: "test_legitimacy",
		phase: "pre_warn",
		name: "Test Legitimacy",
		description:
			"Requires each mutation-directed test case to cite a public API, invariant, bug, security property, or boundary contract, and flags broad truthiness, incidental call-order assertions, and explicitly private/internal imports in JS/TS tests.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Ground each mutation-directed case with `// test-contract: <public-api|invariant|bug|security|boundary> — <specific reference or rationale>` immediately before the case. Prefer an exported/public surface and observable value or state. Replace broad truthiness and incidental call-order checks with precise behavioral assertions unless that exact shape is itself a documented contract.",
		fn: checkTestLegitimacy,
		resultsPropName: "testLegitimacy",
		content_keywords: ["test", "it", "specify", "expect", "import", "require"],
	},
	{
		id: "procfs_probe_in_test",
		phase: "post",
		name: "Procfs Probe in Test",
		description:
			"Detects a test file using a `/proc/…` path as an \"unwritable path\" fixture. Recursive mkdir under /proc does not throw on Linux — it spins forever, hanging the test worker until the CI job times out (four such probes hung this repo's ubuntu unit lane for 25 minutes apiece in 2026-07). Only a string literal whose whole value is an absolute procfs path counts, comments are masked first, and well-known informational files (/proc/cpuinfo and friends) are exempt on exact match, so hazard comments, prose and legitimate platform probes stay silent.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			'This fixture hangs Linux CI: recursive mkdir under /proc never returns, so the test worker spins until the job times out (it passes locally because macOS has no /proc). Nest the fixture under a regular FILE instead — `const f = join(root, "not-a-directory"); writeFileSync(f, "x");` then use `join(f, "nested")` — which yields ENOTDIR immediately on every platform. If you are genuinely READING an informational procfs file (/proc/cpuinfo, /proc/meminfo, …), use its exact path; anything nested below it is treated as a directory probe.',
		fn: detectProcfsProbeInTest,
		resultsPropName: "procfsProbeInTest",
		content_keywords: ["/proc"],
	},
	// ========================================================================
	// Batch 5: cross-file (4 entries; new-export orphan deferred)
	// ========================================================================
	{
		id: "empty_body_handler",
		phase: "post",
		name: "Empty-Body Handler",
		description:
			"Detects functions whose name implies request handling (handle*, route*, on[A-Z]*, HTTP-verb-named) with empty bodies, single `return;`, or only a console.log / logger call.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The function declares an API surface that does nothing. Either implement the body, throw a typed `MethodNotImplementedError(\"<name>\")` so callers fail fast, or rename the function so it doesn't claim to handle work it doesn't.",
		fn: checkEmptyBodyHandler,
		resultsPropName: "emptyBodyHandler",
	},
	{
		id: "listener_pairing",
		phase: "post",
		name: "Listener Pairing (Generalized)",
		description:
			"Detects addEventListener / process.on / emitter.on calls without a paired removeEventListener / off / removeListener anywhere in the same file.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Listeners outlive the registering scope when nothing removes them. Store the handler in a variable and pair the registration with the matching off / removeListener / removeEventListener in a teardown path (cleanup function, dispose, signal abort handler).",
		fn: checkListenerPairing,
		resultsPropName: "listenerPairing",
	},
	{
		id: "schema_type_drift",
		phase: "post",
		name: "Schema ↔ Type Drift",
		description:
			"Detects same-file Zod / valibot / yup schemas paired with TS interfaces / type aliases whose property sets diverge.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The runtime validator and the static type are supposed to agree about the shape — when they drift, callers see one truth and the runtime enforces a different one. Derive one from the other: `type User = z.infer<typeof UserSchema>` (Zod's recommended pattern) so the two cannot drift.",
		fn: checkSchemaTypeDrift,
		resultsPropName: "schemaTypeDrift",
	},
	{
		id: "migration_parity",
		phase: "post",
		name: "Migration Parity",
		description:
			"Detects `*_up.sql` files in migration directories without a paired `*_down.sql` — every up should be reversible.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Every migration should be reversible. Add the matching `_down.sql` (or a stub one with a TODO documenting why it's not safe to revert in this case). Without it, a botched deploy can't roll back without manual surgery.",
		fn: checkMigrationParity,
		resultsPropName: "migrationParity",
	},
	// ========================================================================
	// Batch 8: demo-data (3 entries)
	// ========================================================================
	{
		id: "demo_data_unmarked",
		phase: "post",
		name: "Unmarked Demo Data",
		description:
			"Detects fake/test data signatures (test emails @example.com, Stripe test cards, lorem ipsum, sentinel UUIDs, faker imports, mock/fake/sample identifier prefixes) that lack a `// @demo-data: <reason>` directive.",
		tier: 1,
		determinism: "partially_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Either remove the demo data and wire up the real source, or mark it explicitly with `// @demo-data: <reason>` directly above so cold readers (and the rendered UI) see that the value isn't real. For data that flows into a chart / list rendered to users, prefer wrapping with `demoData(\"<key>\", value, { reason })` from the vendored demo-runtime so the page mounts a banner.",
		fn: checkDemoDataUnmarked,
		resultsPropName: "demoDataUnmarked",
	},
	{
		id: "silent_demo_fallback",
		phase: "post",
		name: "Silent Demo Fallback",
		description:
			"Detects `try { real API call } catch { return [literal data] }` patterns — the worst form of demo-data leak because it silently substitutes fake data when the upstream is unavailable.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A catch clause that returns hardcoded data hides upstream failures from users — they see plausible results that aren't real. Either re-throw the error so the caller can show a real error state, return a typed `Result<Error, T>` so the UI can react, or wrap the literal in `demoData()` so the demo banner mounts when the fallback path runs.",
		fn: checkSilentDemoFallback,
		resultsPropName: "silentDemoFallback",
	},
	{
		id: "demo_runtime_missing_banner",
		phase: "post",
		name: "Demo Runtime Without Banner",
		description:
			"Detects root-layout files (app/layout.tsx, src/main.tsx, etc.) that import from `interlinked-cli/demo-runtime` (or a vendored sibling) but do not render <DemoBanner />. Without the banner, users see no signal that the page contains demo data.",
		tier: 1,
		determinism: "fully_deterministic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"The vendored demo-runtime expects `<DemoBanner />` to be mounted in the root layout so any `demoData()` value rendered in the page lifecycle triggers a visible banner. Add `<DemoBanner />` somewhere inside the root `<body>` (or its equivalent) so the runtime can announce when the user is looking at fake data.",
		fn: checkDemoRuntimeMissingBanner,
		resultsPropName: "demoRuntimeMissingBanner",
	},
	{
		id: "placeholder_data_in_ui",
		phase: "post",
		name: "Placeholder Data in UI",
		description:
			"Detects placeholder/mock/fake data rendered into a user-facing UI file (.tsx/.jsx/.vue/.svelte/.astro/.html) — hardcoded numbers a comment marks as fake, mock/fake/dummy-named values, lorem ipsum copy, placeholder image hosts, and placeholder-shaped numbers (1111, 123456). Suppressed when the rendered UI carries a visible 'sample data' disclaimer.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"A user will read this value as a real production figure. Fix it one of two ways: (1) wire it to real data — fetch from the API, pass real props, or read from the store; or (2) if the placeholder must stay (early prototype, pending integration), make its status unmistakable IN THE RENDERED UI — a visible 'Sample data' badge, a banner, or muted styling with an explicit label — so no human mistakes it for production. A code comment is not enough; the disclaimer has to be on screen. For values that flow into a chart or stat, prefer wrapping with `demoData(\"<key>\", value, { reason })` from the vendored demo-runtime so the page mounts a banner automatically.",
		fn: checkPlaceholderDataInUi,
		resultsPropName: "placeholderDataInUi",
	},
	{
		id: "manual_field_copy",
		phase: "post",
		name: "Manual Field Copy",
		description:
			"Detects a run of 5+ consecutive field copies target.k = source.k (matching key, same target + source objects) — hand-copying one object's fields onto another silently skips any field later added to the source.",
		tier: 2,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Hand-copying fields object-to-object (target.k = source.k, repeated) silently skips any field later added to the source — the bug class behind a builder that computes a field its caller forgets to forward. Use object spread ({ ...source }) or Object.assign(target, source) so the field set stays in sync. If the subset is deliberate, leave a comment saying so.",
		fn: checkManualFieldCopy,
		resultsPropName: "manualFieldCopy",
	},
];
