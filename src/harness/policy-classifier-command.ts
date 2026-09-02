// ===========================================
// Policy Classifier — bash command classification helpers
// ===========================================
// Extracted from policy-classifier.ts to keep the parent file under the
// per-file line cap. Pure, side-effect-free command classification only.

/**
 * Classify a bash command string into a safe action label. An empty command
 * yields "unknown"; an unrecognized non-empty command yields "bash_other".
 * No raw command text leaks — only the category label is returned.
 */
export function classifyCommand(cmd: string): string {
	if (!cmd) return "unknown";

	return (
		classifyNetworkCommand(cmd) ??
		classifyGitCommand(cmd) ??
		classifyBuildCommand(cmd) ??
		classifyFileCommand(cmd) ??
		"bash_other"
	);
}

/** Network commands (curl/wget/ssh/nc family + npm publish). */
function classifyNetworkCommand(cmd: string): string | undefined {
	if (/\b(curl|wget)\b/i.test(cmd)) {
		if (/localhost|127\.0\.0\.1/i.test(cmd)) return "curl_localhost";
		return "curl_external";
	}
	if (/\b(ssh|scp|sftp|rsync)\b/i.test(cmd)) return "network_ssh";
	if (/\b(nc|ncat|netcat|socat|telnet)\b/i.test(cmd)) return "network_raw";
	if (/\bnpm\s+publish\b/i.test(cmd)) return "npm_publish";
	return undefined;
}

/** Git commands (network vs local mutation). */
function classifyGitCommand(cmd: string): string | undefined {
	if (/\bgit\s+(push|pull|fetch|clone)\b/i.test(cmd)) return "git_network";
	if (/\bgit\s+(commit|add|stash|reset|checkout|rebase|merge)\b/i.test(cmd)) return "git_local";
	return undefined;
}

/** Test/build/lint commands. */
function classifyBuildCommand(cmd: string): string | undefined {
	if (/\b(npm\s+(test|run)|npx\s+(vitest|jest|mocha))\b/i.test(cmd)) return "npm_test";
	if (/\b(npm\s+(install|ci)|yarn|pnpm)\b/i.test(cmd)) return "npm_install";
	if (/\b(tsc|biome|eslint|prettier)\b/i.test(cmd)) return "lint_typecheck";
	if (/\b(make|cargo|go\s+build|gcc|g\+\+)\b/i.test(cmd)) return "build";
	return undefined;
}

/** File operation commands. */
function classifyFileCommand(cmd: string): string | undefined {
	if (/\brm\s/i.test(cmd)) return "file_delete";
	if (/\b(chmod|chown)\b/i.test(cmd)) return "file_permissions";
	if (/\b(cat|head|tail|less|more|wc)\b/i.test(cmd)) return "file_read_cmd";
	if (/\b(mkdir|touch|cp|mv)\b/i.test(cmd)) return "file_manage";
	if (/\b(ls|find|fd)\b/i.test(cmd)) return "file_list";
	return undefined;
}
