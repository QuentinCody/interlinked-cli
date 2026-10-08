import { describe, expect, it } from "vitest";
import { scanShellPrefix } from "./shell-prefix-scan.js";

// Each prefix is the raw command text before a heredoc operator. The shapes
// marked (zsh) ran an echo payload under zsh 5 on 2026-10-02 and printed it.

describe("scanShellPrefix — positive (top level)", () => {
	it.each([
		[""],
		["cd /tmp && "],
		['cd "$(git rev-parse --show-toplevel)" && '],
		["x=$(date)\n"],
		["x=$((1<<2))\n"],
		[`echo "it's" && `],
		["echo ${HOME:-$(pwd)} 2>&1\n"],
		["# note (draft\n"],
		["echo a;# (comment after a separator\n"],
		["cat <<'A' > n.md\n(open paren prose\nA\n"],
		["cat <<-A\n\t(tab-indented body\n\tA\n"],
		["cat <<A <<'B'\n(\nA\n{\nB\n"],
		["case $x in a) echo a ;; esac\n"],
		["echo $'it\\'s' && "],
		["python3 <<<'x(' && "],
	])("P: %j", (prefix) => {
		expect(scanShellPrefix(prefix).topLevel).toBe(true);
	});

	it("collects unquoted text outside comments and heredoc bodies", () => {
		const scan = scanShellPrefix("echo 'mkfifo' \"coproc\" # foreach\ncat <<'A'\nmkfifo\nA\n");
		expect(scan.bare).not.toMatch(/mkfifo|coproc|foreach/);
		expect(scan.bare).toContain("echo");
	});
});

describe("scanShellPrefix — negative (not top level)", () => {
	it.each([
		["x=$("],
		["bash <("],
		["{ "],
		["echo `"],
		['x="$('],
		["echo ${x:-$("],
		// (zsh, bash 3.2) the span scanner ends the quote at the inner `"`
		[`eval "$(: '"'\\'; `],
		// (zsh) a case pattern `)` must not close the enclosing $(
		["eval $(case x in x) ;; esac; "],
		["eval $(cat <<'A'\n)\nA\n"],
		["echo 'unterminated\n"],
		["echo $'unterminated\n"],
		["cat <<'A'\nbody without a closer\n"],
		["x=$(cat <<'A'\nbody\nA)\n"],
		["cat <<'A' && "],
	])("N: %j", (prefix) => {
		expect(scanShellPrefix(prefix).topLevel).toBe(false);
	});
});
