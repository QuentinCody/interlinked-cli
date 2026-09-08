import { errorMessage } from "../lib/error-message.js";
// ===========================================
// interlinked daemons — list active harness daemons (Phase J polish)
// ===========================================
// Shows every discovered daemon (per-session + legacy), their PID liveness,
// socket path, and (best-effort) reported health via a one-shot daemon.health
// RPC. See docs/design/free-cli-architecture.md §5 Daemon architecture.

import { createDaemonClient } from "../harness/daemon-client.js";
import type { DaemonHealth } from "../harness/daemon-protocol.js";
import { cleanupOrphans, discoverDaemons } from "../harness/session-paths.js";

export interface DaemonsOptions {
	json?: boolean;
	cleanup?: boolean;
	healthTimeoutMs?: number;
}

interface DaemonRow {
	session_id: string;
	pid: number | null;
	alive: boolean;
	socket: string;
	log: string;
	health: DaemonHealth | null;
	health_error: string | null;
}

export async function daemonsCommand(options: DaemonsOptions): Promise<void> {
	const cwd = process.cwd();

	if (options.cleanup) {
		const removed = cleanupOrphans(cwd);
		if (options.json) {
			process.stdout.write(
				`${JSON.stringify({ ok: true, cleaned: removed.map((d) => d.session_id) }, null, 2)}\n`,
			);
		} else {
			process.stdout.write(`[interlinked] cleaned ${removed.length} orphan daemon(s)\n`);
			for (const d of removed) {
				process.stdout.write(`  ${d.session_id}\n`);
			}
		}
		return;
	}

	const timeout = options.healthTimeoutMs ?? 500;
	const discovered = discoverDaemons(cwd);
	const rows = await Promise.all(
		discovered.map((d) =>
			probeHealth(d.session_id, d.pid, d.alive, d.paths.socket, d.paths.log, timeout),
		),
	);

	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ok: true, daemons: rows }, null, 2)}\n`);
		return;
	}
	printHuman(rows);
}

async function probeHealth(
	session_id: string,
	pid: number | null,
	alive: boolean,
	socket: string,
	log: string,
	timeoutMs: number,
): Promise<DaemonRow> {
	const row: DaemonRow = {
		session_id,
		pid,
		alive,
		socket,
		log,
		health: null,
		health_error: null,
	};
	if (!alive) {
		row.health_error = "process not alive";
		return row;
	}
	const client = createDaemonClient(socket);
	let health: DaemonHealth | null = null;
	let err = "";
	try {
		health = await client.call("daemon.health", {}, { timeout_ms: timeoutMs });
	} catch (e) {
		err = errorMessage(e);
	}
	if (health) {
		row.health = health;
	} else {
		row.health_error = err || "unknown";
	}
	return row;
}

function printHuman(rows: DaemonRow[]): void {
	if (rows.length === 0) {
		process.stdout.write("[interlinked] no daemons found\n");
		return;
	}
	const header = `${pad("SESSION", 22)}${pad("PID", 8)}${pad("STATUS", 12)}${pad("TSGO", 14)}SOCKET\n`;
	process.stdout.write(header);
	for (const r of rows) {
		const status = !r.alive ? "dead" : r.health ? r.health.status : "unreachable";
		const tsgo = r.health?.tsgo_status ?? "-";
		process.stdout.write(
			`${pad(r.session_id, 22)}${pad(r.pid?.toString() ?? "-", 8)}${pad(status, 12)}${pad(tsgo, 14)}${r.socket}\n`,
		);
	}
}

function pad(s: string, n: number): string {
	if (s.length >= n) return `${s} `;
	return s + " ".repeat(n - s.length);
}
