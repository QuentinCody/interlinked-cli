// ===========================================
// Phase 1 Channel 6 — Failure-cause explanation
// ===========================================
// Plain-language explanation of why a failure happened. Distinct from
// Channel 3 (suggestRecovery) which says HOW to fix it; this one says WHAT
// happened so the agent (and a reading human) understands the diagnosis.
//
// Cloud upgrade tier: a small specialist that produces 1-3 sentences for
// uncategorized failures and caches by signature.

import type {
	ExplanationTemplate,
	RecoveryContext,
	ToolFailureEvent,
	TriageResult,
} from "../types.js";

const EXPLANATION_TEMPLATES: Record<string, ExplanationTemplate> = {
	"agent-error/missing-import": {
		template: (ctx) => {
			const mod = ctx.module ?? "<module>";
			return (
				`The module \`${mod}\` couldn't be resolved. Common causes: ` +
				`(1) the package isn't installed, ` +
				`(2) the import path is wrong (typo, case-sensitive on Linux), ` +
				`(3) the package's "exports" map doesn't expose this subpath, or ` +
				`(4) tsconfig "paths" / "moduleResolution" needs updating.`
			);
		},
	},
	"agent-error/missing-symbol": {
		template: (ctx) => {
			const symbol = ctx.symbol ?? "<symbol>";
			return (
				`\`${symbol}\` isn't a known name in this scope — TypeScript walked the ` +
				`imports, locals, and globals and didn't find it. Either the import is ` +
				`missing, the export was removed, or the name is misspelled.`
			);
		},
	},
	"agent-error/type-mismatch": {
		template: () =>
			`TypeScript rejected the value because its declared type doesn't match the ` +
			`expected type at this position. This catches real category errors at compile ` +
			`time — the fix is almost always to change the value or its source type, not ` +
			`the call site.`,
	},
	"agent-error/missing-property": {
		template: () =>
			`The property doesn't exist on the type's known shape. Either the type needs ` +
			`updating to include it, or the access is on the wrong object.`,
	},
	"agent-error/unused-declaration": {
		template: () =>
			`A declared identifier was never referenced. The strict-tsconfig rule treats ` +
			`this as a bug because most of the time it's a forgotten import or a stub that ` +
			`outlived its purpose.`,
	},
	"agent-error/git-conflict": {
		template: () =>
			`Two histories disagreed on the same lines. Git can't pick a winner — you have ` +
			`to read both sides, decide on the right answer, and remove the conflict markers.`,
	},
	"agent-error/test-failure": {
		template: () =>
			`The assertion the test expressed didn't hold against the implementation. Either ` +
			`the implementation is wrong (most common when the test is specific and recent) ` +
			`or the test's expectation is wrong (less common).`,
	},
	"agent-error/auth": {
		template: () =>
			`The provider rejected the credential. Either it's missing, expired, scoped ` +
			`incorrectly, or revoked. Don't paste a new key into source — set it in the ` +
			`environment.`,
	},
	"environmental/filesystem-missing": {
		template: () =>
			`No file/directory exists at the path. The most common cause is a stale ` +
			`assumption about where things are — verify with \`ls\` before retrying.`,
	},
	"environmental/filesystem-permission": {
		template: () =>
			`The OS denied write access. The harness usually intercepts protected paths; ` +
			`if it didn't, the path may not be in our protected set yet.`,
	},
	"transient/network-refused": {
		template: () =>
			`The target accepted the SYN packet but refused the connection — either the ` +
			`port isn't listening or a firewall dropped the packet.`,
	},
	"transient/rate-limit": {
		template: () =>
			`The provider returned a rate-limit signal. Their server is intentionally ` +
			`slowing this client down; respect the cooldown.`,
	},
	"unrecoverable/process-crash": {
		template: () =>
			`The subprocess crashed with a non-graceful signal — usually a memory bug in ` +
			`the called program, not in the agent's input.`,
	},
};

const FALLBACK_BY_LABEL: Record<string, string> = {
	"agent-error":
		"The error suggests a mistake on the agent side — code that doesn't compile, " +
		"a wrong path, or a bad assumption about the project's shape.",
	environmental:
		"The error suggests an environment issue rather than a code defect.",
	transient:
		"The error pattern matches transient infrastructure flakes (network, rate-limit, DNS).",
	unrecoverable:
		"The error suggests a hard stop — the called program crashed or was killed externally.",
	unknown: "",
};

/** Public API — the harness handler calls this once per failure. Returns
 *  null when no useful explanation can be produced; callers should skip
 *  emitting the channel in that case. */
export function explainFailure(
	event: ToolFailureEvent,
	triage: TriageResult,
): string | null {
	const key = `${triage.label}/${triage.category}`;
	const tmpl = EXPLANATION_TEMPLATES[key];
	if (tmpl) {
		try {
			return tmpl.template(buildContext(event));
		} catch {
			// non-fatal: fall through to the label fallback rather than crashing the channel.
		}
	}
	const fallback = FALLBACK_BY_LABEL[triage.label];
	return fallback || null;
}

/** Public API for tests. */
export function listExplanationKeys(): readonly string[] {
	return Object.keys(EXPLANATION_TEMPLATES);
}

function buildContext(event: ToolFailureEvent): RecoveryContext {
	const ctx: RecoveryContext = {
		tool: event.tool_name,
		error: event.error_message ?? event.stderr ?? "",
	};
	const errorText = ctx.error;
	if (errorText) {
		// Reuse the same module-name extractor shape as recovery-suggestion;
		// keeping the fields aligned means a single context can feed both
		// channels without re-extraction.
		const moduleMatch = /Cannot find module ['"]([^'"]+)['"]/.exec(errorText);
		if (moduleMatch?.[1]) ctx.module = moduleMatch[1];
		const symbolMatch = /Cannot find name ['"]?([^'"\s]+)['"]?/.exec(errorText);
		if (symbolMatch?.[1]) ctx.symbol = symbolMatch[1];
	}
	const filePath =
		event.tool_input && typeof event.tool_input.file_path === "string"
			? event.tool_input.file_path
			: "";
	if (filePath) ctx.file = filePath;
	return ctx;
}
