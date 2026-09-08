import { wireAbsentOptional, parseWire, wireArray, wireNullable, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
// ===========================================
// interlinked cloud — inspect the cloud governor
// ===========================================
// Subcommands:
//   recent   — GET /admin/recent from the configured cloud governor and
//              render the most recent events + verdicts.
//
// Reads `cloud_governor.url` from `.interlinked/config.local.json` and
// authenticates with the OAuth access_token (the same token the daemon's
// cloud-forward uses, set by `interlinked login`). /admin/recent is OAuth-
// gated and returns events for the caller's own workspace (derived from the
// token's props). See docs/design/cloud-governor-architecture.md §4.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthToken } from "../lib/auth.js";
import { c, relativeTime, table } from "../lib/formatter.js";
import { isJsonObject } from "../lib/json-types.js";

/** Parse the `cloud_governor.url` field out of a parsed config.local.json
 *  value. Returns null when the value isn't an object, the `cloud_governor`
 *  block is missing/not an object, or `url` is missing/empty/non-string. */
export function parseCloudGovernorUrl(value: unknown): string | null {
	if (!isJsonObject(value)) return null;
	const cg = value.cloud_governor;
	if (!isJsonObject(cg)) return null;
	const url = cg.url;
	return typeof url === "string" && url.length > 0 ? url : null;
}

/** Read cloud_governor.url from config.local.json. Returns null when the file
 *  is missing, unparseable, or the block lacks a url. */
export function loadCloudUrl(cwd: string): string | null {
	try {
		const path = join(cwd, ".interlinked", "config.local.json");
		if (!existsSync(path)) return null;
		return parseCloudGovernorUrl(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return null;
	}
}

/** Resolve the /admin/recent URL from the configured evaluate URL. Uses URL
 *  resolution against the origin so any path/query on the source is discarded
 *  (the evaluate URL ends in /governor/evaluate; we want /admin/recent on the
 *  same origin). */
export function deriveAdminUrl(evaluateUrl: string, limit: number): string {
	const u = new URL("/admin/recent", evaluateUrl);
	u.searchParams.set("limit", String(limit));
	return u.toString();
}

export interface RecentEvent {
	id?: number;
	session_id?: string;
	hook_event?: string;
	tool_name?: string;
	decision?: string;
	rule_id?: string | null;
	created_at?: number;
}

function shortSession(s: string | undefined): string {
	if (!s) return "?";
	return s.length > 8 ? s.slice(0, 8) : s;
}

function decorateDecision(d: string | undefined): string {
	if (d === "block") return c.red("block");
	if (d === "allow") return c.green("allow");
	return d ?? "?";
}

/** Render recent events as a table. Pure — no I/O — so it's unit-testable. */
export function formatRecentEvents(events: RecentEvent[]): string {
	if (events.length === 0) return c.dim("  (no events recorded yet)");
	const rows = events.map((e) => [
		String(e.id ?? "?"),
		e.created_at ? relativeTime(new Date(e.created_at).toISOString()) : "?",
		shortSession(e.session_id),
		e.tool_name ?? "?",
		decorateDecision(e.decision),
		e.rule_id ?? c.dim("—"),
	]);
	return table(["id", "when", "session", "tool", "decision", "rule"], rows);
}

interface RecentResponse {
	events?: RecentEvent[];
	count?: number;
	workspace_id?: string;
}

const isRecentEvent = wireObject<RecentEvent>({
 id: wireAbsentOptional(wireNumber), session_id: wireAbsentOptional(wireString),
 hook_event: wireAbsentOptional(wireString), tool_name: wireAbsentOptional(wireString),
 decision: wireAbsentOptional(wireString), rule_id: wireAbsentOptional(wireNullable(wireString)),
 created_at: wireAbsentOptional(wireNumber),
});
const isRecentResponse = wireObject<RecentResponse>({
 events: wireAbsentOptional(wireArray(isRecentEvent)), count: wireAbsentOptional(wireNumber),
 workspace_id: wireAbsentOptional(wireString),
});

const FETCH_TIMEOUT_MS = 10_000;
const EXIT_MISCONFIGURED = 2;
const EXIT_UNREACHABLE = 1;
const HTTP_UNAUTHORIZED = 401;

export interface CloudRecentOpts {
	cwd: string;
	limit: number;
	json?: boolean;
}

export async function cloudRecentCommand(opts: CloudRecentOpts): Promise<void> {
	const url = loadCloudUrl(opts.cwd);
	if (!url) {
		process.stderr.write(
			"error: no cloud_governor.url in .interlinked/config.local.json.\n" +
				'Add { "cloud_governor": { "enabled": true, "url": "https://…/governor/evaluate" } }.\n',
		);
		process.exit(EXIT_MISCONFIGURED);
	}
	const token = resolveAuthToken(opts.cwd);
	if (!token) {
		process.stderr.write("error: not authenticated — run `interlinked login` first.\n");
		process.exit(EXIT_MISCONFIGURED);
	}

	const adminUrl = deriveAdminUrl(url, opts.limit);
	const body = await fetchRecent(adminUrl, token);

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		return;
	}

	const events = body.events ?? [];
	process.stdout.write(
		`${c.bold("Cloud governor — recent events")} ${c.dim(
			`(workspace: ${body.workspace_id ?? "?"}, ${events.length} shown)`,
		)}\n\n`,
	);
	process.stdout.write(`${formatRecentEvents(events)}\n`);
}

async function fetchRecent(adminUrl: string, token: string): Promise<RecentResponse> {
	let res: Response;
	try {
		res = await fetch(adminUrl, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		process.stderr.write(
			`error: could not reach cloud governor at ${adminUrl}: ${
				err instanceof Error ? err.message : String(err)
			}\n`,
		);
		process.exit(EXIT_UNREACHABLE);
	}
	if (!res.ok) {
		const detail = res.status === HTTP_UNAUTHORIZED ? " — token expired? run `interlinked login`" : "";
		process.stderr.write(`error: cloud governor returned ${res.status} ${res.statusText}${detail}\n`);
		process.exit(EXIT_UNREACHABLE);
	}
	return parseWire(await res.json(), isRecentResponse, "cloud recent response");
}
