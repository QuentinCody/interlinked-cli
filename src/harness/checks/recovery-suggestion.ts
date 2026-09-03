// ===========================================
// Phase 1 Channel 3 — Recovery suggestion
// ===========================================
// Local template-driven suggestion: triage label + category → actionable fix.
// The agent reads the suggestion in additionalContext / warnings[] on its
// next turn and uses it to plan the recovery tool call.
//
// Cloud upgrade tier (LLM-generated unified diff with sandbox dry-run) lands
// in Phase 3. The public surface (suggestRecovery) stays the same so the
// harness handler is one-line wired regardless of tier.
//
// Adding a new template:
//   1. Append to RECOVERY_SUGGESTIONS keyed `${label}/${category}`. Categories
//      come from src/harness/checks/failure-triage.ts.
//   2. Update src/harness/checks/__tests__/recovery-suggestion.test.ts with
//      ≥3 positive cases.

import type { RecoveryContext, RecoverySuggestion, ToolFailureEvent, TriageResult } from "../types.js";

const RECOVERY_SUGGESTIONS: Record<string, RecoverySuggestion> = {
	"agent-error/missing-import": {
		template: (ctx) => {
			const symbol = ctx.symbol ?? "<symbol>";
			const mod = ctx.module ?? "<module>";
			return (
				`Add the missing import: \`import { ${symbol} } from "${mod}";\`. ` +
				`If the package isn't installed locally, check \`npm ls ${mod}\` ` +
				`(or the equivalent for the project's package manager).`
			);
		},
		extract: (errorMessage) =>
			/Cannot find module ['"](?<module>[^'"]+)['"]/.exec(errorMessage),
	},
	"agent-error/missing-symbol": {
		template: (ctx) => {
			const symbol = ctx.symbol ?? "<symbol>";
			return (
				`The symbol \`${symbol}\` isn't in scope. ` +
				`Either it's missing an import, it was renamed, or it's typo'd. ` +
				`Search the project for the canonical name before guessing.`
			);
		},
		extract: (errorMessage) =>
			/Cannot find name ['"]?(?<symbol>[^'"\s]+)['"]?/.exec(errorMessage),
	},
	"agent-error/type-mismatch": {
		template: () =>
			`The argument type doesn't match the parameter type. Read the function ` +
			`signature at the call site. If the type is correct but inference is wrong, ` +
			`add an explicit type assertion (\`fn(value as ExpectedType)\`) — but only ` +
			`as a last resort; prefer fixing the source type.`,
	},
	"agent-error/missing-property": {
		template: () =>
			`The property doesn't exist on the type. Check the struct/interface ` +
			`definition. If you're trying to add a new field, update the type first.`,
	},
	"agent-error/unused-declaration": {
		template: () =>
			`Declared but never used — either remove the declaration or actually use it. ` +
			`If it's an interface for an external API, prefix it with \`_\` to opt out.`,
	},
	"agent-error/type-error": {
		template: () =>
			`The TypeScript compiler rejected this. Read the full \`tsc\` output for ` +
			`the line/column and fix the type — don't \`@ts-ignore\` it.`,
	},
	"agent-error/git-conflict": {
		template: () =>
			`Merge conflict in the working tree. Open the conflicted files, resolve the ` +
			`\`<<<<<<<\`/\`=======\`/\`>>>>>>>\` markers, \`git add\` the resolved files, ` +
			`then continue (\`git commit\` for a merge, \`git rebase --continue\` for a rebase).`,
	},
	"agent-error/pre-commit": {
		template: () =>
			`A pre-commit hook failed. Read the hook output, fix the underlying issue ` +
			`(formatting, lint, type-check), then re-stage and re-commit. Do NOT use ` +
			`\`--no-verify\`.`,
	},
	"agent-error/test-failure": {
		template: () =>
			`Tests are failing. Read the failing assertion, isolate which test in the ` +
			`output, and run that single test in watch mode (\`vitest watch <file>\` / ` +
			`\`jest --watch\`). Fix the implementation or the test, not both at once.`,
	},
	"agent-error/assertion": {
		template: () =>
			`Assertion failed. The diff between expected and actual is your fix target — ` +
			`don't change the assertion to match the implementation; understand why the ` +
			`implementation produced the wrong value.`,
	},
	"agent-error/auth": {
		template: () =>
			`Authentication failed. Verify the API key / token is set in env ` +
			`(\`echo $TOKEN_NAME\`) and not stale. Don't paste credentials into source ` +
			`files — the harness will block that.`,
	},
	"agent-error/dns-resolution": {
		template: () =>
			`DNS lookup failed for the host. Check the URL for typos. If the host is ` +
			`internal-only, you may be on the wrong network.`,
	},
	"agent-error/missing-package": {
		template: (ctx) => {
			const mod = ctx.module ?? "<package>";
			return (
				`The package \`${mod}\` isn't published or the name is wrong. Check ` +
				`\`npm view ${mod}\` for canonical naming. Don't blindly run ` +
				`\`npm install <wrong-name>\` — pick the right package first.`
			);
		},
	},
	"agent-error/package-script": {
		template: () =>
			`A package script (\`npm run <name>\`) failed. Read the script's actual error ` +
			`output above the \`npm ERR!\` lines — npm just relays it. Fix the underlying ` +
			`script, not the npm wrapper.`,
	},
	"agent-error/filesystem-shape": {
		template: () =>
			`Filesystem state mismatch (file vs directory, exists vs missing). Verify ` +
			`with \`ls\` before retrying — your assumption about the path shape is wrong.`,
	},
	"environmental/filesystem-missing": {
		template: () =>
			`File or directory doesn't exist at this path. Verify the path is correct ` +
			`(\`ls\` the parent), or create the parent first if you intended to write a new file.`,
	},
	"environmental/filesystem-permission": {
		template: () =>
			`Permission denied. The harness usually blocks writes to protected paths — ` +
			`check whether the path is one we shouldn't write to (CI config, secrets, ` +
			`/etc, etc.). If it's legitimate, ask the user to fix the permissions.`,
	},
	"environmental/git-state": {
		template: () =>
			`Not a git repository. \`cd\` to the project root, or run \`git init\` if ` +
			`this is a fresh project.`,
	},
	"environmental/out-of-memory": {
		template: () =>
			`The process ran out of heap. If this is Node, raise \`--max-old-space-size\`. ` +
			`If it's a build, try a smaller scope (single package / single test file).`,
	},
	"transient/network-refused": {
		template: () =>
			`Connection refused. The target service isn't accepting connections — it may ` +
			`be down or you may be hitting the wrong port. Don't retry blindly; verify ` +
			`the target is up first (\`curl <host>:<port>\` from a known-good shell).`,
	},
	"transient/network-timeout": {
		template: () =>
			`Connection timed out. Retry once. If it times out again, the target is ` +
			`unreachable — escalate rather than spinning.`,
	},
	"transient/dns": {
		template: () =>
			`DNS resolution flapped (EAI_AGAIN). Retry once after a short pause; this is ` +
			`almost always transient.`,
	},
	"transient/rate-limit": {
		template: () =>
			`Rate-limited. Wait at least 30s before retrying, or use a different provider/key. ` +
			`Repeated retries make this worse.`,
	},
	"transient/user-interrupt": {
		template: () =>
			`The user interrupted the call. Don't retry automatically — wait for the user's ` +
			`next instruction.`,
	},
	"unrecoverable/process-crash": {
		template: () =>
			`A process crashed (segfault). Don't retry — this isn't a fix you can make from ` +
			`this side. Escalate with the stack trace if available.`,
	},
	"unrecoverable/process-killed": {
		template: () =>
			`Process was killed (SIGKILL). Likely OOM or external signal. Don't retry ` +
			`without changing the input — same input will produce the same kill.`,
	},
};

