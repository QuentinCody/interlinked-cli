// ===========================================
// Ephemeral-write ledger
// ===========================================
// Every write aimed at a path the OS will purge — the session scratchpad,
// /tmp, any other temp root — gets one append-only record here, regardless of
// extension. The extension part matters: the placement guard only ever
// inspected CODE extensions (`CODE_FILE_EXT_RE`), so the single largest class
// of ephemeral write in the recorded corpus — `.json` gate-workaround manifests
// — passed with no warning and no trace. Writes that leave no record cannot be
// audited, and "I could not see it happening" was how a hand-rolled patch
// applier lived in a scratchpad for a whole session.
//
// This is a LEDGER, not a gate: it never blocks and never throws. Query it with
// `interlinked query .interlinked/ephemeral-writes.jsonl`.

import { appendFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

/** What the write appears to be, from path + extension alone. Drives the
 *  advisory steer; recorded so the mix can be re-derived later without
 *  re-running the classifier. */
type EphemeralWriteKind = "code" | "manifest" | "agent-output" | "bulk" | "other";

interface EphemeralWriteRecord {
	/** ISO timestamp. */
	ts: string;
	session_id: string | undefined;
	/** Tool that issued the write (Write / Edit / MultiEdit). */
	tool: string;
	/** Absolute resolved target. */
	path: string;
	/** Lowercased extension including the dot, or "" when extensionless. */
	ext: string;
	bytes: number;
	kind: EphemeralWriteKind;
	/** True when a guard blocked this write — the record is the ATTEMPT, so a
	 *  blocked evasion still leaves a trace. */
	blocked: boolean;
}

/** Extensions that carry captured output from an external agent/tool run —
 *  Codex/Sol audit results, review transcripts, long analyses. */
const OUTPUT_EXT_RE = /\.(?:md|txt|log|html)$/i;
/** Filename shapes that mark such captured output specifically, as opposed to
 *  an incidental note. Kept to unambiguous vocabulary — a `notes.md` is not
 *  claimed to be an audit artifact. */
const AGENT_OUTPUT_NAME_RE =
	/(?:review|audit|finding|report|result|analysis|transcript|codex|sol-|prompt)/i;
const BULK_EXT_RE = /\.(?:tgz|tar|gz|zip|7z|whl|jar|bin|so|dylib|dll|pdf|png|jpe?g|gif|webp)$/i;
const CODE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|rb|php|cs|java|kt|swift|sh|bash|zsh)$/i;

/**
 * Classify an ephemeral write from its path alone. Pure — no fs, no config.
 *
 * Public API: consumed by the scratchpad guard for the advisory steer and by
 * this module's own record builder.
 */
export function classifyEphemeralWrite(absPath: string): EphemeralWriteKind {
	const lower = absPath.toLowerCase();
	if (CODE_EXT_RE.test(lower)) return "code";
	if (BULK_EXT_RE.test(lower)) return "bulk";
	if (OUTPUT_EXT_RE.test(lower) && AGENT_OUTPUT_NAME_RE.test(lower)) return "agent-output";
	if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")) {
		return "manifest";
	}
	return "other";
}

/**
 * Append one ephemeral-write record to `<projectRoot>/.interlinked/`. No-ops
 * when that directory is absent — it always exists in a guarded repo (the
 * harness socket lives there), so its absence means this is not a managed
 * project and creating one would be an unasked-for side effect. Filesystem
 * errors are swallowed: a ledger that can crash the daemon is worse than a
 * ledger with a gap.
 *
 * Public API — consumed by evaluator/scratchpad-write-guard.ts.
 */
export function appendEphemeralWrite(projectRoot: string, record: EphemeralWriteRecord): void {
	try {
		const dir = join(projectRoot, ".interlinked");
		if (!existsSync(dir)) return;
		appendFileSync(join(dir, "ephemeral-writes.jsonl"), `${JSON.stringify(record)}\n`);
	} catch {
		// Telemetry must never break the hook path.
	}
}

/**
 * Build the record for one attempted ephemeral write. Split from the appender
 * so callers can construct-and-inspect in tests without touching disk.
 *
 * Public API — consumed alongside {@link appendEphemeralWrite}.
 */
export function buildEphemeralWriteRecord(opts: {
	sessionId: string | undefined;
	tool: string;
	absPath: string;
	content: string;
	blocked: boolean;
	now?: () => string;
}): EphemeralWriteRecord {
	return {
		ts: (opts.now ?? (() => new Date().toISOString()))(),
		session_id: opts.sessionId,
		tool: opts.tool,
		path: opts.absPath,
		ext: extname(opts.absPath).toLowerCase(),
		bytes: Buffer.byteLength(opts.content, "utf-8"),
		kind: classifyEphemeralWrite(opts.absPath),
		blocked: opts.blocked,
	};
}
