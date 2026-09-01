// ===========================================
// `interlinked viz` — the baseline-test visualizer command
// ===========================================
// Serves the loopback dashboard (CELLS. INTERLINKED.) or prints the graph
// snapshot it renders. The long-running `serve` blocks until SIGINT; the
// server-start and stop-signal are injectable so the action is testable
// without binding a real port or trapping a process-global signal.

import { basename, resolve } from "node:path";
import { ProjectGraph } from "../harness/project-graph.js";
import { getOutputMode, output } from "../lib/output.js";
import { buildGraphSnapshot } from "../lib/viz/graph-snapshot.js";
import { startVizServer, type VizServerHandle } from "../lib/viz/server.js";
import { clearVizStatus, writeVizStatus } from "../lib/viz/status-file.js";

interface VizOpts {
	port?: string;
root?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

interface VizServeDeps {
	startServer?: (opts: { root: string; port?: number }) => Promise<VizServerHandle>;
	waitForStop?: () => Promise<void>;
}

/** Themed startup banner for `viz serve`. */
export function formatBanner(url: string, root: string): string {
	return [
		"",
		"  ▞▞ INTERLINKED // LIVE DASHBOARD",
		`  live dashboard · files, imports, gates, tests, mutants, agents`,
		`  ${root}`,
		`  ▸ ${url}`,
		"  open the url in a browser · ctrl-c to stop",
		"",
	].join("\n");
}

/** Resolve once the source emits SIGINT (the serve loop's stop signal). */
export function waitForSignal(source: NodeJS.EventEmitter = process): Promise<void> {
	return new Promise<void>((done) => {
		source.once("SIGINT", () => done());
	});
}

/** `interlinked viz [serve]` — serve the live dashboard until stopped. */
export async function runVizServe(opts: VizOpts, deps: VizServeDeps = {}): Promise<number> {
	const root = opts.root ? resolve(opts.root) : process.cwd();
	const mode = getOutputMode(opts);
	const start = deps.startServer ?? startVizServer;
	const port = opts.port ? Number(opts.port) : undefined;
	const handle = await start(port === undefined ? { root } : { root, port });
	// Publish the live URL so the statusline can offer a click-through while the
	// server is up, and clear it on the way out so no dead link survives.
	writeVizStatus(root, { url: handle.url, pid: process.pid, root });

	if (mode === "json") {
		console.log(JSON.stringify({ url: handle.url, port: handle.port, root }, null, 2));
	} else {
		process.stdout.write(`${formatBanner(handle.url, root)}\n`);
	}

	try {
		await (deps.waitForStop ?? waitForSignal)();
	} finally {
		clearVizStatus(root);
		await handle.close();
	}
	return 0;
}

/** `interlinked viz snapshot` — print the graph snapshot the dashboard renders. */
export async function runVizSnapshot(opts: VizOpts): Promise<number> {
	const root = opts.root ? resolve(opts.root) : process.cwd();
	const mode = getOutputMode(opts);
	const graph = new ProjectGraph(root);
	graph.initialize();
	const snap = buildGraphSnapshot(graph, basename(root));

	output(mode, snap, {
		json: () => snap,
		normal: () =>
			`${snap.node_count} files · ${snap.edge_count} imports · most depended-on: ${snap.super_hub?.id ?? "—"}`,
	});
	return 0;
}
