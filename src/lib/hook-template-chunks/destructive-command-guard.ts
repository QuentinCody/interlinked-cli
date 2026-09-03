// Single source of truth for destructive shell-command detection.
//
// Two consumers, one implementation:
//   1. `src/hook-entry.ts` imports `checkDestructiveCommand` directly and runs
//      it in the cold-fallback path (when the harness daemon is unreachable).
//   2. The generated `.interlinked/hooks/interlinked-activity.mjs` cannot
//      `import` anything — it must run standalone. `guards-inline.ts` embeds
//      `DESTRUCTIVE_COMMAND_GUARD_SOURCE` (the joined `Function.toString()` of
//      every helper below plus `checkDestructiveCommand` itself) verbatim into
//      the .mjs template string, as a run of plain function declarations.
//
// Before this module existed, the destructive-command regexes lived ONLY in
// the .mjs template string, and `hook-entry.ts`'s cold fallback ran none of
// them — so `rm -rf /` sailed through whenever the daemon was down on the
// hook-entry.ts path. One shared function makes the two hook paths
// destructive-guard-identical by construction; no hand-kept parity.
//
// IMPORTANT: every function in this module MUST stay a free-standing, self-
// contained `function` declaration (no module-scope constants, no imports
// referenced from inside a serialized body) — `Function.prototype.toString()`
// serializes only that function's own text, and `DESTRUCTIVE_COMMAND_GUARD_SOURCE`
// is the concatenation of all of them. Plain function declarations hoist, so
// `checkDestructiveCommand` can call the `dcg*` helpers regardless of the
// order they're joined in. The `new Function` round-trip test in
// `__tests__/destructive-command-guard.test.ts` pins this invariant.
//
// Split across sibling modules to stay under the per-file line cap
// (destructive-command-guard-mask-state.ts, destructive-command-guard-git.ts)
// — each exported function there is equally self-contained and equally
// eligible for the `.toString()` serialization below; `import type` costs
// nothing at runtime, so it doesn't violate that contract.

import {
	dcgMaskCommentStep,
	dcgMaskInlineQuotedShell,
	dcgMaskQuoteStep,
	dcgMaskUnquotedStep,
	dcgMatchesShutdown,
} from "./destructive-command-guard-mask-state.js";
import {
	dcgCheckGitDataLoss,
	dcgCheckGitDestruction,
	dcgCheckGitInteractiveOrRewrite,
} from "./destructive-command-guard-git.js";

/** A destructive-command block verdict. `reason` is shown to the agent. */
export interface DestructiveCommandVerdict {
	decision: "block";
	reason: string;
}

type DestructiveCheck = (cmd: string) => DestructiveCommandVerdict | null;

/**
 * Agent-created worktrees are disabled by default. The daemon-side built-in
 * rule imports this expression, while the cold fallback serializes it into the
 * generated hook. Read and cleanup subcommands do not match.
 */
export const AGENT_WORKTREE_CREATE_COMMAND_PATTERN =
	"(?:^|(?:&&|\\|\\||[;|\\n])\\s*)(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+)*(?:[^\\s;&|]+\\/)*git(?:\\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\\s+\\S+|--(?:git-dir|work-tree|namespace|config-env|exec-path)=\\S+|-[pP]|--(?:paginate|no-pager|no-replace-objects|bare)))*\\s+worktree\\s+add\\b";

/** Agent-facing policy reason shared by native and shell worktree gates. */
export function agentWorktreeCreationBlockReason(): string {
	return (
		"BLOCKED: Agent-created Git worktrees are disabled by default. Use the existing " +
		"workspace; a human operator may provision an approved worktree outside the agent session."
	);
}

function dcgCheckWorktreeCreation(cmd: string): DestructiveCommandVerdict | null {
	if (!new RegExp(AGENT_WORKTREE_CREATE_COMMAND_PATTERN, "i").test(cmd)) return null;
	return { decision: "block", reason: agentWorktreeCreationBlockReason() };
}

function dcgCheckSleep(cmd: string): DestructiveCommandVerdict | null {
	if (/^\s*(sleep|bash\s+-c\s+.*sleep)\s+/i.test(cmd) || /;\s*sleep\s+/i.test(cmd)) {
		return {
			decision: "block",
			reason:
			"Avoid foreground sleep to wait on a condition. To wait for a command, run it with run_in_background. To wait for a condition, use the Monitor tool with an until-loop (until <check>; do sleep 2; done).",
		};
	}
	return null;
}

