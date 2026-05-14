// ===========================================
// interlinked metacoder — toggle + inspect the per-prompt overlay generator
// ===========================================
//
// The metacoder runs on every UserPromptSubmit and generates a session-
// scoped overlay of guard rules using the user's Claude Code / Codex CLI
// subscription. It's heavyweight (5–30 s wall-clock per prompt) and not
// free (Opus-4.7 max-effort / GPT-5.5 xhigh). This command lets users
// flip it on/off without restarting the harness — `rules-loader.ts`
// hot-reloads `guard-rules.local.json` on the next file watcher tick.
//
// Mirrors the `interlinked scanner` toggle pattern: a tiny JSON merge
// into `.interlinked/guard-rules.local.json` plus an append-only audit
// log at `.interlinked/metacoder.audit.jsonl` so reviewers can answer
// "when was the metacoder off, and why?".
//
// Design plan: docs/design/metacoding-agent-plan.md §2.1 (latency
// rationale), §reviewer-P1 round 6 (stale-overlay eviction when
// disabled).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output } from "../lib/output.js";

const LOCAL_RULES_FILE = "guard-rules.local.json";
const AUDIT_LOG_FILE = "metacoder.audit.jsonl";
const TYPEOF_OBJECT = "object" as const;
const NO_CHANGE_ACTION = "no_change" as const;

