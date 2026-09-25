// Fixture build: compiles src/cli.ts → dist/cli.js with Node's built-in
// TypeScript type stripping (node:module.stripTypeScriptTypes, Node ≥ 22.13).
// No dependencies, so the fixture builds in any checkout; the public
// executable is the emitted JavaScript, not the TypeScript source.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
mkdirSync("dist", { recursive: true });
const source = readFileSync("src/cli.ts", "utf8");
const compiled = stripTypeScriptTypes(source, { mode: "strip" });
writeFileSync("dist/cli.js", `// compiled from src/cli.ts\n${compiled}`);