function dcgCheckProcessKilling(cmd: string): DestructiveCommandVerdict | null {
	// "skill" (procps signal-by-name) only counts in COMMAND position — as a
	// bare word, \bskill\s matched the English noun in any commit message or
	// path ("enforce skill copy", .agents/skills/) and blocked the whole
	// command (live FP, 2026-07-18).
	if (/\b(killall|pkill)\s|(?:^|[;&|])\s*skill\s/i.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: Mass process-killing commands (pkill/killall). Use 'kill <PID>' to target a single process.",
		};
	}
	if (/\bkill\s+-[1-9][0-9]*\b/.test(cmd) || /\bkill\s+-SIG/i.test(cmd) || /\bkill\s+-s\s/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Sending termination signals. Use plain 'kill <PID>' (SIGTERM) instead.",
		};
	}
	if (/\bkill\s+[0-9]+\s+[0-9]+/.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Killing multiple PIDs at once. Kill one PID at a time.",
		};
	}
	if (/\bkill\s+\$\(/.test(cmd) || /\|\s*xargs\s+(.*\s)?kill/i.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: kill with command substitution/xargs. Find the PID first, then kill it by number.",
		};
	}
	if (/\bpgrep\b.*\|\s*xargs\s+kill/i.test(cmd) || /\bps\s+(aux|ef)\b.*\bxargs\s+kill/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Pattern kills processes system-wide. Use specific PID.",
		};
	}
	return null;
}

function dcgCheckFilesystemDestruction(cmd: string): DestructiveCommandVerdict | null {
	if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--force\s+--recursive)\s/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Recursive force-delete (rm -rf). Use targeted, non-recursive removal.",
		};
	}
	if (
		/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/(?!tmp\b|var\/tmp\b)/i.test(cmd) ||
		/\brm\s+-rf\s+\*/i.test(cmd)
	) {
		return {
			decision: "block",
			reason: "BLOCKED: Recursive deletion of root-level or wildcard paths. Be more specific.",
		};
	}
	if (
		/\brm\s+(-[rf]+\s+)*\.wrangler\s*($|&&|\||;)/.test(cmd) ||
		/\brm\s+(-[rf]+\s+)*\.wrangler\/state\b/.test(cmd)
	) {
		return {
			decision: "block",
			reason:
				"BLOCKED: .wrangler contains the local development database. Try: rm -rf .wrangler/cache (keeps database)",
		};
	}
	if (/\brm\s+(-[rf]+\s+)*node_modules\s*($|&&|\||;)/.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: Deleting node_modules requires a full reinstall. Try: npm cache clean --force && npm install",
		};
	}
	if (/\bdd\s.*of=\/dev\//i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: Writing directly to block devices with dd." };
	}
	if (/(^|\s|;|&&)(mkfs|fdisk|parted|gdisk)\s/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: Disk formatting/partitioning commands." };
	}
	if (/\bchmod\s+(-R\s+)?777\s+\//i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: chmod 777 on system paths is a security risk." };
	}
	if (/\bsudo\s+rm\b/.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: sudo rm is extremely dangerous." };
	}
	return null;
}

function dcgCheckDatabaseDestruction(cmd: string): DestructiveCommandVerdict | null {
	if (/\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Destructive database operations (DROP/TRUNCATE).",
		};
	}
	if (/\bDELETE\s+FROM\s+\w+\s*;/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: DELETE without WHERE clause removes all rows." };
	}
	if (/\b(dropDatabase|dropCollection)\s*\(/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: MongoDB drop operations." };
	}
	if (/\bredis-cli\s.*(FLUSHALL|FLUSHDB)/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: Redis FLUSHALL/FLUSHDB clears all data." };
	}
	return null;
}

function dcgCheckContainerOrchestration(cmd: string): DestructiveCommandVerdict | null {
	if (/\bdocker\s+(system|volume|image)\s+prune/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: docker prune removes potentially important data." };
	}
	if (/\bdocker[- ]compose\s+down\s+-v/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: docker-compose down -v removes volumes (data loss). Use 'down' without -v.",
		};
	}
	if (/\bkubectl\s+delete\s+(namespace|ns|all)\s/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: kubectl mass deletion. Delete specific resources instead.",
		};
	}
	if (/\bkubectl\s+drain\s/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: kubectl drain evicts all pods from a node." };
	}
	return null;
}

