// `interlinked spec` — spec-substrate utilities (docs/design/
// spec-audit-runtime-checks.md). v1: `spec agenda` generates the standing
// review-agenda artifact (§7.3/§11): deterministic discovery for the next
// reviewer — agent, Tier-3 run, or external audit.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { registerSpecSentenceCommand } from "./spec-sentences.js";
import { openReviewFindings } from "../harness/server/review-reconcile-phase.js";
import {
	extractCodeInvariants,
	extractMarkdownInvariants,
	renderInvariantTaxonomy,
} from "../harness/spec/code-invariants.js";
import { SpecLedger } from "../harness/spec/ledger.js";
import { buildAgenda, writeReviewAgenda } from "../harness/spec/review-agenda.js";
import { isSpecEligibleFile } from "../harness/spec/types.js";

/** Raw contents for every ledger file (section-body scans). Files deleted
 *  between walk and read are counted, never silently dropped. */
function contentsFor(
	cwd: string,
	ledger: SpecLedger,
): { contents: Map<string, string>; unreadable: number } {
	const contents = new Map<string, string>();
	let unreadable = 0;
	for (const rel of ledger.fileList()) {
		try {
			contents.set(rel, readFileSync(join(cwd, rel), "utf8"));
		} catch {
			unreadable++;
		}
	}
	return { contents, unreadable };
}

export function registerSpecCommands(program: Command): void {
	const spec = program
		.command("spec")
		.description("Spec-substrate utilities (fact ledger, review agenda, sentence citations)");

    registerSpecSentenceCommand(spec);

	spec
		.command("agenda")
		.description("Generate .interlinked/review-agenda.md from the fact ledger")
		.action(() => {
			const cwd = process.cwd();
			const ledger = SpecLedger.build(cwd);
			const { contents, unreadable } = contentsFor(cwd, ledger);
			const items = buildAgenda({ ledger, contents, openFindings: [] });
			const open = openReviewFindings(cwd).map(
				(f) =>
					`${f.id.slice(0, 48)}… ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message.slice(0, 100)}`,
			);
			const path = writeReviewAgenda(cwd, items, open);
			const skipNote =
				unreadable > 0 ? ` (${unreadable} file(s) unreadable, omitted)` : "";
			console.log(
				`Review agenda: ${items.length} item(s) + ${open.length} open finding(s) → ${path}${skipNote}`,
			);
		});

	spec
		.command("invariants <file>")
		.description(
			"Extract a file's invariants (registry rows, doctrine, INVARIANT/SAFETY comments, assertions) into a taxonomy artifact",
		)
		.action((file: string) => {
			const cwd = process.cwd();
			const content = readFileSync(file, "utf8");
			const invariants = isSpecEligibleFile(file)
				? extractMarkdownInvariants(content)
				: extractCodeInvariants(content);
			const outDir = join(cwd, ".interlinked", "policies");
			mkdirSync(outDir, { recursive: true });
			const outPath = join(outDir, `${basename(file)}.invariants.md`);
			writeFileSync(outPath, renderInvariantTaxonomy(file, invariants));
			console.log(
				`Extracted ${invariants.length} invariant(s) from ${file} → ${outPath}`,
			);
			console.log(
				"Use it as review context, or as the Tier-2 classification taxonomy (memo §5).",
			);
		});
}
