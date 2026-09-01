// GitHub Actions workflow-injection detector. Lives outside the language-
// specific check directory because workflow YAMLs are neither JS/TS nor
// Python source — they are CI configuration whose attack surface (shell
// expansion of untrusted GitHub-event payloads) is its own category.

import { nonNull } from "../../lib/non-null.js";
import { type InlineMatch, isTestFile, isVendoredOrFixturePath } from "./shared.js";

/** Path gate: any `.yml` / `.yaml` under a `.github/workflows/` directory. */
function isGithubWorkflowPath(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	if (!/\.ya?ml$/i.test(norm)) return false;
	return /(^|\/)\.github\/workflows\//.test(norm);
}

/**
 * `ubs_github_actions_injection` — interpolating a GitHub-event field that an
 * attacker can populate (PR title, issue body, commit message, head ref,
 * `client_payload.*`, etc.) directly into a workflow expression embeds
 * attacker-controlled text in shell. Inside a `run:` block this is direct
 * command injection at the workflow's privilege level; in other expression
 * contexts (`if:`, `env:`) it is still a code-injection risk depending on
 * downstream usage.
 *
 * The safe pattern is env-var indirection:
 *
 *     env:
 *       TITLE: ${{ github.event.pull_request.title }}
 *     run: echo "$TITLE"
 *
 * Detection lists the attacker-controllable fields explicitly so unrelated
 * `github.event.repository.name` references (safe) do not trip. pre_warn /
 * warning. Files outside `.github/workflows/*.y[a]ml` are not evaluated.
 */
export function checkGithubActionsInjection(content: string, filePath: string): InlineMatch[] {
	if (!isGithubWorkflowPath(filePath)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Each alternative is one attacker-controllable field path. Bounded
	// character runs keep the regex linear-time. `client_payload.*` is the
	// `repository_dispatch` event's free-form bag — any subpath is attacker-
	// controlled and matches via the trailing wildcard.
	const dangerous =
		/\$\{\{\s*github\.event\.(?:issue\.(?:title|body|user\.login)|pull_request\.(?:title|body|head\.(?:ref|label|repo\.default_branch))|comment\.body|review\.body|review_comment\.body|head_commit\.(?:message|author\.(?:email|name))|commits\.\d+\.(?:message|author\.(?:email|name))|pages\.\d+\.page_name|client_payload\.[A-Za-z_][\w.]*)\s*\}\}|\$\{\{\s*github\.head_ref\s*\}\}/g;

	for (const m of content.matchAll(dangerous)) {
		if (matches.length >= 10) break;
		const idx = m.index;
		const lineNum = content.slice(0, idx).split("\n").length;
		if (matches.some((mx) => mx.line === lineNum)) continue;
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}
	return matches;
}
