// Fixture build: compiles src/server.ts → dist/server.js with Node's built-in
// TypeScript type stripping (node:module.stripTypeScriptTypes, Node ≥ 22.13).
// No dependencies, so the fixture builds in any checkout; the public service
// is the emitted JavaScript, not the TypeScript source.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
mkdirSync("dist", { recursive: true });
const source = readFileSync("src/server.ts", "utf8");
const compiled = stripTypeScriptTypes(source, { mode: "strip" });
writeFileSync("dist/server.js", `// compiled from src/server.ts\n${compiled}`);
