/** Compatibility entry point; the production CLI uses the same corpus engine. */
import { Command } from "commander";
import { measureCorpus } from "../src/lib/metrics/corpus.js";

interface CorpusOptions { manifest: string; out: string; }
const program = new Command().requiredOption("--manifest <path>").requiredOption("--out <directory>").parse();
const options = program.opts<CorpusOptions>();
const result = await measureCorpus({ ...options, progress: (name, index, total) => process.stderr.write(`[${index}/${total}] ${name}\n`) });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.repositories.some(row => row.status === "failed")) process.exitCode = 1;
