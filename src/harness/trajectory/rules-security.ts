// ===========================================
// Deterministic Trajectory-Analysis Engine — Family 5: Security Exfil / Self-Blinding
// ===========================================
//
// The one family where `block` is common. Per the catalog every block path is a
// deterministic two-step: an INDEPENDENT prior leg folded into state plus a
// trigger leg read from the current event — ≥2 independent deterministic
// signals, near-zero FP. Block rules evaluate at PreToolUse so the verdict can
// stop the action before it lands; the one nudge (dns burst) evaluates at
// PostToolUse where the lookups have accumulated.
//
// SECRET-PATTERN NOTE: secret detection lives in helpers.ts and matches
// credential SHAPES, not real secrets.

import {
	detectAllSecretLiterals,
	detectSecretLiteral,
	isEditEvent,
	isEgressCommandToExternalHost,
	sha256,
} from "./helpers.js";
import {
	commandAppendsAuthorizedKeys,
	commitReferencesPath,
	containsSshPublicKey,
	extractExecutedPath,
	inlineFetchExec,
	isAuthorizedKeysPath,
	isGitAddOrCommit,
	isGuardedOp,
	parseHarnessDisable,
	triggersGitHook,
} from "./helpers-commands.js";
import type { DownloadRecord, ToolEvent, TrajectoryRule, TrajectoryState, Verdict } from "./types.js";

function isPreBash(event: ToolEvent): boolean {
	return event.hook === "PreToolUse" && event.tool === "Bash";
}
function isPreEdit(event: ToolEvent): boolean {
	return event.hook === "PreToolUse" && isEditEvent(event);
}
function block(ruleId: string, severity: Verdict["severity"], reason: string): Verdict {
	return { ruleId, action: "block", severity, reason: `BLOCKED: ${reason}` };
}
function editContent(event: ToolEvent): string {
	return event.input.content ?? event.input.new_string ?? "";
}

// ============================================================
// sec_fetch_remote_script_then_execute (B/H)
// ============================================================
// curl/wget an external script then run it (cross-event or inline `curl|bash`).
// FP guard: allowlist the official one-liner installer hosts.
const INSTALLER_HOSTS =
	/(?:^|\.)(?:rustup\.rs|docker\.com|deno\.land|bun\.sh|astral\.sh|brew\.sh|nodesource\.com|python-poetry\.org|sdkman\.io|nixos\.org|pnpm\.io|nvm\.sh|get\.helm\.sh)$/i;
function isAllowlistedInstallerHost(host: string): boolean {
	return INSTALLER_HOSTS.test(host.toLowerCase().replace(/\.$/, ""));
}
function findDownloadForExec(state: TrajectoryState, execPath: string): DownloadRecord | null {
	const direct = state.downloadedScripts.get(execPath);
	if (direct) return direct;
	const base = execPath.split("/").pop() ?? execPath;
	for (const [p, d] of state.downloadedScripts) {
		if (execPath.endsWith(p) || p.endsWith(execPath) || (p.split("/").pop() ?? p) === base) return d;
	}
	return null;
}
const secFetchRemoteScriptThenExecute: TrajectoryRule = (state, event) => {
	if (!isPreBash(event)) return null;
	const cmd = event.input.command;
	if (!cmd) return null;
	const inline = inlineFetchExec(cmd);
	if (inline && !isAllowlistedInstallerHost(inline.host)) {
		return block(
			"sec_fetch_remote_script_then_execute",
			"high",
			`a script is being fetched from ${inline.host} and piped straight into a shell. ` +
				"Download-and-run of an unverified remote script is the textbook supply-chain " +
				"compromise — save it, read it, then run it (or use the vendor's signed installer).",
		);
	}
	const execPath = extractExecutedPath(cmd);
	if (execPath) {
		const dl = findDownloadForExec(state, execPath);
		if (dl && dl.isScript && !isAllowlistedInstallerHost(dl.host)) {
			return block(
				"sec_fetch_remote_script_then_execute",
				"high",
				`${execPath} was downloaded from ${dl.host} earlier this session and is now being ` +
					"executed. Verify the artifact's contents before running a fetched script.",
			);
		}
	}
	return null;
};

// ============================================================
// sec_env_add_then_git_commit (B/H)
// ============================================================
// A structured secret was written into a tracked .env/config file, then a git
// add/commit would include that path. FP guard: structured-secret detection
// (so FOREIGN_KEY / PUBLIC_KEY etc. never qualify) + the file must be env/config.
const secEnvAddThenGitCommit: TrajectoryRule = (state, event) => {
	if (!isPreBash(event)) return null;
	const cmd = event.input.command;
	if (!cmd || !isGitAddOrCommit(cmd)) return null;
	for (const [path, pending] of state.pendingSecretWrites) {
		if (commitReferencesPath(cmd, path)) {
			return block(
				"sec_env_add_then_git_commit",
				"high",
				`a ${pending.kind} secret was written into ${path} this session and this git command ` +
					"would commit it. Committing a live credential leaks it into history — remove the " +
					"secret (use an env var / .gitignored local file) before committing.",
			);
		}
	}
	return null;
};

