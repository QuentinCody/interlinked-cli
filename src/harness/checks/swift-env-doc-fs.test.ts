// Smoke coverage for swift-env-doc-fs.ts, extracted from swift.ts (large-file
// split). Full behavioral coverage (ancestor walk, wrangler.toml/jsonc parsing,
// GitHub Actions env-block scanning, error tolerance) already lives in
// swift.test.ts and swift.coverage.test.ts against the re-exported symbol —
// this file pins that the moved implementation still works when imported
// directly from its new home.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvDocumentation } from "./swift-env-doc-fs.js";

describe("parseEnvDocumentation (moved module smoke test)", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("collects vars from .env.example", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-doc-fs-"));
		writeFileSync(join(dir, ".env.example"), "API_KEY=\nDB_URL=postgres://\n");
		const documented = parseEnvDocumentation(dir, { existsSync, readFileSync, readdirSync }, join);
		expect(documented.has("API_KEY")).toBe(true);
		expect(documented.has("DB_URL")).toBe(true);
	});

	it("collects vars from wrangler.toml [vars] block and bindings", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-doc-fs-"));
		writeFileSync(
			join(dir, "wrangler.toml"),
			'name = "MY_WORKER"\n[vars]\nFOO_BAR = "baz"\n',
		);
		const documented = parseEnvDocumentation(dir, { existsSync, readFileSync, readdirSync }, join);
		expect(documented.has("FOO_BAR")).toBe(true);
		expect(documented.has("MY_WORKER")).toBe(true);
	});

	it("collects vars from wrangler.jsonc bindings", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-doc-fs-"));
		writeFileSync(join(dir, "wrangler.jsonc"), '{\n  "binding": "MY_KV"\n}\n');
		const documented = parseEnvDocumentation(dir, { existsSync, readFileSync, readdirSync }, join);
		expect(documented.has("MY_KV")).toBe(true);
	});

	it("collects env vars and secrets from GitHub Actions workflows", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-doc-fs-"));
		mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
		writeFileSync(
			join(dir, ".github", "workflows", "ci.yml"),
			"env:\n  CI_TOKEN: ${{ secrets.SECRET_TOKEN }}\n",
		);
		const documented = parseEnvDocumentation(dir, { existsSync, readFileSync, readdirSync }, join);
		expect(documented.has("CI_TOKEN")).toBe(true);
		expect(documented.has("SECRET_TOKEN")).toBe(true);
	});

	it("returns an empty set when no doc sources exist", () => {
		dir = mkdtempSync(join(tmpdir(), "swift-env-doc-fs-"));
		const documented = parseEnvDocumentation(dir, { existsSync, readFileSync, readdirSync }, join);
		expect(documented.size).toBe(0);
	});
});