function dcgCheckInfraAsCode(cmd: string): DestructiveCommandVerdict | null {
	if (/\bterraform\s+destroy/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: terraform destroy removes infrastructure." };
	}
	if (/\bterraform\s+apply\s+.*-auto-approve/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: terraform apply -auto-approve skips human review." };
	}
	if (/\bpulumi\s+destroy/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: pulumi destroy removes infrastructure." };
	}
	return null;
}

function dcgCheckCloudProvider(cmd: string): DestructiveCommandVerdict | null {
	if (/\baws\s.*(terminate-instances|delete-db-instance|delete-stack|delete-bucket)/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: AWS destructive operations." };
	}
	if (/\baws\s+s3\s+(rm|mv)\s+.*--recursive/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: Recursive S3 operations." };
	}
	if (/\brsync\s+.*--delete/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: rsync --delete can wipe files at the destination.",
		};
	}
	return null;
}

function dcgCheckSystemLevel(cmd: string): DestructiveCommandVerdict | null {
	// Re-checks shutdown/reboot directly (the early dcgMatchesShutdown gate
	// also runs, before the data-only skip); kept so this ladder mirrors
	// the harness rule at builtin-rules-processes.ts one-to-one.
	if (
		/(^|\|\||&&|[;|\n])\s*(?:(?:env(?:\s+[A-Za-z_]\w*=\S+)*|command|exec|nohup|sudo)\s+|(?:bash|sh)\s+-c\s*["']?\s*)*(shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(poweroff|reboot|halt))\b/i.test(cmd)
	) {
		return { decision: "block", reason: "BLOCKED: System shutdown/reboot commands." };
	}
	if (/\b(lvremove|vgremove|pvremove)\s/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: LVM removal commands." };
	}
	return null;
}

/** Fetch-and-execute: a download piped (or process-substituted) into a shell
 *  or interpreter. Red-team F2 — this is the hole UNDER the supply-chain
 *  guard: installs are default-deny across ten ecosystems, and `curl | sh`
 *  runs remote code with no manifest, registry, allowlist entry or pin. Sinks
 *  are shells/interpreters only, so `| jq` / `| grep` stay allowed; the fetch
 *  verb is required, so piping a LOCAL file into sh is untouched. String
 *  concat, not template literals — this module is embedded into a backtick
 *  template (see DESTRUCTIVE_COMMAND_GUARD_SOURCE). */
function dcgCheckRemoteExecution(cmd: string): DestructiveCommandVerdict | null {
	const fetchVerb = "(?:curl|wget|fetch)";
	// Interpreter + an inline-code flag cluster (-c, -e, -r, -ne, -pe) means the
	// pipe is DATA and the program is the argv literal; exempt it (2026-08-11).
	// Shells have no exemption (they always execute stdin).
	const sink =
		"(?:sudo\\s+)?(?:(?:ba|z|k|da)?sh|(?:python3?|perl|ruby|node|php)(?!\\s+-[a-zA-Z]*[cerm]\\b))";
	const piped = new RegExp("\\b" + fetchVerb + "\\b[^|]*\\|\\s*" + sink + "\\b", "i");
	const subst = new RegExp("\\b" + sink + "\\b\\s*<\\(\\s*[^)]*\\b" + fetchVerb + "\\b", "i");
	if (!piped.test(cmd) && !subst.test(cmd)) return null;
	return {
		decision: "block",
		reason:
			"BLOCKED: remote code execution — a download piped into a shell/interpreter runs " +
			"unreviewed remote code and bypasses the package allowlist entirely. Download to a " +
			"file, read it, then run it deliberately; or install the dependency through its " +
			"package manager so the supply-chain gate can screen it.",
	};
}

function dcgCheckEmbeddedDestructive(cmd: string): DestructiveCommandVerdict | null {
	if (/(python3?|node|ruby|perl)\s+-(c|e)\s+.*\b(os\.remove|shutil\.rmtree|unlink|rimraf)\b/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: Inline script containing destructive file operations.",
		};
	}
	if (/\bbash\s+-c\s+.*\b(rm\s+-rf|killall|pkill)\b/i.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: Destructive command embedded in bash -c. Run directly so it can be properly reviewed.",
		};
	}
	return null;
}