export interface MetacoderToggleOptions {
	reason?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

export interface MetacoderStatusOptions {
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

type AuditAction = "enable" | "disable" | "no_change";

interface AuditEntry {
	ts: string;
	action: AuditAction;
	from?: boolean;
	to?: boolean;
	actor: {
		user: string;
		host: string;
		tty: string | null;
		via: "cli";
	};
	reason: string | null;
}

interface AuditEntryArgs {
	action: AuditAction;
	from: boolean;
	to: boolean;
	reason: string | null;
}

function getLocalRulesPath(cwd: string): string {
	return join(getConfigDir(cwd), LOCAL_RULES_FILE);
}

function getAuditLogPath(cwd: string): string {
	return join(getConfigDir(cwd), AUDIT_LOG_FILE);
}

function isPlainObject(v: unknown): v is JsonObject {
	return typeof v === TYPEOF_OBJECT && v !== null && !Array.isArray(v);
}

/** Public — also called by callers that want to read the resolved flag
 *  without spawning the full status command. Returns `true` when the
 *  field is absent (metacoder defaults to enabled, per
 *  `DEFAULT_METACODER_CONFIG.enabled`); only returns `false` when
 *  explicitly disabled in `guard-rules.local.json`. */
export function readCurrentMetacoderEnabled(cwd: string): boolean {
	const path = getLocalRulesPath(cwd);
	if (!existsSync(path)) return true;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as JsonObject;
		const block = raw?.metacoder;
		if (!isPlainObject(block)) return true;
		return block.enabled !== false;
	} catch (err) {
		// Malformed JSON is fail-open — the default is enabled, and we
		// don't want a typo in the config file to silently shut down the
		// metacoder. `interlinked verify` will surface the syntax error
		// on next run; users see the metacoder still running here.
		void err;
		return true;
	}
}

/** Merge-write the `metacoder.enabled` flag into `guard-rules.local.json`.
 *  Preserves every other field in the file. */
function writeEnabledFlag(cwd: string, enabled: boolean): void {
	const path = getLocalRulesPath(cwd);
	let parsed: JsonObject = {};
	if (existsSync(path)) {
		try {
			const raw = readFileSync(path, "utf-8");
			const obj: unknown = JSON.parse(raw);
			if (isPlainObject(obj)) parsed = obj;
		} catch (err) {
			process.stderr.write(
				`[interlinked:metacoder] Warning: ${path} was unparseable; overwriting (${err instanceof Error ? err.message : String(err)})\n`,
			);
		}
	}
	const block = isPlainObject(parsed.metacoder) ? parsed.metacoder : {};
	block.enabled = enabled;
	parsed.metacoder = block;
	writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

function resolveTty(): string | null {
	if (process.stdout.isTTY) {
		return process.env.SSH_TTY || process.env.TTY || null;
	}
	return null;
}

function appendAudit(cwd: string, entry: AuditEntry): void {
	const path = getAuditLogPath(cwd);
	try {
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch (err) {
		process.stderr.write(
			`[interlinked:metacoder] Warning: failed to write audit log (${err instanceof Error ? err.message : String(err)})\n`,
		);
	}
}

function buildAuditEntry(args: AuditEntryArgs): AuditEntry {
	const info = userInfo();
	return {
		ts: new Date().toISOString(),
		action: args.action,
		from: args.from,
		to: args.to,
		actor: { user: info.username, host: hostname(), tty: resolveTty(), via: "cli" },
		reason: args.reason,
	};
}

function deriveAction(current: boolean, target: boolean): AuditAction {
	if (current === target) return NO_CHANGE_ACTION;
	return target ? "enable" : "disable";
}

async function applyToggle(
	cwd: string,
	target: boolean,
	opts: MetacoderToggleOptions,
): Promise<void> {
	const current = readCurrentMetacoderEnabled(cwd);
	const action = deriveAction(current, target);
	writeEnabledFlag(cwd, target);
	appendAudit(
		cwd,
		buildAuditEntry({ action, from: current, to: target, reason: opts.reason ?? null }),
	);

	const mode = getOutputMode(opts);
	const auditPath = getAuditLogPath(cwd);
	const payload = {
		enabled: target,
		changed: current !== target,
		previous: current,
		audit_path: auditPath,
		reason: opts.reason ?? null,
		note: "Harness hot-reloads guard-rules.local.json on the next file-watcher tick (~2 s).",
	};
	output(mode, payload, {
		json: () => payload,
		short: () =>
			`${target ? "enabled" : "disabled"}${current === target ? " (no change)" : ""}`,
		normal: () =>
			renderToggleResult({ current, target, reason: opts.reason ?? null, auditPath }),
	});
}

interface ToggleRenderArgs {
	current: boolean;
	target: boolean;
	reason: string | null;
	auditPath: string;
}

function renderToggleResult(args: ToggleRenderArgs): string {
	const lines: string[] = [header("Metacoder")];
	lines.push(kvLine("State", args.target ? c.green("enabled") : c.dim("disabled")));
	if (args.current !== args.target) {
		lines.push(
			kvLine(
				"Transition",
				`${args.current ? "on" : "off"} → ${args.target ? "on" : "off"}`,
			),
		);
	} else {
		lines.push(kvLine("Transition", c.dim("no change")));
	}
	if (args.reason) lines.push(kvLine("Reason", args.reason));
	lines.push(kvLine("Audit", c.dim(args.auditPath)));
	lines.push("");
	lines.push(
		c.dim(
			"Hot-reloads on the next file-watcher tick (~2 s). For active sessions, the overlay applies starting at the next UserPromptSubmit.",
		),
	);
	return lines.join("\n");
}

export async function metacoderEnableCommand(opts: MetacoderToggleOptions): Promise<void> {
	await applyToggle(process.cwd(), true, opts);
}

export async function metacoderDisableCommand(opts: MetacoderToggleOptions): Promise<void> {
	await applyToggle(process.cwd(), false, opts);
}

export async function metacoderStatusCommand(opts: MetacoderStatusOptions): Promise<void> {
	const cwd = process.cwd();
	const enabled = readCurrentMetacoderEnabled(cwd);
	const localRulesPath = getLocalRulesPath(cwd);
	const auditPath = getAuditLogPath(cwd);
	const recent = readRecentAudit(auditPath, 5);

	const mode = getOutputMode(opts);
	const payload = {
		enabled,
		local_rules_path: localRulesPath,
		audit_path: auditPath,
		recent_audit: recent,
		notes: [
			"Toggle: 'interlinked metacoder enable' / 'interlinked metacoder disable'",
			"Auth: uses your Claude Code (claude -p) or Codex (codex exec) subscription — no API key needed",
			"Latency: 5–30 s per prompt (Opus 4.7 max-effort / GPT-5.5 xhigh)",
			"Design: docs/design/metacoding-agent-plan.md",
		],
	};
	const ctx: StatusRenderContext = { enabled, localRulesPath, auditPath, recent };
	output(mode, payload, {
		json: () => payload,
		short: () => (enabled ? "enabled" : "disabled"),
		normal: () => renderStatusCompact(ctx),
		full: () => renderStatusFull(ctx),
	});
}

interface StatusRenderContext {
	enabled: boolean;
	localRulesPath: string;
	auditPath: string;
	recent: AuditEntry[];
}

/** Compact status — shows up to 3 recent audit rows. Default. */
function renderStatusCompact(ctx: StatusRenderContext): string {
	const COMPACT_AUDIT_LIMIT = 3;
	return renderStatusBody(ctx, ctx.recent.slice(0, COMPACT_AUDIT_LIMIT));
}

/** Full status — shows every recent audit row currently in memory. */
function renderStatusFull(ctx: StatusRenderContext): string {
	return renderStatusBody(ctx, ctx.recent);
}

function renderStatusBody(ctx: StatusRenderContext, auditRows: AuditEntry[]): string {
	const lines: string[] = [header("Metacoder")];
	lines.push(kvLine("State", ctx.enabled ? c.green("enabled") : c.dim("disabled")));
	lines.push(kvLine("Config", c.dim(ctx.localRulesPath)));
	lines.push(kvLine("Audit log", c.dim(ctx.auditPath)));
	lines.push("");
	if (auditRows.length === 0) {
		lines.push(c.dim("No audit entries yet. Toggle with 'interlinked metacoder enable|disable'."));
	} else {
		lines.push(c.dim(`Recent toggles (last ${auditRows.length}):`));
		for (const entry of auditRows) {
			const arrow = formatAuditArrow(entry);
			const reason = entry.reason ? ` — ${entry.reason}` : "";
			lines.push(c.dim(`  ${entry.ts}  ${entry.action}  ${arrow}${reason}`));
		}
	}
	lines.push("");
	lines.push(
		c.dim("Latency: 5–30 s per UserPromptSubmit. Auth: Claude Code / Codex subscription (no API key)."),
	);
	lines.push(c.dim("Plan: docs/design/metacoding-agent-plan.md"));
	return lines.join("\n");
}

/** Format the transition arrow for an audit row. Extracted so the
 *  renderStatus loop stays flat and the nested-ternary linter rule
 *  doesn't fire. */
function formatAuditArrow(entry: AuditEntry): string {
	if (entry.from === entry.to) return "•";
	return entry.to ? "→ on" : "→ off";
}

function readRecentAudit(path: string, limit: number): AuditEntry[] {
	if (!existsSync(path)) return [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		void err;
		return [];
	}
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const tail = lines.slice(Math.max(0, lines.length - limit));
	const entries: AuditEntry[] = [];
	for (const line of tail) {
		try {
			entries.push(JSON.parse(line) as AuditEntry);
		} catch (err) {
			// Skip malformed lines — the audit log is append-only and a
			// truncated last line during shutdown is non-fatal.
			void err;
		}
	}
	return entries.reverse();
}
