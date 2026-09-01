// ===========================================
// interlinked trace — Export/Import agent traces
// ===========================================

import { readFileSync, writeFileSync } from "node:fs";
import { c, header, kvLine } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { exportTrace, importTrace } from "../lib/trace.js";

export async function traceExportCommand(opts: {
	since?: string;
	agent?: string;
	output?: string;
	format?: string;
	json?: boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);

	try {
		const format = opts.format === "jsonl" ? "jsonl" : "json";
		const traceData = exportTrace({
			...(opts.since !== undefined ? { since: opts.since } : {}),
			...(opts.agent !== undefined ? { agent: opts.agent } : {}),
			format,
		});

		if (opts.output) {
			writeFileSync(opts.output, traceData);
			output(
				mode,
				{},
				{
					json: () => ({ file: opts.output, format }),
					normal: () => c.green(`Trace exported to ${c.bold(opts.output!)}`),
				},
			);
		} else {
			// Print to stdout
			console.log(traceData);
		}
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

export async function traceImportCommand(file: string, opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);

	try {
		const data = readFileSync(file, "utf-8");
		const result = importTrace(data);

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Trace Import"));
				lines.push(kvLine("Imported", c.green(String(result.imported))));
				if (result.skipped > 0) {
					lines.push(kvLine("Skipped (dedup)", String(result.skipped)));
				}
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