// ============================================================
// sec_secret_literal_flows_to_command (B/H)
// ============================================================
// A prefix-structured secret token introduced via an edit appears verbatim as
// an argument to an egress command to an external host (taint flow).
export const secSecretLiteralFlowsToCommand: TrajectoryRule = (state, event) => {
	if (!isPreBash(event)) return null;
	const cmd = event.input.command;
	if (!cmd || !isEgressCommandToExternalHost(cmd)) return null;
	for (const token of state.taintedSecretTokens) {
		if (token.length < 12 || !cmd.includes(token)) continue;
		const kind = detectSecretLiteral(token)?.kind ?? "secret";
		return block(
			"sec_secret_literal_flows_to_command",
			"high",
			`a ${kind} introduced into the working tree this session is being passed verbatim to an ` +
				"outbound network command. This is direct secret exfiltration — do not send credentials " +
				"to external hosts.",
		);
	}
	return null;
};

// ============================================================
// sec_git_hook_backdoor (B/H)
// ============================================================
// A .git/hooks/* file with an exec/egress sink was written, then a git op that
// fires that hook runs. FP guard: BOTH the sink AND the triggering op required.
const HOOK_GROUPS: Record<string, ReadonlySet<string>> = {
	"pre-commit": new Set(["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]),
	"pre-push": new Set(["pre-push"]),
	"post-merge": new Set(["post-merge"]),
	"post-checkout": new Set(["post-checkout"]),
	"pre-rebase": new Set(["pre-rebase", "post-rewrite"]),
	"applypatch-msg": new Set(["applypatch-msg", "pre-applypatch", "post-applypatch"]),
};
function hookTriggeredBy(triggered: string, written: string): boolean {
	return HOOK_GROUPS[triggered]?.has(written) ?? false;
}
const secGitHookBackdoor: TrajectoryRule = (state, event) => {
	if (!isPreBash(event)) return null;
	const cmd = event.input.command;
	if (!cmd) return null;
	const hook = triggersGitHook(cmd);
	if (!hook) return null;
	for (const [name, w] of state.gitHookWrites) {
		if (w.hasSink && hookTriggeredBy(hook, name)) {
			return block(
				"sec_git_hook_backdoor",
				"high",
				`the .git/hooks/${name} hook was given an exec/egress sink this session, and this git ` +
					"command would fire it. A git-hook backdoor runs attacker code on an ordinary git " +
					"operation — inspect and remove the hook before proceeding.",
			);
		}
	}
	return null;
};

// ============================================================
// sec_ssh_authorized_keys_inject (B/H)
// ============================================================
// Append an SSH public key to a real-$HOME ~/.ssh/authorized_keys. Two signals
// on one event: the home-confined path AND public-key content. FP guard:
// project/tmp/fixture/CI paths are excluded by isAuthorizedKeysPath.
const secSshAuthorizedKeysInject: TrajectoryRule = (_state, event) => {
	if (event.hook !== "PreToolUse") return null;
	if (isEditEvent(event)) {
		const file = event.input.file_path;
		if (file && isAuthorizedKeysPath(file) && containsSshPublicKey(editContent(event))) {
			return block(
				"sec_ssh_authorized_keys_inject",
				"high",
				`an SSH public key is being written into ${file}. Injecting a key into authorized_keys ` +
					"installs a persistent remote-access backdoor — confirm this is an intended, " +
					"authorized key for your own account.",
			);
		}
	}
	if (event.tool === "Bash") {
		const cmd = event.input.command ?? "";
		const target = commandAppendsAuthorizedKeys(cmd);
		if (target && containsSshPublicKey(cmd)) {
			return block(
				"sec_ssh_authorized_keys_inject",
				"high",
				`an SSH public key is being appended to ${target.path}. This installs a persistent ` +
					"remote-access backdoor — confirm the key and the intent.",
			);
		}
	}
	return null;
};

// ============================================================
// sec_harness_disable_then_guarded_op (B/H)
// ============================================================
// The harness was disabled (socket removed / daemon killed / disabled_rules
// grown) earlier this session, then a guarded op runs. FP guard: the documented
// INTERLINKED_DISABLE_* bypass and `interlinked harness stop|restart|clean`
// are treated as sanctioned (parseHarnessDisable returns null for them).
const secHarnessDisableThenGuardedOp: TrajectoryRule = (state, event) => {
	if (!isPreBash(event) || !state.harnessDisabled) return null;
	const cmd = event.input.command;
	if (!cmd) return null;
	if (parseHarnessDisable(cmd)) return null; // the disable op itself, not the follow-up
	if (!isGuardedOp(cmd)) return null;
	return block(
		"sec_harness_disable_then_guarded_op",
		"high",
		`the safety harness was disabled earlier this session (${state.harnessDisabled.how}) and a ` +
			"guarded operation (egress / destructive / commit / secret read) is now running with the " +
			"guard down. Re-enable the harness before performing guarded operations.",
	);
};

// ============================================================
// sec_dns_exfil_burst (N/H)
// ============================================================
// After a credential read, ≥3 distinct high-entropy DNS labels to one base
// domain (the burst substrate is filtered for entropy + hex in state folding).
const DNS_BURST_THRESHOLD = 3;
const secDnsExfilBurst: TrajectoryRule = (state, event) => {
	if (event.hook !== "PostToolUse" || event.tool !== "Bash") return null;
	if (state.lastSecretReadStep === 0) return null;
	const byDomain = new Map<string, Set<string>>();
	for (const q of state.dnsQueries) {
		if (q.atStep <= state.lastSecretReadStep) continue;
		let labels = byDomain.get(q.baseDomain);
		if (!labels) {
			labels = new Set();
			byDomain.set(q.baseDomain, labels);
		}
		labels.add(q.label);
	}
	for (const [domain, labels] of byDomain) {
		if (labels.size >= DNS_BURST_THRESHOLD) {
			return {
				ruleId: "sec_dns_exfil_burst",
				action: "nudge",
				severity: "high",
				reason:
					`After reading credential material, ${labels.size} DNS lookups with distinct ` +
					`high-entropy labels were issued to ${domain}. This is the DNS-tunnel exfiltration ` +
					"shape (data smuggled in query names) — confirm the lookups are legitimate.",
			};
		}
	}
	return null;
};

// ============================================================
// session_secret_persistence (B/H)
// ============================================================
// A high-confidence structured secret is being written into the working tree.
// Block ONLY the highest-confidence shapes (PEM header / AKIA / GitHub PAT /
// Anthropic key) — the structured prefix + fixed charset/length is itself the
// near-zero-FP signal the catalog requires.
const sessionSecretPersistence: TrajectoryRule = (_state, event) => {
	if (!isPreEdit(event)) return null;
	const content = editContent(event);
	if (!content) return null;
	const m = detectSecretLiteral(content);
	if (!m || !m.high) return null;
	const old = event.input.old_string ?? "";
	if (old.includes(m.token)) return null; // pre-existing secret, not newly introduced
	const file = event.input.file_path ?? "the edited file";
	return block(
		"session_secret_persistence",
		"high",
		`this edit writes a high-confidence ${m.kind} into ${file}. A live credential must never land ` +
			"in the working tree — use an environment variable, a secret manager, or a placeholder.",
	);
};

// ============================================================
// xsr_reintroduce_scrubbed_secret (B/H) — in-session variant
// ============================================================
// A structured secret removed earlier this session is being re-added. The full
// catalog rule also consults git history (`git log -S`); this in-session
// variant fires on the scrub→re-add pair observed within the session and is the
// part implementable without a git-pickaxe capture.
const xsrReintroduceScrubbedSecret: TrajectoryRule = (state, event) => {
	if (!isPreEdit(event) || state.scrubbedSecretHashes.size === 0) return null;
	const content = editContent(event);
	if (!content) return null;
	const old = event.input.old_string ?? "";
	for (const m of detectAllSecretLiterals(content)) {
		if (old.includes(m.token)) continue; // already present, not a re-add
		if (state.scrubbedSecretHashes.has(sha256(m.token))) {
			return block(
				"xsr_reintroduce_scrubbed_secret",
				"high",
				`this edit re-introduces a ${m.kind} that was scrubbed from the working tree earlier ` +
					"this session. Re-adding a removed credential undoes the cleanup — keep it out of the tree.",
			);
		}
	}
	return null;
};

/** All Family-5 security rules. */
export const SECURITY_RULES: ReadonlyArray<TrajectoryRule> = [
	secFetchRemoteScriptThenExecute,
	secEnvAddThenGitCommit,
	secSecretLiteralFlowsToCommand,
	secGitHookBackdoor,
	secSshAuthorizedKeysInject,
	secHarnessDisableThenGuardedOp,
	secDnsExfilBurst,
	sessionSecretPersistence,
	xsrReintroduceScrubbedSecret,
];
