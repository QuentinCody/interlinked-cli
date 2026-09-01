// ===========================================
// interlinked skill — Skill marker management
// ===========================================
// Posts SkillEnter / SkillLeave / SkillList events to the harness via Unix
// socket. Skill markers populate `SessionTrajectory.active_skills`, which the
// active_when predicate evaluator reads to scope distilled rules. See
// docs/design/harness-active-when-scoping.md.

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { c, header, kvLine, table } from "../lib/formatter.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { getSocketPath } from "./harness.js";

interface ActiveSkillRecord {
	name: string;
	entered_at: number;
	expires_at: number;
	source: "cli" | "hook" | "manual";
}

interface SkillListSession {
	session_id: string;
	agent_name: string;
	skills: ActiveSkillRecord[];
}

const SOCKET_TIMEOUT_MS = 2000;

export async function skillEnterCommand(
	// `string`, not `string | undefined`, is what commander's `enter <name>`
	// required-positional-arg wiring promises — but this function is exported
	// and callable directly (tests do so deliberately), so a caller outside
	// that one commander action can still hand `undefined` at runtime.
	name: string | undefined,
	opts: { ttl?: string; session?: string; source?: string; json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts);
	const trimmed = name?.trim();
	if (!trimmed) {
		outputError(mode, "skill name required");
		process.exitCode = 1;
		return;
	}
	const ttlSeconds = opts.ttl ? parseTtl(opts.ttl) : undefined;
	if (opts.ttl && ttlSeconds === null) {
		outputError(mode, `invalid --ttl '${opts.ttl}'. Use a duration like 30m, 1h, 90s.`);
		process.exitCode = 1;
		return;
	}

	const reply = await sendSkillEvent({
		hook_event: "SkillEnter",
		session_id: opts.session ?? "",
		tool_input: {
			name: trimmed,
			...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}),
			...(opts.source ? { source: opts.source } : {}),
		},
	});

	if (!reply) {
		outputError(mode, "Could not reach harness — is `interlinked harness start` running?");
		process.exitCode = 1;
		return;
	}

	output(mode, { skill: trimmed, status: "entered" }, {
		json: () => ({ skill: trimmed, status: "entered", ttl_seconds: ttlSeconds ?? null }),
		normal: () => `${c.green("✓")} skill entered: ${c.bold(trimmed)}${ttlSeconds ? c.dim(` (ttl ${formatTtl(ttlSeconds)})`) : ""}`,
	});
}

export async function skillLeaveCommand(
	// See the comment on `skillEnterCommand` above: the type is honestly
	// optional because this exported function can be called directly with
	// `undefined`, not only through commander's required `<name>` arg.
	name: string | undefined,
	opts: { session?: string; json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts);
	const trimmed = name?.trim();
	if (!trimmed) {
		outputError(mode, "skill name required");
		process.exitCode = 1;
		return;
	}

	const reply = await sendSkillEvent({
		hook_event: "SkillLeave",
		session_id: opts.session ?? "",
		tool_input: { name: trimmed },
	});

	if (!reply) {
		outputError(mode, "Could not reach harness — is `interlinked harness start` running?");
		process.exitCode = 1;
		return;
	}

	output(mode, { skill: trimmed, status: "left" }, {
		json: () => ({ skill: trimmed, status: "left" }),
		normal: () => `${c.green("✓")} skill left: ${c.bold(trimmed)}`,
	});
}

/** Boundary parsers for the harness's `SkillList` reply — a `JSON.stringify`d
 *  array the daemon writes into `additional_context`. Field access below
 *  (`s.skills.length`, `sk.expires_at`, …) would throw on a shape mismatch if
 *  this were an unchecked `as SkillListSession[]`, so every level is
 *  validated and the array fails closed as a whole on the first bad entry —
 *  matching the existing "malformed skill list" error for JSON syntax
 *  errors, just extended to shape errors too. */
function parseActiveSkillRecord(value: unknown): ActiveSkillRecord | null {
	if (!isJsonObject(value)) return null;
	const { name, entered_at, expires_at, source } = value;
	if (typeof name !== "string") return null;
	if (typeof entered_at !== "number") return null;
	if (typeof expires_at !== "number") return null;
	if (source !== "cli" && source !== "hook" && source !== "manual") return null;
	return { name, entered_at, expires_at, source };
}

