// Independent adversarial review (2026-10-21) of `ubs_subprocess_shell_true`,
// a pre_block check. Each negative case is legitimate Python the original
// 500-char `subprocess.X(... shell=True` window blocked. Probe:
// scratch/2026-10-21-adversarial/ubs_subprocess_shell_true.probe.mts.

import { describe, expect, it } from "vitest";
import { checkSubprocessShellTrue } from "../../checks/ubs-language-specific.js";

const lines = (...parts: string[]): string => parts.join("\n");

describe("ubs_subprocess_shell_true — negative (must not fire)", () => {
	it("N1: a multi-line docstring that mentions subprocess.run(cmd, shell=True)", () => {
		const code = lines(
			"def run(cmd):",
			'    """Run cmd safely.',
			"",
			"    Unlike subprocess.run(cmd, shell=True), this splits the",
			"    arguments with shlex and never invokes a shell.",
			'    """',
			"    return subprocess.run(shlex.split(cmd))",
		);
		expect(checkSubprocessShellTrue(code, "src/runner.py")).toEqual([]);
	});

	it("N2: a safe list call followed by an unrelated call carrying shell=True", () => {
		const code = lines(
			'proc = subprocess.run(["git", "status"], check=True, capture_output=True)',
			"print(proc.stdout)",
			"runner = CommandRunner(shell=True, cwd=root)",
		);
		expect(checkSubprocessShellTrue(code, "src/build.py")).toEqual([]);
	});

	it("N3: a safe call followed by a def whose parameter default is shell=True", () => {
		const code = lines(
			"def git(*args):",
			'    return subprocess.run(["git", *args], check=True)',
			"",
			"",
			"def run_script(path, shell=True):",
			"    ...",
		);
		expect(checkSubprocessShellTrue(code, "src/x.py")).toEqual([]);
	});

	it("N4: shell=True passed to a nested helper inside the arguments", () => {
		const code = 'subprocess.run(["make"], env=build_env(shell=True), check=True)';
		expect(checkSubprocessShellTrue(code, "src/x.py")).toEqual([]);
	});

	it("N5: Bandit's native `# nosec B602` acknowledgment", () => {
		expect(checkSubprocessShellTrue("result = subprocess.run(cmd, shell=True)  # nosec B602", "src/t.py")).toEqual(
			[],
		);
	});

	it("N6: Bandit's bare `# nosec`", () => {
		expect(checkSubprocessShellTrue("result = subprocess.run(cmd, shell=True)  # nosec", "src/t.py")).toEqual([]);
	});

	it("N7: flake8's case-insensitive `# NOQA: S602`", () => {
		expect(checkSubprocessShellTrue("result = subprocess.run(cmd, shell=True)  # NOQA: S602", "src/t.py")).toEqual(
			[],
		);
	});

	it("N8: a fixed string-literal command with a pipe", () => {
		const code = 'subprocess.run("make -C docs html 2>&1 | tail -n 20", shell=True, check=True)';
		expect(checkSubprocessShellTrue(code, "docs/build.py")).toEqual([]);
	});

	it("N9: a raw-string literal command and a literal Popen pipeline", () => {
		expect(checkSubprocessShellTrue('subprocess.run(r"dir C:\\Users /b", shell=True)', "src/x.py")).toEqual([]);
		const popen = 'proc = subprocess.Popen("git log --oneline | head -n 5", shell=True, stdout=subprocess.PIPE)';
		expect(checkSubprocessShellTrue(popen, "scripts/release.py")).toEqual([]);
	});

	it("N10: the Windows clear-screen idiom with a literal list", () => {
		expect(checkSubprocessShellTrue('subprocess.call(["cls"], shell=True)', "src/cli.py")).toEqual([]);
	});

	it("N11: a module docstring example above a safe call", () => {
		const code = lines(
			'"""Helpers.',
			"",
			"Example::",
			"",
			"    subprocess.check_output(cmd, shell=True)  # bad",
			'"""',
			"import subprocess",
			"",
			"def ls():",
			'    return subprocess.check_output(["ls"])',
		);
		expect(checkSubprocessShellTrue(code, "src/x.py")).toEqual([]);
	});

	it("N12: a one-line string holding ''' does not mis-pair with a later docstring", () => {
		const code = lines(
			"QUOTE = \"'''\"",
			"def f():",
			"    '''Never subprocess.run(cmd, shell=True).'''",
			"    return 1",
		);
		expect(checkSubprocessShellTrue(code, "src/x.py")).toEqual([]);
	});
});

describe("ubs_subprocess_shell_true — positive (must fire)", () => {
	it("P1: an f-string command", () => {
		expect(checkSubprocessShellTrue('subprocess.run(f"rm -rf {path}", shell=True)', "src/x.py")).toHaveLength(1);
	});

	it("P2: a literal concatenated with a variable", () => {
		expect(checkSubprocessShellTrue('subprocess.run("rm -rf " + path, shell=True)', "src/x.py")).toHaveLength(1);
	});

	it("P3: %-formatting and .format on a literal", () => {
		expect(checkSubprocessShellTrue('subprocess.run("rm %s" % path, shell=True)', "src/x.py")).toHaveLength(1);
		expect(checkSubprocessShellTrue('subprocess.run("rm {}".format(p), shell=True)', "src/x.py")).toHaveLength(1);
	});

	it("P4: an unrelated Bandit id does not suppress", () => {
		expect(checkSubprocessShellTrue("subprocess.run(cmd, shell=True)  # nosec B301", "src/x.py")).toHaveLength(1);
	});

	it("P5: an `args=` kwarg identifier and a list with a variable element", () => {
		expect(checkSubprocessShellTrue("subprocess.run(args=cmd, shell=True)", "src/x.py")).toHaveLength(1);
		expect(checkSubprocessShellTrue('subprocess.run(["start", url], shell=True)', "src/x.py")).toHaveLength(1);
	});

	it("P6: a real call after a docstring that mentions the pattern", () => {
		const code = lines('def f(cmd):', '    """Uses shell=True."""', "    return subprocess.run(cmd, shell=True)");
		expect(checkSubprocessShellTrue(code, "src/x.py")).toEqual([
			{ line: 3, text: "return subprocess.run(cmd, shell=True)" },
		]);
	});
});