const FALLBACK_BY_LABEL: Record<string, string> = {
	"agent-error":
		"This looks like an agent-side mistake. Re-read the error message carefully, " +
		"don't guess — the diagnostic usually names the exact symbol/path/type that's wrong.",
	environmental:
		"This looks like an environment problem (filesystem, OS, project state). " +
		"Don't try to work around it in code — fix the environment or surface the gap to the user.",
	transient:
		"This looks transient. Retry once. If it fails the same way again, treat it as " +
		"non-transient and escalate.",
	unrecoverable:
		"This looks unrecoverable from the agent side. Stop retrying; surface the failure " +
		"to the user with the diagnostic.",
	unknown: "",
};

/** Public API — the harness handler calls this once per failure. Returns
 *  null when no useful suggestion can be produced (e.g., unknown triage with
 *  no diagnostic text); callers should skip emitting the channel in that
 *  case rather than printing an empty line. */
export function suggestRecovery(
	event: ToolFailureEvent,
	triage: TriageResult,
): string | null {
	const key = `${triage.label}/${triage.category}`;
	const suggestion = RECOVERY_SUGGESTIONS[key];
	const ctx = buildContext(event, suggestion);
	if (suggestion) {
		try {
			return suggestion.template(ctx);
		} catch {
			// non-fatal: the template threw on a context shape it didn't expect —
			// fall through to the by-label fallback rather than crashing the channel.
		}
	}
	const fallback = FALLBACK_BY_LABEL[triage.label];
	return fallback || null;
}

/** Public API for tests. */
export function listRecoveryKeys(): readonly string[] {
	return Object.keys(RECOVERY_SUGGESTIONS);
}

function buildContext(event: ToolFailureEvent, suggestion?: RecoverySuggestion): RecoveryContext {
	const errorText = event.error_message ?? event.stderr ?? "";
	const ctx: RecoveryContext = {
		tool: event.tool_name,
		error: errorText,
	};
	const filePath =
		event.tool_input && typeof (event.tool_input as { file_path?: unknown }).file_path === "string"
			? ((event.tool_input as { file_path?: string }).file_path ?? "")
			: "";
	if (filePath) ctx.file = filePath;
	applySuggestionExtract(ctx, suggestion, errorText);
	return ctx;
}

function applySuggestionExtract(ctx: RecoveryContext, suggestion: RecoverySuggestion | undefined, errorText: string): void {
	if (!suggestion?.extract || !errorText) return;
	const match = suggestion.extract(errorText);
	if (!match?.groups) return;
	for (const [key, value] of Object.entries(match.groups)) {
		if (typeof value === "string") ctx[key] = value;
	}
}