function parseSkillListSession(value: unknown): SkillListSession | null {
	if (!isJsonObject(value)) return null;
	const { session_id, agent_name, skills } = value;
	if (typeof session_id !== "string") return null;
	if (typeof agent_name !== "string") return null;
	if (!Array.isArray(skills)) return null;
	// Array.isArray narrows to `any[]`; re-type explicitly so `entry` stays
	// `unknown` through the loop instead of silently `any`.
	const rawSkills: unknown[] = skills;
	const parsedSkills: ActiveSkillRecord[] = [];
	for (const entry of rawSkills) {
		const rec = parseActiveSkillRecord(entry);
		if (!rec) return null;
		parsedSkills.push(rec);
	}
	return { session_id, agent_name, skills: parsedSkills };
}

function parseSkillListSessions(value: unknown): SkillListSession[] | null {
	if (!Array.isArray(value)) return null;
	// Array.isArray narrows to `any[]`; re-type explicitly (same reasoning as
	// parseSkillListSession above).
	const rawSessions: unknown[] = value;
	const sessions: SkillListSession[] = [];
	for (const entry of rawSessions) {
		const session = parseSkillListSession(entry);
		if (!session) return null;
		sessions.push(session);
	}
	return sessions;
}

export async function skillListCommand(
	opts: { session?: string; json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts);

	const reply = await sendSkillEvent({
		hook_event: "SkillList",
		session_id: opts.session ?? "",
		tool_input: {},
	});

	if (!reply) {
		outputError(mode, "Could not reach harness — is `interlinked harness start` running?");
		process.exitCode = 1;
		return;
	}

	const raw = reply.additional_context;
	let parsed: SkillListSession[] = [];
	if (typeof raw === "string" && raw.length > 0) {
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			outputError(mode, "harness returned malformed skill list");
			process.exitCode = 1;
			return;
		}
		const sessions = parseSkillListSessions(json);
		if (!sessions) {
			outputError(mode, "harness returned malformed skill list");
			process.exitCode = 1;
			return;
		}
		parsed = sessions;
	}

	output(mode, parsed, {
		json: () => parsed,
		normal: () => formatSkillListNormal(parsed),
	});
}

function formatSkillListNormal(sessions: SkillListSession[]): string {
	if (sessions.length === 0) {
		return c.dim("No active sessions.");
	}
	const lines: string[] = [];
	lines.push(header("Active skills"));
	const now = Date.now();
	let total = 0;
	for (const s of sessions) {
		if (s.skills.length === 0) continue;
		lines.push("");
		lines.push(`${c.bold(s.agent_name)} ${c.dim(`(${s.session_id.slice(0, 8)})`)}`);
		const rows: Array<[string, string, string, string]> = s.skills.map((sk) => [
			sk.name,
			formatTtl(Math.max(0, Math.round((sk.expires_at - now) / 1000))),
			sk.source,
			new Date(sk.entered_at).toISOString().slice(11, 19),
		]);
		lines.push(table(["skill", "expires in", "source", "entered (utc)"], rows));
		total += s.skills.length;
	}
	if (total === 0) {
		return c.dim("No active skills across all sessions.");
	}
	lines.push("");
	lines.push(kvLine("total", String(total)));
	return lines.join("\n");
}

function parseTtl(raw: string): number | null {
	const m = raw.trim().match(/^(\d+)([smh]|min|sec|hr)?$/i);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = (m[2] || "s").toLowerCase();
	if (unit === "s" || unit === "sec") return n;
	if (unit === "m" || unit === "min") return n * 60;
	if (unit === "h" || unit === "hr") return n * 3600;
	return n;
}

function formatTtl(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round((seconds / 3600) * 10) / 10}h`;
}

function sendSkillEvent(event: JsonObject): Promise<JsonObject | null> {
	return new Promise((resolve) => {
		const socketPath = getSocketPath();
		if (!existsSync(socketPath)) {
			resolve(null);
			return;
		}

		const payload = {
			...event,
			timestamp: new Date().toISOString(),
			agent_source: "cli",
		};

		const sock = createConnection(socketPath);
		const timeout = setTimeout(() => {
			try {
				sock.destroy();
			} catch {
				/* non-fatal: the socket is already gone */
			}
			resolve(null);
		}, SOCKET_TIMEOUT_MS);

		let data = "";
		sock.on("connect", () => {
			sock.write(`${JSON.stringify(payload)}\n`);
		});
		sock.on("data", (chunk) => {
			data += chunk.toString();
			const nlIdx = data.indexOf("\n");
			if (nlIdx !== -1) {
				clearTimeout(timeout);
				sock.destroy();
				try {
					resolve(JSON.parse(data.slice(0, nlIdx)) as JsonObject);
				} catch {
					resolve(null);
				}
			}
		});
		sock.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
	});
}
