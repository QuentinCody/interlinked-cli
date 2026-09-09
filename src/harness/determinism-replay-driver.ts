// Determinism-replay driver — proof-of-enforcement §15 step 0 (fresh-process rung).
//
// @determinism-critical — emits the canonical findings other processes compare
// against; must itself stay free of locale-/FS-order-/wall-clock-dependent idioms.
//
// A thin filter: reads a corpus (JSON `[{ path, content }]`) on stdin, runs the
// inline pipeline on each item, and writes the canonical findings (JSON
// `string[]`, one canonical blob per item) to stdout. The conformance test runs
// this in a FRESH process — under a perturbed timezone/locale — and compares its
// output byte-for-byte against an in-process run, surfacing nondeterminism
// seeded at process start (import-time constants, environment, timezone) that a
// same-process repeat cannot. This same driver is the cloud-Sandbox rung's entry
// point (run it there, diff against local — the real cross-machine test).

import { isJsonObject } from "../lib/json-types.js";
import { type CorpusItem, canonicalizeFindings, runInlinePipeline } from "./determinism-conformance.js";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8");
}

/** Validate the stdin payload: a JSON array of `{ path, content }`. Exported
 *  for direct testing. Not a persisted-artifact reader (stdin is piped fresh
 *  by the caller each run), so the campaign's replay obligation doesn't apply
 *  — see scratch/fleet-r2/CONTRACT.md. */
export function parseCorpus(value: unknown): CorpusItem[] | null {
	if (!Array.isArray(value)) return null;
	const items: CorpusItem[] = [];
	for (const entry of value) {
		if (!isJsonObject(entry)) return null;
		const { path, content } = entry;
		if (typeof path !== "string" || typeof content !== "string") return null;
		items.push({ path, content });
	}
	return items;
}

async function main(): Promise<void> {
	const corpus = parseCorpus(JSON.parse(await readStdin()));
	if (!corpus) {
		throw new Error("stdin corpus must be a JSON array of { path: string; content: string }");
	}
	const canon = corpus.map((item) =>
		canonicalizeFindings(runInlinePipeline(item.content, item.path)),
	);
	process.stdout.write(JSON.stringify(canon));
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
