// ============================================================
// child_process shell-injection footgun detectors
// ============================================================
// Highest-severity Node bug class: `exec()` / `execSync()` with
// any interpolated user input spawns a shell, and shell
// interpolation runs anything that contains shell metacharacters
// (`;`, `&&`, backticks, etc.). The argv-array form via
// `spawn()` / `execFile()` is the safe alternative.

import type { InlineMatch } from "../checks/shared.js";
import { collectRegexLineMatches, shouldSkipFootgunScan } from "./scan-helpers.js";
import type { LibraryFootgunCheck } from "./types.js";

// Match `exec(` / `execSync(` whose argument starts with a
// template literal containing `${...}` OR a string + concat.
// Negative lookbehind on `.|\w` so `obj.execMethod(` doesn't match.
const EXEC_INTERPOLATED_RE =
	/(?<![.\w$])exec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+|\w+\s*\+)/g;

function detectExecInterpolated(content: string, filePath: string): InlineMatch[] {
	if (shouldSkipFootgunScan(filePath, content)) return [];
	return collectRegexLineMatches(content, EXEC_INTERPOLATED_RE);
}

export const CHILD_PROCESS_FOOTGUNS: LibraryFootgunCheck[] = [
	{
		id: "child_process_exec_interpolated",
		name: "child_process exec with interpolated input",
		library: "child-process",
		detect: detectExecInterpolated,
		fixInstruction:
			"`exec(`cmd ${userInput}`)` and `exec('cmd ' + userInput)` spawn a SHELL that interprets metacharacters. A `;` or backtick in `userInput` runs arbitrary code. Switch to the argv-array form: `spawn('cmd', [userInput])` or `execFile('cmd', [userInput])` — these bypass the shell entirely. If you genuinely need shell features, validate/escape the input explicitly before interpolation.",
	},
];
