// Independent adversarial review of the disabled_tests pre_block check
// (2026-10-21). Every negative here is a conditional skip, or a marker that
// is DATA (inside a string), that a reasonable reviewer accepts and the
// detector refused before the refinement in checks/test-skip-markers.ts.
// Probe: scratch/2026-10-21-adversarial/disabled_tests.probe.mts

import { describe, expect, it } from "vitest";
import { checkDisabledTests } from "../../checks/js-ts-general.js";

describe("disabled_tests — negative (must not fire)", () => {
	it("N1: Playwright conditional skip inside a test body — test.skip(condition, description)", () => {
		const code = [
			"import { test, expect } from '@playwright/test';",
			"test('settings page', async ({ page, isMobile }) => {",
			"  test.skip(isMobile, 'Settings page does not work in mobile yet');",
			"  await page.goto('/settings');",
			"});",
		].join("\n");
		expect(checkDisabledTests(code, "e2e/settings.spec.ts")).toEqual([]);
	});

	it("N2: Playwright conditional skip with a comparison, wrapped over two lines", () => {
		const code = [
			"test('plays video', async ({ page, browserName }) => {",
			"  test.skip(",
			"    browserName === 'webkit',",
			"    'no codec on webkit',",
			"  );",
			"});",
		].join("\n");
		expect(checkDisabledTests(code, "e2e/video.spec.ts")).toEqual([]);
	});

	it("N3: Go if-guard two lines above the t.Skip because of a comment in between", () => {
		const code = [
			"func TestWindowsOnly(t *testing.T) {",
			'\tif runtime.GOOS == "windows" {',
			"\t\t// Windows CI lacks the toolchain; tracked in #123.",
			'\t\tt.Skip("windows")',
			"\t}",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "pkg/foo_test.go")).toEqual([]);
	});

	it("N4: Go LookPath guard with a t.Logf before the t.Skip", () => {
		const code = [
			"func TestDocker(t *testing.T) {",
			'\tif _, err := exec.LookPath("docker"); err != nil {',
			'\t\tt.Logf("docker not found: %v", err)',
			'\t\tt.Skip("docker required")',
			"\t}",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "pkg/docker_test.go")).toEqual([]);
	});

	it("N5: Go switch/case platform guard and an else-branch skip", () => {
		const code = [
			"func TestPlatform(t *testing.T) {",
			"\tswitch runtime.GOOS {",
			'\tcase "plan9", "js":',
			'\t\tt.Skipf("unsupported on %s", runtime.GOOS)',
			"\t}",
			"\tif ok {",
			"\t\trun(t)",
			"\t} else {",
			'\t\tt.Log("no fixture")',
			'\t\tt.Skip("no fixture")',
			"\t}",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "pkg/plat_test.go")).toEqual([]);
	});

	it("N6: Python pytester.makepyfile source inside a triple-quoted string", () => {
		const code = [
			"def test_reports_skips(pytester):",
			"    pytester.makepyfile(",
			'        """',
			"        import pytest",
			"        @pytest.mark.skip(reason='fixture')",
			"        def test_x(): pass",
			'        """',
			"    )",
			"    result = pytester.runpytest()",
			"    result.assert_outcomes(skipped=1)",
		].join("\n");
		expect(checkDisabledTests(code, "tests/test_plugin.py")).toEqual([]);
	});

	it("N7: Python module docstring that mentions the marker", () => {
		const code = [
			'"""Integration tests.',
			"",
			"Do not use @pytest.mark.skip here; use the `needs_db` fixture instead.",
			'"""',
			"def test_a(): ...",
		].join("\n");
		expect(checkDisabledTests(code, "tests/test_markers.py")).toEqual([]);
	});

	it("N8: Rust #[ignore] inside a raw-string expected-expansion fixture", () => {
		const code = [
			"#[test]",
			"fn expands_ignored_case() {",
			'    let expected = r#"',
			"#[ignore]",
			"fn generated() {}",
			'"#;',
			"    assert_eq!(expand(input), expected);",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "tests/expand.rs")).toEqual([]);
	});

	it("N9: JS it.skip registered inside an if-block with an else branch", () => {
		const code = [
			"if (!process.env.DOCKER_HOST) {",
			"  it.skip('needs docker', () => {});",
			"} else {",
			"  it('needs docker', async () => { await run(); });",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "src/__tests__/docker.test.ts")).toEqual([]);
	});

	// ---- Round 2 (independent re-review) — refined in checks/test-skip-markers.ts ----
	it("N10: Go testenv-style require helper — early `return` when found, then t.Skip", () => {
		const code = [
			"func requireDocker(t *testing.T) {",
			"\tt.Helper()",
			'\tif _, err := exec.LookPath("docker"); err == nil {',
			"\t\treturn",
			"\t}",
			'\tt.Skip("docker not installed")',
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "internal/testenv/docker_test.go")).toEqual([]);
	});

	it("N11: Go if-condition wrapped over three lines before the opening brace", () => {
		const code = [
			"func TestWide(t *testing.T) {",
			'\tif runtime.GOOS == "windows" ||',
			'\t\truntime.GOOS == "plan9" ||',
			'\t\truntime.GOARCH == "wasm" {',
			'\t\tt.Skip("unsupported platform")',
			"\t}",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "pkg/plat_test.go")).toEqual([]);
	});

	it("N12: Python @unittest.skip inside a platform `if` block at class scope", () => {
		const code = [
			"class T(unittest.TestCase):",
			"    if sys.platform == 'win32':",
			"        @unittest.skip('no fork on windows')",
			"        def test_fork(self): ...",
			"    else:",
			"        def test_fork(self): self.assertTrue(fork_ok())",
		].join("\n");
		expect(checkDisabledTests(code, "tests/test_fork.py")).toEqual([]);
	});

	it("N13: JS prettier-wrapped multi-line `if (` condition around describe.skip", () => {
		const code = [
			"if (",
			"  process.platform === 'win32' &&",
			"  !process.env.CI",
			") {",
			"  describe.skip('posix perms', () => { it('a', () => {}); });",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "src/__tests__/w.test.ts")).toEqual([]);
	});

	// ---- Round 3 (resumed review) ----
	it("N14: JS braceless single-line `if (cond) it.skip(...)` with an else", () => {
		const code = [
			"const hasDocker = !!process.env.DOCKER_HOST;",
			"if (!hasDocker) it.skip('needs docker', () => {});",
			"else it('needs docker', async () => { await run(); });",
		].join("\n");
		expect(checkDisabledTests(code, "src/__tests__/d.test.ts")).toEqual([]);
	});

	it("N15: JS ternary at the call site — `isCI ? it.skip(...) : it(...)`", () => {
		const code = ["const isCI = !!process.env.CI;", "isCI ? it.skip('flaky on CI', fn) : it('flaky on CI', fn);"].join("\n");
		expect(checkDisabledTests(code, "src/__tests__/t.test.ts")).toEqual([]);
	});

	it("N16: JS braceless `if (cond)` header on the line above the describe.skip", () => {
		const code = [
			"if (process.platform === 'win32')",
			"  describe.skip('posix perms', () => { it('a', () => {}); });",
			"else",
			"  describe('posix perms', () => { it('a', () => {}); });",
		].join("\n");
		expect(checkDisabledTests(code, "src/__tests__/p.test.ts")).toEqual([]);
	});

	it("N17: Python decorator under a parenthesized multi-line `if (...):` header", () => {
		const code = [
			"class T(unittest.TestCase):",
			"    if (",
			"        sys.platform == 'win32'",
			"        and not HAS_WSL",
			"    ):",
			"        @unittest.skip('posix only')",
			"        def test_a(self): ...",
			"    else:",
			"        def test_a(self): self.assertTrue(True)",
		].join("\n");
		expect(checkDisabledTests(code, "tests/test_wsl.py")).toEqual([]);
	});
});

