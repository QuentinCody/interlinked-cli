// Run with: node --import tsx scripts/internal/jev.mjs <command>
import { createInternalJevProgram } from "../../src/harness/jev/internal-cli.ts";

await createInternalJevProgram().parseAsync(process.argv);
