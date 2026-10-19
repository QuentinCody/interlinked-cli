// ===========================================
// Secret-shaped Read output: same origin decision as Bash output
// ===========================================
// Before 2026-10-05 only Bash output was secret-scanned, so an agent could Read
// a credentials-shaped file from an unlisted path (no file_sensitivity glob)
// and send it out with the session still Public (H3 §6 A). The Read tool's
// output now runs through the same signature scan, the same caps
// (`output_scanning.scan_bash_secrets` — the one secret-output switch — and
// `max_scan_bytes`), and THE same origin decision (secret-output-origin.ts
// `classifySecretOrigin`):
//   - file recorded as fetched (external-origin-files.ts) and unchanged ⇒ public:
//     level unchanged, audit source `<read:public-origin>`, warning;
//   - every occurrence inside a registered public-credential context ⇒ Internal;
//   - committed test fixture (committed-test-fixture.ts) ⇒ Internal;
//   - anything else ⇒ Confidential, source `<read: sig-… in <path>>`.
// Dry runs warn but change no session state.

import { resolve } from "node:path";
import { isCommittedTestFixture } from "../committed-test-fixture.js";
import { scheduleSecretHitShadow } from "../jev/secret-shadow.js";
import { scanSecrets } from "../signatures.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";
import { externalOriginOf, redactedExcerpt } from "./external-origin-files.js";
import { applySecretOrigin, classifySecretOrigin, SECRET_ADVICE, type SecretOrigin } from "./secret-output-origin.js";
import { isReadOperation } from "./tool-classifiers.js";
import { readToolString } from "./tool-input-values.js";

/** Same floor as the Bash output scan (post-tool.ts OUTPUT_SCAN_MIN_BYTES). */
const READ_SCAN_MIN_BYTES = 10;

/** The text a Read showed the agent: Claude Code's `{file:{content}}`, a plain
 *  string (other runners), or the JSON text of any other shape. */
export function readResponseText(response: unknown): string {
	if (response === undefined || response === null) return "";
	if (typeof response === "string") return response;
	if (typeof response === "object" && "file" in response) {
		const file: unknown = response.file;
		if (typeof file === "object" && file !== null && "content" in file && typeof file.content === "string") return file.content;
	}
	return JSON.stringify(response);
}

function readWarning(origin: SecretOrigin, idList: string, shown: string): string {
	if (origin.kind === "fetched") {
		return `[interlinked:output-scan] secret-shaped value (${idList}) in ${shown}, fetched from ${origin.origin} — treated as public; session sensitivity unchanged. ${SECRET_ADVICE}`;
	}
	if (origin.kind === "public-context") {
		return `[interlinked:output-scan] secret-shaped value (${idList}) in ${shown} sits in a documented public-credential context (${origin.contexts.join(", ")}) — session sensitivity raised to Internal, not Confidential. ${SECRET_ADVICE}`;
	}
	if (origin.kind === "committed-fixture") {
		return `[interlinked:output-scan] secret-shaped value (${idList}) in ${shown} is committed test-fixture data — session sensitivity raised to Internal, not Confidential. ${SECRET_ADVICE}`;
	}
	return `[interlinked:output-scan] Secrets detected in file read ${shown}: ${idList}. ${SECRET_ADVICE}`;
}

/** PostToolUse, Read tool: secret-signature scan of the output with origin rules.
 *  `projectRoot` is the daemon's root (the committed-fixture rule trusts only
 *  its git work tree, never the event's cwd). */
export function scanReadSecretLeaks(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	projectRoot: string = process.cwd(),
	/** `actorKeyOf` of the reader; it and its ancestors ratchet (B3). */
	actor?: string,
): string[] {
	const scanning = rules.output_scanning;
	const rawPath = readToolString(event.tool_input?.file_path);
	if (!scanning?.enabled || !scanning.scan_bash_secrets || !isReadOperation(event.tool_name) || !rawPath) return [];
	const text = readResponseText(event.tool_response).slice(0, scanning.max_scan_bytes);
	const matches = text.length > READ_SCAN_MIN_BYTES ? scanSecrets(text) : [];
	if (matches.length === 0) return [];
	// U1 decision shadow (default OFF): second opinion logged on a later tick.
	scheduleSecretHitShadow(event, rules, text, matches);
	const ruleIds = matches.map((m) => m.rule_id);
	const idList = ruleIds.join(", ");
	const path = resolve(event.cwd || process.cwd(), rawPath);
	const shown = redactedExcerpt(path);
	const taint = rules.taint_tracking;
	if (!session || !taint?.enabled || event.dry_run === true) return [readWarning({ kind: "local" }, idList, shown)];
	const origin = classifySecretOrigin({
		text,
		ruleIds,
		fetchedOrigins: () => {
			const entry = externalOriginOf(session, path);
			return entry ? [entry.source] : null;
		},
		committedFixture: () => isCommittedTestFixture({ path, text, ruleIds, projectRoot, taint }),
	});
	applySecretOrigin({ session, taint, sourceFile: "<read>", where: `in ${shown}`, actor }, origin, idList);
	return [readWarning(origin, idList, shown)];
}