describe("disabled_tests — positive (must fire)", () => {
	it("P1: Playwright bare test.skip() inside a body is unconditional", () => {
		const code = ["test('a', async () => {", "  test.skip();", "});"].join("\n");
		expect(checkDisabledTests(code, "e2e/x.spec.ts").map((m) => m.line)).toEqual([2]);
	});

	it("P2: test.skip(true, 'reason') is unconditional", () => {
		const code = ["test('a', async () => {", "  test.skip(true, 'not now');", "});"].join("\n");
		expect(checkDisabledTests(code, "e2e/x.spec.ts").map((m) => m.line)).toEqual([2]);
	});

	it("P3: it.skip(title, fn) with a variable title is still a declared skip", () => {
		const code = ["describe('s', () => {", "  it.skip(title, () => {});", "});"].join("\n");
		expect(checkDisabledTests(code, "src/foo.test.ts").map((m) => m.line)).toEqual([2]);
	});

	it("P4: Go t.Skip directly in the test function and inside t.Run fires", () => {
		const code = [
			"func TestA(t *testing.T) {",
			'\tt.Skip("broken")',
			'\tt.Run("sub", func(t *testing.T) {',
			'\t\tt.Skip("also broken")',
			"\t})",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "pkg/a_test.go").map((m) => m.line)).toEqual([2, 4]);
	});

	it("P5: Python decorator outside any string still fires, after a docstring", () => {
		const code = ['"""Suite."""', "@pytest.mark.skip(reason='later')", "def test_a(): ..."].join("\n");
		expect(checkDisabledTests(code, "tests/test_a.py").map((m) => m.line)).toEqual([2]);
	});

	it("P6: Rust #[ignore] on a real test after a string literal still fires", () => {
		const code = ['const S: &str = "x";', "#[test]", "#[ignore]", "fn slow() {}"].join("\n");
		expect(checkDisabledTests(code, "src/lib.rs").map((m) => m.line)).toEqual([3]);
	});

	it("P7: a Go skip helper with no early return still fires", () => {
		const code = ["func skipBroken(t *testing.T) {", '\tt.Skip("broken")', "}"].join("\n");
		expect(checkDisabledTests(code, "pkg/h_test.go").map((m) => m.line)).toEqual([2]);
	});

	it("P8: a `return` only inside a nested Go func literal does not exempt the skip", () => {
		const code = [
			"func TestN(t *testing.T) {",
			"\thelper := func() int { return 1 }",
			"\t_ = helper",
			'\tt.Skip("broken")',
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "pkg/n_test.go").map((m) => m.line)).toEqual([4]);
	});

	it("P9: a JS it.skip after a CLOSED if-block still fires", () => {
		const code = ["if (process.env.X) {", "  setup();", "}", "it.skip('later', () => {});"].join("\n");
		expect(checkDisabledTests(code, "src/__tests__/c.test.ts").map((m) => m.line)).toEqual([4]);
	});

	it("P10: a Python decorator directly under `class` (not `if`) still fires", () => {
		const code = ["class T(unittest.TestCase):", "    @unittest.skip('later')", "    def test_a(self): ..."].join("\n");
		expect(checkDisabledTests(code, "tests/test_c.py").map((m) => m.line)).toEqual([2]);
	});

	it("P11: a Go t.Skip inside t.Run whose call wraps after `,` still fires", () => {
		const code = [
			"func TestR(t *testing.T) {",
			'\tt.Run("sub",',
			"\t\tfunc(t *testing.T) {",
			'\t\t\tt.Skip("broken")',
			"\t\t})",
			"}",
		].join("\n");
		expect(checkDisabledTests(code, "pkg/r_test.go").map((m) => m.line)).toEqual([4]);
	});
});
