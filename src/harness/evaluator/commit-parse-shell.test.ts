// Pins for the shell-semantic segmenter behind parseGitCommit / listGitInvocations
// (red-team 2026-10-21 round 2: a newline was not a separator and a leading
// `# note` line hid every following command).
import { describe, expect, it } from "vitest";
import { cdTargetOf, isGitBinary, leadingCommand, ScopedCwd, shellUnits, splitSegments } from "./commit-parse-shell.js";
import { shellSplit } from "./commit-parse-tokens.js";
import { listGitInvocations, parseGitCommit } from "./commit-parse.js";

const argvs = (cmd: string) => shellUnits(cmd).map((u) => u.argv.join(" "));

describe("shellUnits — positive (must surface the command)", () => {
	it("P1: a newline separates commands, and a comment line ends at its newline", () => {
		expect(argvs("# note\ngit commit -m x")).toEqual(["git commit -m x"]);
		expect(argvs("git add a\ngit update-ref refs/heads/main $C")).toEqual([
			"git add a",
			"git update-ref refs/heads/main $C",
		]);
	});

	it("P2: every separator splits outside quotes", () => {
		expect(argvs("a; b && c || d | e |& f & g")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
	});

	it("P3: a backslash-newline joins two lines into one command", () => {
		expect(argvs("git \\\n  commit \\\n  -m x")).toEqual(["git commit -m x"]);
	});

	it("P4: a heredoc body is skipped as data and the next line is a command", () => {
		expect(argvs("cat > f <<'EOF'\ngit commit -m inside\nEOF\ngit commit -m real")).toEqual([
			"cat",
			"git commit -m real",
		]);
		expect(argvs("cat <<-EOF\n\tgit commit\n\tEOF\ngit push")).toEqual(["cat", "git push"]);
	});

	it("P5: a heredoc fed to a shell is a program, and an unquoted body's substitutions run", () => {
		expect(argvs("bash <<'EOF'\ngit commit -m x\nEOF")).toEqual(["git commit -m x"]);
		expect(argvs("cat <<EOF\n$(git write-tree)\nEOF")).toEqual(["cat", "git write-tree"]);
	});

	it("P6: substitutions, backticks, subshells and process substitutions are recursed", () => {
		// The bare assignments that hold the substitutions run no command of their own.
		expect(argvs('T=$(git write-tree) && C=`git commit-tree "$T"`')).toEqual([
			"git write-tree",
			"git commit-tree $T",
		]);
		expect(argvs("(cd sub && git commit -m x)")).toEqual(["cd sub", "git commit -m x"]);
		expect(argvs('echo "msg $(git commit -m y)"')).toEqual(["git commit -m y", "echo msg $__SUBSTITUTION__"]);
		expect(argvs("diff <(git show HEAD:f) f")).toEqual(["git show HEAD:f", "diff $__SUBSTITUTION__ f"]);
	});

	it("P7: wrappers and inline programs are unwrapped", () => {
		for (const cmd of [
			"env -i FOO=1 git commit -m x",
			"command git commit -m x",
			"sudo -u me git commit -m x",
			"exec git commit -m x",
			"nice -n 5 git commit -m x",
			"timeout -s KILL 30 git commit -m x",
			"nohup time git commit -m x",
			"bash -c 'git commit -m x'",
			"sh -lc \"git commit -m x\"",
			"eval git commit -m x",
			"env -S 'git commit -m x'",
			"if true; then git commit -m x; fi",
			"! git commit -m x",
			"{ git commit -m x; }",
		]) {
			expect(argvs(cmd), cmd).toContain("git commit -m x");
		}
		expect(shellUnits("env -C sub git commit")[0]?.wrapperCwd).toBe("sub");
	});

	it("P8: redirections never reach argv", () => {
		expect(argvs("git commit -m x > out.txt 2>&1")).toEqual(["git commit -m x"]);
		expect(argvs("git commit -F - <<< 'msg' &>/dev/null")).toEqual(["git commit -F -"]);
	});

	it("preserves wrapper working directories through inline programs without leaking them", () => {
		expect(parseGitCommit('env -C other sh -c "git commit -m x"')?.cwd).toBe("other");
		expect(parseGitCommit('cd parent && env -C child sh -c "cd nested && git commit -m x"')?.cwd).toBe("parent/child/nested");
		expect(listGitInvocations('env -C other sh -c "git status"; git commit -m x').map((inv) => inv.cwd)).toEqual(["other", null]);
		expect(parseGitCommit("env -C other bash <<'EOF'\ngit commit -m x\nEOF")?.cwd).toBe("other");
	});
});

describe("shellUnits — negative (must not surface a command)", () => {
	it("N1: a comment, a quoted string, and a mid-word # are not commands", () => {
		expect(argvs("# git commit -m x")).toEqual([]);
		expect(argvs("echo 'git commit; git push'")).toEqual(["echo git commit; git push"]);
		expect(argvs("echo a#b")).toEqual(["echo a#b"]);
	});

	it("N2: a quoted-delimiter heredoc body, single-quoted substitutions, and arithmetic are data", () => {
		expect(argvs("cat <<'EOF'\n$(git commit -m x)\nEOF")).toEqual(["cat"]);
		expect(argvs("echo '$(git commit)'")).toEqual(["echo $(git commit)"]);
		expect(argvs("echo $((1 << 2))")).toEqual(["echo $__SUBSTITUTION__"]);
	});

	it("N3: `command -v git` and an unterminated heredoc run nothing", () => {
		expect(argvs("command -v git")).toEqual([]);
		expect(argvs("cat <<EOF\ngit commit -m x")).toEqual(["cat"]);
	});
});

// The blessed splitSegments (shell-structure.ts contract) is the SAME scan, so it
// keeps every shell rule above. Each slice is a substring of the command.
describe("splitSegments — positive (must separate the commands)", () => {
	it("P10: ; && || | & split outside quotes, and an empty `;;` segment is dropped", () => {
		expect(splitSegments("git status; git commit -m x")).toEqual(["git status", " git commit -m x"]);
		expect(splitSegments("cd x && git commit -m y")).toEqual(["cd x ", " git commit -m y"]);
		expect(splitSegments("git add . || git commit -m y")).toEqual(["git add . ", " git commit -m y"]);
		expect(splitSegments("git status;;git commit -m x")).toEqual(["git status", "git commit -m x"]);
		expect(splitSegments("left&right|final")).toEqual(["left", "right", "final"]);
	});

	it("P11: a newline separates, and a # comment is cut at a word start and ends at its newline", () => {
		expect(splitSegments("# note\ngit commit -m x")).toEqual(["git commit -m x"]);
		expect(splitSegments("git add a\ngit commit -m x")).toEqual(["git add a", "git commit -m x"]);
		expect(splitSegments("true # note\ngit commit -m x")).toEqual(["true ", "git commit -m x"]);
	});

	it("P12: a heredoc body is data, and the command after its delimiter is a segment", () => {
		expect(splitSegments("cat > f <<'EOF'\ngit commit -m inside\nEOF\ngit commit -m real")).toEqual([
			"cat > f <<'EOF'",
			"git commit -m real",
		]);
	});

	it("P13: a backslash-newline keeps one command, and shellSplit joins it", () => {
		const segs = splitSegments("git \\\n  commit -m x");
		expect(segs).toEqual(["git \\\n  commit -m x"]);
		expect(shellSplit(segs[0] ?? "")).toEqual(["git", "commit", "-m", "x"]);
	});
});

describe("splitSegments — negative (must not split)", () => {
	it("N5: a quoted or escaped separator, a mid-word #, and a trailing backslash stay literal", () => {
		expect(splitSegments('git commit -m "a; b"')).toEqual(['git commit -m "a; b"']);
		expect(splitSegments("echo 'a\nb'")).toEqual(["echo 'a\nb'"]);
		expect(splitSegments("echo a\\;b")).toEqual(["echo a\\;b"]);
		expect(splitSegments("echo a#b; ls")).toEqual(["echo a#b", " ls"]);
		expect(splitSegments("echo trailing\\")).toEqual(["echo trailing\\"]);
	});

	it("N6: a comment-only command and a substitution body are not top-level segments", () => {
		expect(splitSegments("# git commit -m x")).toEqual([]);
		expect(splitSegments('echo "$(a; b)"')).toEqual(['echo "$(a; b)"']);
	});
});

describe("leadingCommand — positive (the head command, as splitSegments()[0])", () => {
	it("P11: agrees with splitSegments()[0] on separators, newlines, comments and quotes", () => {
		for (const cmd of [
			"git status; git commit -m x",
			"cd x && git commit -m y",
			"a | b",
			"true\ncp a b",
			"# note\ngit push",
			'echo "a; b" && c',
			"(cp a b); c",
			"cat <<'EOF'\nbody; x\nEOF\nnext",
			"echo x &> log; y",
			"plain",
		]) {
			expect(leadingCommand(cmd), cmd).toBe(splitSegments(cmd)[0]);
		}
	});
});

describe("leadingCommand — negative (an empty head command yields \"\")", () => {
	it("N5: a command opening with a separator is a syntax error and has no head command", () => {
		for (const cmd of ["&&git add x", "; python3", " | x", "\n& y", "# c\n;git add x"]) {
			expect(leadingCommand(cmd), JSON.stringify(cmd)).toBe("");
		}
		expect(leadingCommand("")).toBe("");
		expect(leadingCommand("   \n# only a comment")).toBe("");
	});
});

describe("isGitBinary / cdTargetOf / ScopedCwd", () => {
	it("P9: recognizes git paths and literal cd targets", () => {
		expect(isGitBinary("git")).toBe(true);
		expect(isGitBinary("/usr/bin/git")).toBe(true);
		expect(isGitBinary("gitk")).toBe(false);
		expect(cdTargetOf(["cd", "-P", "sub"])).toBe("sub");
		expect(cdTargetOf(["pushd", "x"])).toBe("x");
	});

	it("N4: a dynamic cd target is unknown, and a child scope's cd does not leak", () => {
		expect(cdTargetOf(["cd", "$X"])).toBeNull();
		expect(cdTargetOf(["cd", "~"])).toBeNull();
		const cwd = new ScopedCwd();
		cwd.cd("", "a");
		expect(cwd.get(".1")).toBe("a");
		cwd.cd(".1", "b");
		expect(cwd.get(".1")).toBe("a/b");
		expect(cwd.get("")).toBe("a");
		expect(cwd.of({ argv: [], scope: "", wrapperCwd: "c" })).toBe("a/c");
	});
});
