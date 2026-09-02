// Heuristic classification of a resolved guard-block command as a real
// attempt or an FP. Extracted from audit-receipts.mjs. Conservative —
// defaults to "needs_review" so the audit underclaims rather than overclaims.

/** True when the command reads as prose/search text rather than an invocation. */
function looksLikeText(lc, verb) {
	return (
		lc.includes("git commit") ||
		lc.includes(`echo `) ||
		lc.includes(`grep `) ||
		lc.includes(`rg `) ||
		lc.includes(`> ${verb}.log`)
	);
}

function classifyShutdownReboot(command, lc) {
	if (looksLikeText(lc, "shutdown") && (lc.includes("shutdown") || lc.includes("reboot"))) return "fp_in_text";
	const startsWithVerb = /^\s*(?:sudo\s+)?(?:shutdown|reboot)\b/i;
	if (startsWithVerb.test(command)) return "real";
	return "fp_in_text"; // older rule fired on substring match — assume FP unless command-start match
}

function classifyRmRfRoot(command, lc) {
	if (looksLikeText(lc, "rm")) return "fp_in_text";
	const isRoot = /^\s*(?:sudo\s+)?rm\s+-[rRf]+\s+\/(?!Users|Volumes|var\/tmp\b|tmp\b)/.test(command);
	const isWildcard = /^\s*(?:sudo\s+)?rm\s+-[rRf]+\s+\*/.test(command);
	if (isRoot || isWildcard) return "real";
	// rm -rf <project-subdir> is the rule firing on any path starting with /
	// Not a true root-level delete.
	return "fp_path_under_users";
}

function classifyDropDatabase(lc) {
	if (looksLikeText(lc, "drop")) return "fp_in_text";
	// Real DROP would be embedded in a script execution, not interactive
	return "needs_review";
}

function classifyKubectlDeleteAll(command, lc) {
	if (looksLikeText(lc, "kubectl")) return "fp_in_text";
	if (/^\s*kubectl\s+delete\s+--all/.test(command)) return "real";
	return "fp_in_text";
}

function classifyChmod777(command, lc) {
	if (looksLikeText(lc, "chmod")) return "fp_in_text";
	if (/^\s*(?:sudo\s+)?chmod\s+0?777\b/.test(command)) return "real";
	return "fp_in_text";
}

function classifyNohupNetwork(lc) {
	if (!lc.includes("nohup")) return "fp_in_text";
	return "needs_review";
}

/**
 * Classify a resolved command for one guard rule id.
 *
 * `pretooluse-injection-scan` carries a file-path field, not a command:
 * whether the content was real prompt injection depends on the file's
 * contents at write time, which the activity log doesn't preserve, so it
 * falls through to the unverified default like any unknown rule.
 */
export function classify(ruleId, command) {
	const lc = command.toLowerCase();
	switch (ruleId) {
		case "builtin-shutdown-reboot":
			return classifyShutdownReboot(command, lc);
		case "builtin-rm-rf-root":
			return classifyRmRfRoot(command, lc);
		case "builtin-drop-database":
			return classifyDropDatabase(lc);
		case "builtin-kubectl-delete-all":
			return classifyKubectlDeleteAll(command, lc);
		case "builtin-chmod-777":
			return classifyChmod777(command, lc);
		case "builtin-nohup-network":
			return classifyNohupNetwork(lc);
		default:
			return "needs_review";
	}
}
