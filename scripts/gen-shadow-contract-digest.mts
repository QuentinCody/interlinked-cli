// Shared generator implementation lives under src so in-process freshness
// tests and the stable compiler use the same typed module as this CLI.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runShadowContractDigestGenerator } from "../src/harness/shadow/generation/contract-digest.js";

export * from "../src/harness/shadow/generation/contract-digest.js";

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) runShadowContractDigestGenerator();
