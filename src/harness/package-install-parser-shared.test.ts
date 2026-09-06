// Direct unit test for the shared pre-verb-flag dropper (`dropPreVerbFlags`)
// and its private helper `flagTokenSpan`. Per-ecosystem parsers exercise this
// indirectly through `parseInstallCommands`; this file pins the standalone
// contract: how many tokens a flag consumes before the caller reaches the
// verb, driven only through the exported entry point.

import { describe, expect, it } from "vitest";
import { dropPreVerbFlags } from "./package-install-parser-shared.js";

describe("dropPreVerbFlags", () => {
	it("consumes a bare single-token flag whose next token is the recognized verb", () => {
		// `-g` starts with `-` but is not `--flag=val`, and the next token
		// ("install") IS the verb, so flagTokenSpan's inner "looks like it
		// takes a value" check is false and it must consume exactly 1 token
		// (the flag alone), landing cleanly on the verb.
		const isInstall = (s: string): boolean => s === "install";
		expect(dropPreVerbFlags("npm", ["-g", "install", "pkg"], isInstall)).toEqual([
			"install",
			"pkg",
		]);
	});

	it("consumes a bare single-token flag with no following token at all", () => {
		// Same 1-token span, but via the `next === undefined` arm of the
		// inner guard rather than the verb-recognized arm above.
		const isInstall = (s: string): boolean => s === "install";
		expect(dropPreVerbFlags("npm", ["-g"], isInstall)).toEqual([]);
	});

	it("consumes a `--flag=value` token as a single token", () => {
		const isInstall = (s: string): boolean => s === "install";
		expect(dropPreVerbFlags("npm", ["--prefix=/app", "install", "pkg"], isInstall)).toEqual([
			"install",
			"pkg",
		]);
	});

	it("consumes a `--flag value` pair when the value doesn't look like a flag or the verb", () => {
		const isInstall = (s: string): boolean => s === "install";
		expect(
			dropPreVerbFlags("npm", ["--prefix", "/app", "install", "pkg"], isInstall),
		).toEqual(["install", "pkg"]);
	});
});
