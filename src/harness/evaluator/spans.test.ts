import { describe, expect, it } from "vitest";
import { classifySpans, extractScannableText, resolveHeredocTarget } from "./spans.js";

describe("classifySpans", () => {
	it("returns a single executed span for a plain command", () => {
		const spans = classifySpans("rm -rf /");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("executed");
		expect(spans[0]?.text).toBe("rm -rf /");
	});

	it("classifies single-quoted regions as quoted", () => {
		const cmd = "git commit -m 'rm -rf /'";
		const spans = classifySpans(cmd);
		const quoted = spans.find((s) => s.kind === "quoted");
		expect(quoted?.text).toBe("'rm -rf /'");
	});

	it("classifies double-quoted regions as quoted", () => {
		const cmd = 'echo "hello world"';
		const spans = classifySpans(cmd);
		expect(spans.some((s) => s.kind === "quoted" && s.text === '"hello world"')).toBe(true);
	});

	it("classifies $'...' ANSI-C quoted regions as quoted", () => {
		const cmd = "echo $'hello\\nworld'";
		const spans = classifySpans(cmd);
		expect(spans.some((s) => s.kind === "quoted")).toBe(true);
	});

	it("classifies # comments as comment", () => {
		const cmd = "rm -rf / # don't actually do this";
		const spans = classifySpans(cmd);
		const comment = spans.find((s) => s.kind === "comment");
		expect(comment?.text).toBe("# don't actually do this");
	});

	it("does not treat # inside a token as a comment", () => {
		const cmd = "echo abc#xyz";
		const spans = classifySpans(cmd);
		expect(spans.every((s) => s.kind !== "comment")).toBe(true);
	});

	it("classifies heredoc bodies as heredoc", () => {
		const cmd = "cat <<EOF\nrm -rf /\nEOF\n";
		const spans = classifySpans(cmd);
		expect(spans.some((s) => s.kind === "heredoc")).toBe(true);
	});

	it("covers the full input contiguously", () => {
		const cmd = "git commit -m 'rm -rf /' # dangerous\necho ok";
		const spans = classifySpans(cmd);
		// Every byte in [0, cmd.length) covered by exactly one span.
		const reassembled = spans.map((s) => s.text).join("");
		expect(reassembled).toBe(cmd);
	});

	it("preserves byte offsets between spans", () => {
		const cmd = "a 'b' c";
		const spans = classifySpans(cmd);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i]?.start).toBe(spans[i - 1]?.end);
		}
	});
});

describe("extractScannableText", () => {
	it("replaces quoted text with same-length whitespace", () => {
		const cmd = "git commit -m 'rm -rf /'";
		const out = extractScannableText(cmd);
		expect(out).toHaveLength(cmd.length);
		expect(out).not.toContain("rm");
	});

	it("replaces comments with whitespace", () => {
		const cmd = "ls # this comment has rm -rf in it";
		const out = extractScannableText(cmd);
		expect(out).toContain("ls");
		expect(out).not.toContain("rm");
	});

	it("preserves executed text untouched", () => {
		const cmd = "rm -rf /";
		expect(extractScannableText(cmd)).toBe("rm -rf /");
	});

	it("preserves index alignment for regex matching", () => {
		const cmd = "ls && 'rm -rf /' && pwd";
		const out = extractScannableText(cmd);
		expect(out.indexOf("ls")).toBe(cmd.indexOf("ls"));
		expect(out.indexOf("pwd")).toBe(cmd.indexOf("pwd"));
		// 'rm -rf /' should be all whitespace in `out`.
		expect(out.slice(cmd.indexOf("'"), cmd.indexOf("'") + "'rm -rf /'".length)).toMatch(/^\s+$/);
	});

	it("a destructive regex against scannable text does not fire on quoted occurrences", () => {
		const cmd = "git commit -m 'rm -rf /'";
		expect(/\brm\s+-rf\b/.test(cmd)).toBe(true); // raw input would falsely match
		expect(/\brm\s+-rf\b/.test(extractScannableText(cmd))).toBe(false); // sanitized input does not
	});
});