// Module-scope indirection for the two identifiers `checkDestructiveCommand`
// references that now live in sibling modules (`dcgMatchesShutdown`,
// `dcgCheckGitDestruction`). A bundler inlines a cross-module named-import
// call as a bare identifier reference (verified against the tsup/esbuild
// output, which is what actually ships), but a per-module dev transform can
// rewrite an import's OWN name wherever it's used, including inside a
// function whose source text later gets captured via `.toString()`. Routing
// through a same-file alias keeps checkDestructiveCommand's serialized body
// free of any identifier that isn't itself declared inside this joined
// `DESTRUCTIVE_COMMAND_GUARD_SOURCE` blob — these two lines are re-declared
// there verbatim, right below their `AGENT_WORKTREE_CREATE_COMMAND_PATTERN`
// sibling.
const dcgShutdownCheck = dcgMatchesShutdown;
const dcgChecks: DestructiveCheck[] = [
	dcgCheckSleep,
	dcgCheckProcessKilling,
	dcgCheckFilesystemDestruction,
	dcgCheckWorktreeCreation,
	dcgCheckGitDestruction,
	dcgCheckDatabaseDestruction,
	dcgCheckContainerOrchestration,
	dcgCheckInfraAsCode,
	dcgCheckCloudProvider,
	dcgCheckSystemLevel,
	dcgCheckRemoteExecution,
	dcgCheckEmbeddedDestructive,
];

/**
 * Detect destructive shell commands — process killing, recursive deletes,
 * history-rewriting git, DROP/TRUNCATE, infra teardown, and so on. A pure
 * function of the command string: no fs, no env, no state, so it is safe to
 * run inline on any hook path. Returns a block verdict, or `null` when the
 * command is not destructive.
 *
 * Two early gates (shutdown/reboot, then the data-only skip) run first, then
 * one rule-family check per line of shell activity, in the same priority
 * order as the original flat ladder. Every family is its own top-level
 * function (see above) so no single unit carries the whole ladder's
 * complexity — see the module header for why they all stay free-standing
 * function declarations rather than nested closures.
 */
export function checkDestructiveCommand(cmd: string): DestructiveCommandVerdict | null {
	if (dcgShutdownCheck(cmd)) {
		return { decision: "block", reason: "BLOCKED: System shutdown/reboot commands." };
	}

	// Context detection: skip data-only references (grep/echo/cat examining strings).
	if (
		/^\s*(grep|egrep|fgrep|rg|ag|echo|printf|cat|head|tail|less|more|wc|diff|test|\[)\s/.test(cmd)
	) {
		return null;
	}

	for (const check of dcgChecks) {
		const verdict = check(cmd);
		if (verdict) return verdict;
	}
	return null;
}

/**
 * Source text of every helper above plus `checkDestructiveCommand`, joined as
 * a run of plain function declarations, for embedding into the zero-import
 * generated .mjs hook (which cannot `import`). `guards-inline.ts` splices
 * this in verbatim (no wrapping `const x = ` — the blob already contains a
 * `function checkDestructiveCommand(...) {}` declaration) so the .mjs and
 * `hook-entry.ts` run identical code. Function declarations hoist, so
 * call order inside the joined blob doesn't matter.
 */
export const DESTRUCTIVE_COMMAND_GUARD_SOURCE: string = [
	`const AGENT_WORKTREE_CREATE_COMMAND_PATTERN = ${JSON.stringify(AGENT_WORKTREE_CREATE_COMMAND_PATTERN)};`,
	agentWorktreeCreationBlockReason,
	dcgCheckWorktreeCreation,
	dcgMaskCommentStep,
	dcgMaskQuoteStep,
	dcgMaskUnquotedStep,
	dcgMaskInlineQuotedShell,
	dcgMatchesShutdown,
	dcgCheckSleep,
	dcgCheckProcessKilling,
	dcgCheckFilesystemDestruction,
	dcgCheckGitDataLoss,
	dcgCheckGitInteractiveOrRewrite,
	dcgCheckGitDestruction,
	dcgCheckDatabaseDestruction,
	dcgCheckContainerOrchestration,
	dcgCheckInfraAsCode,
	dcgCheckCloudProvider,
	dcgCheckSystemLevel,
	dcgCheckRemoteExecution,
	dcgCheckEmbeddedDestructive,
	"const dcgShutdownCheck = dcgMatchesShutdown;",
	"const dcgChecks = [dcgCheckSleep, dcgCheckProcessKilling, dcgCheckFilesystemDestruction, dcgCheckWorktreeCreation, dcgCheckGitDestruction, dcgCheckDatabaseDestruction, dcgCheckContainerOrchestration, dcgCheckInfraAsCode, dcgCheckCloudProvider, dcgCheckSystemLevel, dcgCheckRemoteExecution, dcgCheckEmbeddedDestructive];",
	checkDestructiveCommand,
]
	.map((entry) => (typeof entry === "function" ? entry.toString() : entry))
	.join("\n");
