// Shared generator implementation lives under src so in-process freshness
// tests and the stable compiler use the same typed module as this CLI.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runShadowSchemaGenerator } from "../src/harness/shadow/generation/schema.js";

export * from "../src/harness/shadow/generation/schema.js";

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) runShadowSchemaGenerator();