// Data-sink-aware heredoc masking + inline-exec payload classification —
// mechanisms adapted from destructive_command_guard #136 (independently
// reimplemented; see docs/external-pulse/destructive-command-guard.md).

describe("heredoc data-sink masking", () => {
	it("masks a heredoc fed to a data sink (cat)", () => {
		const cmd = "cat <<EOF > notes.md\ngit reset --hard is dangerous\nEOF\n";
		const out = extractScannableText(cmd);
		expect(out).not.toContain("reset --hard");
	});

	it("keeps the header line's redirect in executed text", () => {
		const cmd = "cat <<EOF > /etc/passwd\nbody\nEOF\n";
		const out = extractScannableText(cmd);
		expect(out).toContain("> /etc/passwd");
	});

	it("keeps a shell-fed heredoc body scannable (bash executes its stdin)", () => {
		const cmd = "bash <<EOF\nrm -rf /\nEOF\n";
		const out = extractScannableText(cmd);
		expect(out).toContain("rm -rf /");
	});

	it("keeps an interpreter-stdin heredoc body scannable (python3 -)", () => {
		const cmd = "python3 - <<PY\nimport os; os.system('rm -rf /')\nPY\n";
		const out = extractScannableText(cmd);
		expect(out).toContain("os.system");
	});

	// Quoted delimiter + non-shell runtime: the shell neither expands nor runs the
	// body, and the runtime reads it as its own language, not as shell. Found as a
	// builtin-kill-substitution BLOCK on Python prose "the kill `stale`".
	it("masks a quoted-delimiter heredoc fed to a non-shell runtime (python3 -)", () => {
		const cmd = "python3 - <<'PYEOF'\nprint(\"mark the kill `stale` and re-measure\")\nPYEOF\n";
		expect(extractScannableText(cmd)).not.toContain("kill `stale`");
	});

	it("masks a double-quoted delimiter and <<- for node / env python3", () => {
		expect(extractScannableText('node - <<"EOF"\nconst s = "kill `x`";\nEOF\n')).not.toContain(
			"kill `x`",
		);
		expect(
			extractScannableText("env FOO=1 python3 <<-'EOF'\n\tprint('kill $(x)')\n\tEOF\n"),
		).not.toContain("kill $(x)");
	});

	it("keeps an UNQUOTED heredoc to a non-shell runtime scannable (the shell expands $() in it)", () => {
		const cmd = "python3 - <<PYEOF\nprint('kill $(pgrep x)')\nPYEOF\n";
		expect(extractScannableText(cmd)).toContain("kill $(pgrep x)");
	});

	it("keeps a quoted-delimiter heredoc to a SHELL scannable (bash / sh -s run it)", () => {
		expect(extractScannableText("bash <<'EOF'\nkill $(pgrep x)\nEOF\n")).toContain("kill $(pgrep x)");
		expect(extractScannableText("sh -s <<'EOF'\nkill $(pgrep x)\nEOF\n")).toContain("kill $(pgrep x)");
	});

	it("keeps the header line of a masked runtime heredoc executed", () => {
		const cmd = "python3 - <<'EOF' && kill $(pgrep x)\nprint('hi')\nEOF\n";
		expect(extractScannableText(cmd)).toContain("kill $(pgrep x)");
	});

	// Repair round (2026-10-02): each bypass a verifier found in the first
	// runtime-mask cut. bash executes every one of these shapes.
	const KILL = "kill $(pgrep node)";
	it.each([
		["here-string is not a heredoc header", `python3 <<<'x'\n${KILL}\n`],
		["double-quoted here-string after `-`", `python3 - <<<"hi"\n${KILL}\n`],
		["here-string to a data sink", `cat <<<'x'\n${KILL}\n`],
		["`EOF)` closes a python3 body inside $( )", `x=$(python3 - <<'EOF'\nprint(1)\nEOF)\n${KILL}\n`],
		["`EOF)` closes a node body inside $( )", `x=$(node - <<'EOF'\nconsole.log(1)\nEOF)\n${KILL}\n`],
		["`EOF)` closes a cat body inside $( )", `x=$(cat <<'EOF'\nhi\nEOF)\n${KILL}\n`],
		["runtime output piped to sh", `python3 - <<'EOF' | sh\nprint("${KILL}")\nEOF\n`],
		["runtime output in <( ) run by bash", `bash <(python3 - <<'EOF'\nprint("${KILL}")\nEOF\n)\n`],
		["runtime output in eval $( )", `eval $(python3 - <<'EOF'\nprint("${KILL}")\nEOF\n)\n`],
		["runtime output piped from a for loop", `for i in 1; do python3 - <<'EOF'\nprint("${KILL}")\nEOF\ndone | sh\n`],
		["runtime output piped from a brace group", `{ python3 - <<'EOF'\nprint("${KILL}")\nEOF\n} | sh\n`],
		["header line continued into a pipe", `python3 - <<'EOF' \\\n| sh\nprint("${KILL}")\nEOF\n`],
		["stdout redirected to >(sh) earlier", `exec > >(sh)\npython3 - <<'EOF'\nprint("${KILL}")\nEOF\n`],
		["sudo -u node bash (option argument is not the command)", `sudo -u node bash <<'EOF'\n${KILL}\nEOF\n`],
		["sudo -u node sh -s", `sudo -u node sh -s <<'EOF'\n${KILL}\nEOF\n`],
		["exec -a python3 bash", `exec -a python3 bash <<'EOF'\n${KILL}\nEOF\n`],
	])("P: keeps the kill scannable — %s", (_label, cmd) => {
		expect(extractScannableText(cmd)).toContain(KILL);
	});

	const PROSE = "the kill `stale`";
	it.each([
		["python3 with 2>&1 before the operator", `python3 - 2>&1 <<'EOF'\nprint("${PROSE}")\nEOF\n`],
		["npx tsx", `npx tsx - <<'EOF'\nconsole.log("${PROSE}")\nEOF\n`],
		["uv run python", `uv run python - <<'EOF'\nprint("${PROSE}")\nEOF\n`],
		["python3 after cd &&", `cd /tmp && python3 - <<'PYEOF'\nprint("${PROSE}")\nPYEOF\n`],
		["python3 with a file redirect and || true", `python3 - <<'EOF' > out.txt || true\nprint("${PROSE}")\nEOF\n`],
		["python3 after a closed for loop", `for i in 1; do echo $i; done\npython3 - <<'EOF'\nprint("${PROSE}")\nEOF\n`],
		["bare sudo python3", `sudo python3 - <<'EOF'\nprint("${PROSE}")\nEOF\n`],
	])("N: masks a top-level quoted runtime heredoc — %s", (_label, cmd) => {
		expect(extractScannableText(cmd)).not.toContain(PROSE);
	});

	// Repair round 2 (2026-10-02): shapes where the runtime's output still
	// reaches a shell. Each one ran an `echo` payload under zsh 5 (the Bash
	// tool's shell); the double-quote shape also ran under /bin/bash 3.2.
	it.each([
		[
			"`$(` hidden by a quote the span scanner pairs wrongly",
			`eval "$(: '"'\\'; python3 - <<'EOF'\nprint("${KILL}")\nEOF\n)"\n`,
		],
		[
			"a case pattern `)` inside eval $( )",
			`eval $(case x in x) ;; esac; python3 - <<'EOF'\nprint("${KILL}")\nEOF\n)\n`,
		],
		[
			"an earlier heredoc body holds a `)` inside eval $( )",
			`eval $(cat <<'A'\n)\nA\npython3 - <<'EOF'\nprint("${KILL}")\nEOF\n)\n`,
		],
		["zsh coproc fed by >&p", `coproc sh\npython3 - <<'EOF' >&p\nprint("${KILL}")\nEOF\n`],
		[
			"zsh coproc fed by >&p before the operator",
			`coproc sh\npython3 - >&p <<'EOF'\nprint("${KILL}")\nEOF\n`,
		],
		[
			"bash coproc fed by >&${COPROC[1]}",
			`coproc sh\npython3 - <<'EOF' >&\${COPROC[1]}\nprint("${KILL}")\nEOF\n`,
		],
		["output to a descriptor path", `python3 - <<'EOF' > /dev/fd/3\nprint("${KILL}")\nEOF\n`],
		["output to descriptor 3", `python3 - <<'EOF' >&3\nprint("${KILL}")\nEOF\n`],
		[
			"output to a fifo that a background shell reads",
			`mkfifo ff; sh < ff &\npython3 - <<'EOF' > ff\nprint("${KILL}")\nEOF\n`,
		],
		[
			"zsh foreach … end piped to sh",
			`foreach i (1)\npython3 - <<'EOF'\nprint("${KILL}")\nEOF\nend | sh\n`,
		],
	])("P: keeps the kill scannable — %s", (_label, cmd) => {
		expect(extractScannableText(cmd)).toContain(KILL);
	});

	it.each([
		[
			'python3 after a balanced cd "$( )"',
			`cd "$(git rev-parse --show-toplevel)" && python3 - <<'PYEOF'\nprint("${PROSE}")\nPYEOF\n`,
		],
		[
			"python3 after a comment with an open paren",
			`# note (draft\npython3 - <<'EOF'\nprint("${PROSE}")\nEOF\n`,
		],
		[
			"python3 after an arithmetic shift",
			`x=$((1<<2))\npython3 - <<'EOF'\nprint("${PROSE}")\nEOF\n`,
		],
		[
			"python3 after an apostrophe in double quotes",
			`echo "it's" && python3 - <<'EOF'\nprint("${PROSE}")\nEOF\n`,
		],
		[
			"python3 after a cat heredoc whose body has a paren",
			`cat <<'A' > n.md\n(open paren prose\nA\npython3 - <<'EOF'\nprint("${PROSE}")\nEOF\n`,
		],
		["python3 with stdout sent to stderr", `python3 - <<'EOF' >&2\nprint("${PROSE}")\nEOF\n`],
	])("N: masks a top-level quoted runtime heredoc — %s", (_label, cmd) => {
		expect(extractScannableText(cmd)).not.toContain(PROSE);
	});

	it("treats unknown targets as executing (fails toward recall)", () => {
		const cmd = "mystery-tool <<EOF\nrm -rf /\nEOF\n";
		const out = extractScannableText(cmd);
		expect(out).toContain("rm -rf /");
	});

	it("does not let exec conduits masquerade as sinks (ssh / kubectl exec)", () => {
		expect(extractScannableText("ssh host bash <<EOF\nrm -rf /\nEOF\n")).toContain("rm -rf /");
		expect(
			extractScannableText("kubectl exec -i pod -- bash <<EOF\nrm -rf /\nEOF\n"),
		).toContain("rm -rf /");
	});

	it("strips wrapper prefixes when resolving the target (sudo tee)", () => {
		const cmd = "sudo tee /etc/motd <<EOF\nrm -rf / mentioned in prose\nEOF\n";
		const out = extractScannableText(cmd);
		expect(out).not.toContain("rm -rf /");
	});

	it("masks git stdin data sinks (commit -F -)", () => {
		const cmd = "git commit -F - <<MSG\nfix: stop suggesting git reset --hard\nMSG\n";
		const out = extractScannableText(cmd);
		expect(out).not.toContain("reset --hard");
	});

	it("bounds target resolution to the heredoc's own line", () => {
		// A data sink on an earlier line must not mask a later executing body.
		const cmd = "cat notes.txt\nbash <<EOF\nrm -rf /\nEOF\n";
		expect(extractScannableText(cmd)).toContain("rm -rf /");
		// And the reverse: an interpreter earlier must not unmask a cat body.
		const cmd2 = "bash setup.sh\ncat <<EOF\nrm -rf / in prose\nEOF\n";
		expect(extractScannableText(cmd2)).not.toContain("rm -rf /");
	});

	it("resolves the target within the operator's own pipe segment", () => {
		const cmd = "bash setup.sh | tee <<EOF\nrm -rf / in prose\nEOF\n";
		expect(extractScannableText(cmd)).not.toContain("rm -rf /");
	});

	it("supports <<- with an indented closer and quoted tags", () => {
		const cmd = "cat <<-'EOF'\n\trm -rf / in prose\n\tEOF\n";
		expect(extractScannableText(cmd)).not.toContain("rm -rf /");
	});

	it("resolves a target on the right of the operator (<<EOF cat)", () => {
		const cmd = "<<EOF cat\nrm -rf / in prose\nEOF\n";
		expect(extractScannableText(cmd)).not.toContain("rm -rf /");
	});

	it("reassembles contiguously with mixed heredoc + quotes", () => {
		const cmd = "echo 'a' && bash <<EOF\nrm -rf /\nEOF\necho \"b\"";
		const spans = classifySpans(cmd);
		expect(spans.map((s) => s.text).join("")).toBe(cmd);
	});

	it("a heredoc header with no trailing newline at all keeps the header as executed text", () => {
		const cmd = "cat <<EOF";
		const spans = classifySpans(cmd);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.kind).toBe("executed");
		expect(spans[0]?.text).toBe(cmd);
	});

	it("an unterminated heredoc body (no closer line) runs to end of string", () => {
		const cmd = "cat <<EOF\nbody without a closer\n";
		const spans = classifySpans(cmd);
		const body = spans.find((s) => s.kind === "heredoc");
		expect(body?.end).toBe(cmd.length);
		expect(body?.text).toBe("body without a closer\n");
	});

	it("an unterminated single-quote runs to end of string without crashing", () => {
		const cmd = "echo 'unterminated";
		const spans = classifySpans(cmd);
		expect(spans.map((s) => s.text).join("")).toBe(cmd);
		const quoted = spans.find((s) => s.kind === "quoted");
		expect(quoted?.text).toBe("'unterminated");
	});

	it("does not treat << followed by an invalid tag (a digit) as a heredoc", () => {
		const cmd = "echo << 5\n";
		const spans = classifySpans(cmd);
		expect(spans.every((s) => s.kind !== "heredoc")).toBe(true);
		expect(spans.map((s) => s.text).join("")).toBe(cmd);
	});

	it("a heredoc body immediately followed by the closer line reassembles correctly (zero-length body)", () => {
		const cmd = "cat <<EOF\nEOF\n";
		const spans = classifySpans(cmd);
		expect(spans.map((s) => s.text).join("")).toBe(cmd);
		expect(spans.some((s) => s.kind === "heredoc")).toBe(false);
	});

	it("a comment as the FIRST character of the string is still recognized (no preceding char to check)", () => {
		const cmd = "# just a comment\n";
		const spans = classifySpans(cmd);
		expect(spans[0]?.kind).toBe("comment");
		expect(spans[0]?.text).toBe("# just a comment");
	});
});

