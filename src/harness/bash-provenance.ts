// Bash CLI provenance classifier and taint-source recorder.
//
// Some web-fetching Bash CLIs (`gh issue view`, `curl <url>`, `wget`, ...)
// pull attacker-controllable content. The existing taint-tracker tags
// `WebFetch` / `WebSearch` results as `fetched_external`, but a Bash-routed
// equivalent gets no provenance tag — so the lethal-trifecta and partial-leg
// detectors silently underperform when the agent uses gh CLI instead of
// WebFetch.
//
// This module closes that gap. `classifyBashCommandProvenance` is a pure
// shape-matcher over the command string; `recordBashTaintSource` appends a
// taint source to the session so the sequence detectors and the existing
// `checkProvenanceTaintToExternalAction` see the provenance.
//
// Patterns to recognize (initial set; extensible). Each entry pins a verb
// or verb-pair that fetches attacker-controllable content from the open
// internet OR a public package registry.

import { classifyNetworkIntent, fetchesPublicContent } from "./network-intent.js";
import type { SessionTrajectory, TaintProvenance } from "./types.js";

/** Maximum length of the `file` field on the synthesized taint source. The
 *  raw Bash command can be long; bound it to keep `taint_sources` memory
 *  use linear in invocation count, not command length. */
const TAINT_FILE_MAX_LENGTH = 200;

/** GitHub CLI verbs that fetch attacker-controllable content (issue / PR /
 *  gist bodies or raw API responses). Not `gh auth status`, `gh repo list`,
 *  etc. — those don't surface user-authored content the agent might act on. */
const GH_FETCH_VERBS: ReadonlyArray<RegExp> = [
	/\bgh\s+issue\s+view\b/,
	/\bgh\s+pr\s+view\b/,
	/\bgh\s+gist\s+view\b/,
	/\bgh\s+api\b/,
];

/** GitLab CLI equivalents. */
const GLAB_FETCH_VERBS: ReadonlyArray<RegExp> = [
	/\bglab\s+issue\s+view\b/,
	/\bglab\s+mr\s+view\b/,
];

/** Package-registry query commands. `npm view <pkg>` returns the registry's
 *  metadata for a package — which includes author-supplied README, homepage,
 *  description, and bin scripts. `pip show <pkg>` is the PyPI equivalent. */
const REGISTRY_QUERY_VERBS: ReadonlyArray<RegExp> = [
	/\bnpm\s+view\b/,
	/\bpip\s+show\b/,
];

/**
 * Pure classifier — returns the {@link TaintProvenance} that should be
 * attributed to the output of this Bash command, or `null` when the command
 * doesn't match a known web-fetching shape.
 *
 * Conservative: when in doubt, returns `null` so the taint-source list
 * doesn't fill with noise.
 */
export function classifyBashCommandProvenance(command: string): TaintProvenance | null {
	if (!command) return null;
	for (const verb of GH_FETCH_VERBS) {
		if (verb.test(command)) return "fetched_external";
	}
	for (const verb of GLAB_FETCH_VERBS) {
		if (verb.test(command)) return "fetched_external";
	}
	for (const verb of REGISTRY_QUERY_VERBS) {
		if (verb.test(command)) return "fetched_external";
	}
	// A fetch that actually runs (curl / wget / httpie / yt-dlp head, or an
	// interpreter inline program calling a network API) from a literal PUBLIC
	// host. Before 2026-10-05 this was a word test for curl|wget|http|https plus
	// any non-localhost URL, so every local command that merely NAMED a URL
	// (`echo <url>`, `rg '<url>'`, a python string) added a fetched_external
	// source and inflated leg 2 of the lethal trifecta.
	return fetchesPublicContent(classifyNetworkIntent(command)) ? "fetched_external" : null;
}

/**
 * Append a taint source to `session.taint_sources` recording that the given
 * Bash command's output should be treated as the given provenance. Level is
 * fixed at `Public` — the provenance axis is independent from sensitivity
 * and the common case is "public but untrusted" (an attacker-controlled
 * issue body is Public-sensitivity, `fetched_external`-provenance). Callers
 * needing to escalate sensitivity should use `ratchetSensitivity` separately.
 *
 * Always appends, unlike `ratchetSensitivity` (which only pushes on level
 * escalation) — without this, a Public-sensitivity Bash fetch would leave
 * the provenance unrecorded.
 */
export function recordBashTaintSource(
	session: SessionTrajectory,
	command: string,
	provenance: TaintProvenance,
): void {
	const truncated =
		command.length > TAINT_FILE_MAX_LENGTH
			? `${command.slice(0, TAINT_FILE_MAX_LENGTH)}…`
			: command;
	session.taint_sources.push({
		file: `<bash:${truncated}>`,
		level: "Public",
		at_step: session.tool_call_count,
		provenance,
	});
}
