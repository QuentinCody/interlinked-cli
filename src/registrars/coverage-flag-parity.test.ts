// ===========================================================================
// `coverage check` flag parity — registered flags vs the opts keys the
// command actually reads.
// ===========================================================================
// The BUG CLASS this pins (both directions were live on 2026-09-01):
//
//   READ-BUT-UNREGISTERED — `src/commands/coverage.ts` read `opts.strict`,
//   `opts.changedFiles` and `opts.cwd`, none of which the registrar declared.
//   Commander refused `interlinked coverage check --strict` as an unknown
//   option, so the ONLY thing that can turn a per-file coverage drop into a
//   non-zero exit was unreachable: the command exited 0 with 154 drop findings.
//
//   REGISTERED-BUT-UNREAD — the registrar declared `--summary <path>` (with a
//   default!) and `--baseline <path>`; the command reads NEITHER. A caller
//   pointing the ratchet at a fresh report got a silently ignored flag and a
//   verdict computed from the stale canonical report.
//
// Asserting only "--strict exists" would pin the instance. This file pins the
// invariant: the set of registered option attribute names equals the set of
// keys on the command's own `CoverageCheckOptions`, and every `opts.<key>`
// the command dereferences is a registered flag. Either defect re-appearing —
// on this flag or any future one — fails here.
//
// The command's option contract is read from SOURCE rather than reflected
// from a type (interfaces are erased at runtime, and the point is to catch a
// key that exists in one artifact and not the other).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command, type Option } from "commander";
import { describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { registerQualityCommands } from "./quality.js";

const COMMAND_SOURCE_PATH = join(import.meta.dirname, "..", "commands", "coverage.ts");
const COMMAND_SOURCE = readFileSync(COMMAND_SOURCE_PATH, "utf8");

/** The `coverage check` subcommand as the real registrar builds it. */
function coverageCheckCommand(): Command {
	const program = new Command();
	registerQualityCommands(program);
	const coverage = nonNull(
		program.commands.find((c) => c.name() === "coverage"),
		"missing top-level command: coverage",
	);
	return nonNull(
		coverage.commands.find((c) => c.name() === "check"),
		"missing subcommand: coverage check",
	);
}

/** Registered flags as the camelCase keys commander will hand the action —
 *  `--changed-files` arrives as `changedFiles`, which is the name that has to
 *  line up with what the command reads. */
function registeredAttributeNames(cmd: Command): string[] {
	return cmd.options.map((o: Option) => o.attributeName()).sort();
}

/** Keys declared on the command's own `CoverageCheckOptions` interface — the
 *  option contract the implementation states for itself. */
function declaredOptionKeys(source: string): string[] {
	const block = /interface CoverageCheckOptions \{([\s\S]*?)\n\}/.exec(source);
	const body = nonNull(block?.[1], "CoverageCheckOptions interface not found in coverage.ts");
	return [...body.matchAll(/^\t(\w+)\??:/gm)].map((m) => nonNull(m[1])).sort();
}

/** Every `opts.<key>` the command source dereferences. */
function dereferencedOptionKeys(source: string): string[] {
	return [...new Set([...source.matchAll(/\bopts\.(\w+)/g)].map((m) => nonNull(m[1])))].sort();
}

describe("coverage check flag parity — positive (must fire)", () => {
	it("P1: every registered flag maps to a key the command declares, and vice versa", () => {
		expect(registeredAttributeNames(coverageCheckCommand())).toEqual(
			declaredOptionKeys(COMMAND_SOURCE),
		);
	});

	it("P2: every opts.<key> the command dereferences is a registered flag", () => {
		const registered = new Set(registeredAttributeNames(coverageCheckCommand()));
		const unregistered = dereferencedOptionKeys(COMMAND_SOURCE).filter((k) => !registered.has(k));
		expect(unregistered).toEqual([]);
	});

	it("P3: --strict is registered and reaches the command (the flag whose absence disabled the gate)", () => {
		const strict = coverageCheckCommand().options.find((o) => o.long === "--strict");
		expect(nonNull(strict).attributeName()).toBe("strict");
		expect(COMMAND_SOURCE).toContain("opts.strict");
	});
});

describe("coverage check flag parity — negative (must not fire)", () => {
	it("N1: the two silently-ignored flags are GONE from the registrar", () => {
		const longs = coverageCheckCommand().options.map((o) => o.long);
		expect(longs).not.toContain("--summary");
		expect(longs).not.toContain("--baseline");
	});

	it("N2: `json` counts as consumed even though it is never dereferenced as opts.json", () => {
		// The one legitimate way a declared key escapes the opts.<key> scan:
		// the whole options object goes to `getOutputMode`. P1 still requires
		// the flag to be registered; this records WHY P2's scan cannot see it.
		expect(dereferencedOptionKeys(COMMAND_SOURCE)).not.toContain("json");
		expect(declaredOptionKeys(COMMAND_SOURCE)).toContain("json");
		expect(COMMAND_SOURCE).toContain("getOutputMode(opts)");
	});

	it("N3: the parser reads a real contract — neither key set is empty", () => {
		// A regex that silently stops matching would make P1 pass vacuously
		// (empty === empty) once the registrar's options were also dropped.
		expect(declaredOptionKeys(COMMAND_SOURCE).length).toBeGreaterThanOrEqual(6);
		expect(registeredAttributeNames(coverageCheckCommand()).length).toBeGreaterThanOrEqual(6);
	});
});