describe("resolveHeredocTarget", () => {
	function targetOf(cmd: string): string | null {
		const op = cmd.indexOf("<<");
		const headerEnd = op + (cmd.slice(op).match(/^<<-?\s*['"]?\w+['"]?/)?.[0]?.length ?? 2);
		return resolveHeredocTarget(cmd, op, headerEnd);
	}

	it("resolves plain targets", () => {
		expect(targetOf("cat <<EOF\nx\nEOF")).toBe("cat");
		expect(targetOf("bash <<EOF\nx\nEOF")).toBe("bash");
	});

	it("strips env assignments and wrappers", () => {
		expect(targetOf("FOO=1 sudo tee /x <<EOF\nx\nEOF")).toBe("tee");
		expect(targetOf("env -i FOO=1 bash <<EOF\nx\nEOF")).toBe("bash");
		expect(targetOf("timeout 5 cat <<EOF\nx\nEOF")).toBe("cat");
	});

	it("strips path prefixes", () => {
		expect(targetOf("/usr/bin/tee /x <<EOF\nx\nEOF")).toBe("tee");
	});

	it("returns null when no command word exists", () => {
		expect(targetOf("<<EOF\nx\nEOF")).toBe(null);
	});

	it("skips a leading redirect/flag token before the actual command word", () => {
		expect(targetOf("<in.txt cat <<EOF\nx\nEOF")).toBe("cat");
	});

	it("returns null when the before-segment is ONLY a wrapper with no real command", () => {
		expect(targetOf("sudo <<EOF\nx\nEOF")).toBe(null);
	});

	it("tracks double-quote state while scanning the before-segment for separators", () => {
		// The quote scanner must flip `inDouble` on the opening AND closing `"` so a
		// `;`/`|` INSIDE the quoted token is never mistaken for a segment separator.
		expect(targetOf('"x" cat <<EOF\nbody\nEOF')).toBe('"x"');
	});

	it("looks right of the operator when nothing precedes it on the line, even with no trailing newline", () => {
		expect(targetOf("<<EOF cat")).toBe("cat");
	});

	it("stops the right-hand lookup at a separator (;) after the operator", () => {
		expect(targetOf("<<EOF cat; echo hi\nbody\nEOF")).toBe("cat");
	});
});

describe("inline-exec payload classification", () => {
	it("classifies bash -c payloads as inline_code (scannable)", () => {
		const cmd = "bash -c 'rm -rf /'";
		const spans = classifySpans(cmd);
		expect(spans.some((s) => s.kind === "inline_code")).toBe(true);
		expect(extractScannableText(cmd)).toContain("rm -rf /");
	});

	it("survives intervening flags (python3 -u -c — the dcg repro shape)", () => {
		const cmd = "python3 -u -c \"import os; os.system('rm -rf /')\"";
		expect(extractScannableText(cmd)).toContain("os.system");
	});

	it("covers node -e / perl -pe / pwsh -Command", () => {
		expect(extractScannableText('node -e "fs.rmSync(`/`, {recursive: true})"')).toContain(
			"rmSync",
		);
		expect(extractScannableText("perl -pe 's/x/y/' file")).toContain("s/x/y/");
		expect(extractScannableText('pwsh -Command "Remove-Item -Recurse /"')).toContain(
			"Remove-Item",
		);
	});

	it("handles wrapped interpreters (sudo bash -c)", () => {
		expect(extractScannableText("sudo bash -c 'rm -rf /'")).toContain("rm -rf /");
	});

	it("still masks ordinary quoted arguments (git commit -m)", () => {
		const cmd = "git commit -m 'rm -rf /'";
		expect(extractScannableText(cmd)).not.toContain("rm -rf /");
	});

	it("does not treat non-interpreter -e flags as exec payloads (grep -e)", () => {
		const cmd = "grep -e 'rm -rf /' notes.md";
		expect(extractScannableText(cmd)).not.toContain("rm -rf /");
	});

	it("classifies an ANSI-C $'...' inline-exec payload (bash -c $'...') as inline_code", () => {
		const cmd = "bash -c $'rm -rf /'";
		const spans = classifySpans(cmd);
		expect(spans.some((s) => s.kind === "inline_code")).toBe(true);
		expect(extractScannableText(cmd)).toContain("rm -rf /");
	});
});
