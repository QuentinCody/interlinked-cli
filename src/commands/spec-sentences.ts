import type { Command } from "commander";
import { scanSpecSentences } from "../harness/spec/sentence-project.js";

/** Read-only advisory output; never registered with pre/post gates. */
export function registerSpecSentenceCommand(spec: Command): void {
    spec.command("sentences [files...]")
        .description("Read-only sentence classes and exact citations (defaults to plans, project-e2e, harness, CLAUDE)")
        .option("--json", "Emit one JSON object; default emits sentence JSONL and a summary on stderr")
        .action((files: string[], options: { json?: boolean }) => {
            const result = scanSpecSentences(process.cwd(), files);
            if (options.json) console.log(JSON.stringify(result));
            else {
                for (const row of result.rows) console.log(JSON.stringify(row));
                console.error(JSON.stringify({ schema: result.schema, advisory: true, complete: result.complete, ...result.summary, interpretation: result.interpretation }));
            }
        });
}
