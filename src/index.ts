#!/usr/bin/env node
// ===========================================
// Interlinked CLI — Local companion: hooks, activity capture, guard evaluation, and developer observability
// ===========================================
//
// This is the thin entry point. The command tree (metadata, help text,
// registrars, the version command) lives in `cli-program.ts` so it can be
// built without parsing argv. This file owns only the version lookup and
// dispatch: a resource-bounded run, the zero-arg wizard, or argv parsing.

import { readFileSync } from "node:fs";
import { buildProgram } from "./cli-program.js";
import { handleImplicitEntry } from "./commands/first-run.js";
import { superviseResourceCli } from "./harness/resource-cli.js";
import { isJsonObject } from "./lib/json-types.js";

// Read version from package.json so it stays in sync with the package
function resolveVersion(): string {
	try {
		const pkgPath = new URL("../package.json", import.meta.url);
		const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		const version = isJsonObject(parsed) ? parsed.version : undefined;
		return typeof version === "string" && version.length > 0 ? version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const program = buildProgram(resolveVersion());

if (!(await superviseResourceCli(process.argv)) && !(await handleImplicitEntry())) {
	await program.parseAsync(process.argv);
}
