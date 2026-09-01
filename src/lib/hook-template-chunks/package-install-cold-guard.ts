// Single source of truth for the cold-fallback PACKAGE-INSTALL gate that the
// generated `.interlinked/hooks/interlinked-activity.mjs` runs inline.
//
// Deliberately CONSERVATIVE, and deliberately NOT the same decision the
// daemon (or `src/hook-entry-cold-gates.ts`) makes. Those two run the real
// parser (`harness/package-install-parser.ts`) against the real allowlist and
// can approve an install; the .mjs can do neither — it may not import, and the
// parser plus allowlist loader are far past what a serialized function blob can
// carry. So when the daemon is unreachable this gate refuses every install verb
// and names the recovery. Merging the two implementations in either direction
// would change enforcement: toward this one the cold path would stop honoring
// approved packages; toward the allowlist-aware one the .mjs cannot follow.
//
// `guards-inline.ts` embeds `PACKAGE_INSTALL_COLD_GUARD_SOURCE` — the joined
// `Function.toString()` of the functions below — verbatim into its template
// string, so this file is the only place the patterns are maintained.
//
// IMPORTANT: every function below MUST stay a free-standing, self-contained
// `function` declaration — no module-scope constants, no imports referenced
// from inside a body, and no backtick or dollar-brace anywhere in the source
// (it is spliced into a template literal). The `new Function` round-trip test
// in `__tests__/package-install-cold-guard.test.ts` pins that.

import type { ColdWriteVerdict } from "./cold-write-guards.js";

/** True when the command runs a package-install verb in any of the covered
 *  ecosystems (npm / pnpm / yarn / bun / pip / pipx / poetry / uv / cargo /
 *  gem / bundle / go), including bare `yarn`, and is not an uninstall or a
 *  script runner. Mirrors the ENTRY POINTS of the daemon-side parser: what it
 *  loses in granularity it makes up for in fail-closed safety. */
export function looksLikePackageInstall(cmd: string): boolean {
	if (!cmd) return false;
	const installRe =
		/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci)\b|\b(?:pip|pip3)\s+install\b|\bpipx\s+(?:install|inject|run)\b|\bpoetry\s+(?:add|install)\b|\buv\s+(?:add|sync|pip\s+install|tool\s+install)\b|\bcargo\s+(?:add|install)\b|\bgem\s+install\b|\bbundle(?:r)?\s+(?:install|add)\b|\bgo\s+(?:get|install)\b/;
	// bare 'yarn' with no args also runs install.
	const bareYarn = /^\s*(?:sudo\s+|nohup\s+|exec\s+)?yarn\s*(?:$|;|&|\|)/;
	if (!installRe.test(cmd) && !bareYarn.test(cmd)) return false;
	return !pigIsRemovalOrScript(cmd);
}

/** True for the verbs that add no new code: every ecosystem's uninstall/remove
 *  form, plus the npm sub-commands that only read or run. */
function pigIsRemovalOrScript(cmd: string): boolean {
	const exempt = [
		/\b(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm|un|unlink)\b/,
		/\bpip(?:3)?\s+uninstall\b/,
		/\bpipx\s+uninstall\b/,
		/\bpoetry\s+remove\b/,
		/\buv\s+remove\b/,
		/\bcargo\s+(?:remove|uninstall)\b/,
		/\bgem\s+uninstall\b/,
		/\bbundle(?:r)?\s+remove\b/,
		// Not 'npm run X', 'npm test', etc. The install regex does not match
		// them either, but be explicit.
		/^\s*npm\s+(?:run|test|version|publish|view|outdated|audit|exec)\b/,
	];
	for (const re of exempt) {
		if (re.test(cmd)) return true;
	}
	return false;
}

/**
 * Cold fail-closed gate: refuse a package install while the allowlist cannot be
 * consulted. Returns a block verdict, or null when the command is not an
 * install, the tool is not a shell, or the operator set
 * INTERLINKED_DISABLE_PACKAGE_GUARD=1 for this command.
 */
export function checkPackageInstallCold(
	toolName: string,
	// Optional: this function's SOURCE is serialized via Function.toString()
	// into the generated .mjs (see the file header) and run there as untyped
	// JS, where the real hook payload can omit `tool_input` entirely — the
	// TS-only call sites (tests) always pass an object, but the runtime
	// caller does not guarantee one.
	toolInput: { command?: unknown } | null | undefined,
): ColdWriteVerdict | null {
	if (process.env.INTERLINKED_DISABLE_PACKAGE_GUARD === "1") return null;
	const bashTools = ["Bash", "Shell", "shell", "run_command", "bash"];
	if (!toolName || bashTools.indexOf(toolName) === -1) return null;
	const cmd = toolInput && typeof toolInput.command === "string" ? toolInput.command : "";
	if (!looksLikePackageInstall(cmd)) return null;
	return {
		decision: "block",
		reason:
			"[interlinked:supply-chain][harness-offline] Package install commands are blocked when the harness daemon is unreachable, because the allowlist gate can't run. " +
			"The daemon supervisor is recovering it — retry in a few seconds (do NOT start one by hand; concurrent starts race). Approved packages in .interlinked/package-allowlist.json will be allowed. " +
			"Override for one command (advanced, bypasses the gate): set INTERLINKED_DISABLE_PACKAGE_GUARD=1.",
		rule_id: "supply-chain-inline-fail-closed",
		severity: "high",
		category: "supply-chain",
	};
}

/**
 * Source text of both functions above, joined as a run of plain function
 * declarations, for embedding into the zero-import generated .mjs hook.
 * Declarations hoist, so the join order does not matter.
 */
export const PACKAGE_INSTALL_COLD_GUARD_SOURCE: string = [
	pigIsRemovalOrScript,
	looksLikePackageInstall,
	checkPackageInstallCold,
]
	.map((fn) => fn.toString())
	.join("\n");
