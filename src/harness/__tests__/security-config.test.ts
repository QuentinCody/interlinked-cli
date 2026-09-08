// ===========================================
// Tests — Security Config Loader (Phase B pass 1)
// ===========================================
// Mirrors the shape of `sanitizer-registry.test.ts`: load defaults when
// file is missing, override merges, JSON parse errors fail safe, all
// five detector configs are reachable.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	defaultConfig,
	load,
	type SecurityConfig,
	securityConfigPath,
	validate,
} from "../security-config.js";

let tmpRoot: string;

function writeConfigFile(body: unknown): void {
	mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
	writeFileSync(
		join(tmpRoot, ".interlinked", "security-config.json"),
		typeof body === "string" ? body : JSON.stringify(body, null, 2),
	);
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "security-config-test-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("defaults", () => {
	it("returns built-in defaults when the file is missing", () => {
		const cfg = load(tmpRoot);
		expect(cfg.endpoint_auth_missing.exempt_paths).toContain("/health");
		expect(cfg.endpoint_idor_shape.auth_context_identifiers).toContain("req.user");
		expect(cfg.endpoint_missing_tenant_filter.tenant_columns).toContain("workspace_id");
		expect(cfg.endpoint_missing_tenant_filter.exempt_tables).toContain("sessions");
		expect(cfg.endpoint_ssrf_shape.exempt_paths).toEqual([]);
		expect(cfg.endpoint_mass_assignment).toEqual({});
	});

	it("defaultConfig() returns a fresh object each call (no shared state)", () => {
		const a = defaultConfig();
		const b = defaultConfig();
		a.endpoint_auth_missing.exempt_paths.push("/mutated");
		expect(b.endpoint_auth_missing.exempt_paths).not.toContain("/mutated");
	});

	it("all five detector configs are reachable in the default object", () => {
		const cfg: SecurityConfig = defaultConfig();
		// Static-typing assertion: TypeScript already enforces these exist;
		// the runtime check pins backwards-compat if the type changes.
		expect(cfg.endpoint_auth_missing).toBeDefined();
		expect(cfg.endpoint_idor_shape).toBeDefined();
		expect(cfg.endpoint_missing_tenant_filter).toBeDefined();
		expect(cfg.endpoint_ssrf_shape).toBeDefined();
		expect(cfg.endpoint_mass_assignment).toBeDefined();
	});
});

describe("validate()", () => {
	it("coerces a fully-specified config", () => {
		const cfg = validate({
			endpoint_auth_missing: { exempt_paths: ["/foo"] },
			endpoint_idor_shape: { auth_context_identifiers: ["my.user"] },
			endpoint_missing_tenant_filter: {
				tenant_columns: ["tenant_id"],
				exempt_tables: ["logs"],
			},
			endpoint_ssrf_shape: { exempt_paths: ["/proxy"] },
			endpoint_mass_assignment: {},
		});
		expect(cfg.endpoint_auth_missing.exempt_paths).toEqual(["/foo"]);
		expect(cfg.endpoint_idor_shape.auth_context_identifiers).toEqual(["my.user"]);
		expect(cfg.endpoint_missing_tenant_filter.tenant_columns).toEqual(["tenant_id"]);
		expect(cfg.endpoint_missing_tenant_filter.exempt_tables).toEqual(["logs"]);
		expect(cfg.endpoint_ssrf_shape.exempt_paths).toEqual(["/proxy"]);
	});

	it("falls back to defaults when sections are missing", () => {
		const cfg = validate({ endpoint_auth_missing: { exempt_paths: ["/only"] } });
		expect(cfg.endpoint_auth_missing.exempt_paths).toEqual(["/only"]);
		// Other sections fall back to defaults.
		expect(cfg.endpoint_idor_shape.auth_context_identifiers.length).toBeGreaterThan(0);
		expect(cfg.endpoint_missing_tenant_filter.tenant_columns.length).toBeGreaterThan(0);
	});

	it("ignores unknown top-level keys", () => {
		const cfg = validate({
			endpoint_auth_missing: { exempt_paths: ["/x"] },
			some_unknown_key: { weird: true },
		});
		expect(cfg.endpoint_auth_missing.exempt_paths).toEqual(["/x"]);
		expect(cfg).not.toHaveProperty("some_unknown_key");
	});

	it("drops non-string entries from string arrays", () => {
		const cfg = validate({
			endpoint_auth_missing: { exempt_paths: ["/ok", 42, null, "/also-ok"] },
		});
		expect(cfg.endpoint_auth_missing.exempt_paths).toEqual(["/ok", "/also-ok"]);
	});

	it("returns defaults for null / non-object input", () => {
		const cfgNull = validate(null);
		const cfgString = validate("not an object");
		expect(cfgNull.endpoint_auth_missing.exempt_paths.length).toBeGreaterThan(0);
		expect(cfgString.endpoint_auth_missing.exempt_paths.length).toBeGreaterThan(0);
	});

	it("ignores a section that's not an object", () => {
		const cfg = validate({
			endpoint_auth_missing: "should be an object",
			endpoint_idor_shape: { auth_context_identifiers: ["ok.user"] },
		});
		// Missing section → defaults.
		expect(cfg.endpoint_auth_missing.exempt_paths.length).toBeGreaterThan(0);
		expect(cfg.endpoint_idor_shape.auth_context_identifiers).toEqual(["ok.user"]);
	});
});

describe("load()", () => {
	it("loads + validates a real file from disk", () => {
		writeConfigFile({
			endpoint_auth_missing: { exempt_paths: ["/from-disk"] },
		});
		const cfg = load(tmpRoot);
		expect(cfg.endpoint_auth_missing.exempt_paths).toEqual(["/from-disk"]);
	});

	it("falls back to defaults on malformed JSON", () => {
		writeConfigFile("{ not valid json :(");
		const cfg = load(tmpRoot);
		expect(cfg.endpoint_auth_missing.exempt_paths).toContain("/health");
	});

	it("falls back to defaults on a missing file", () => {
		const cfg = load(tmpRoot);
		expect(cfg.endpoint_auth_missing.exempt_paths).toContain("/health");
	});

	it("merges partial file with defaults for missing sections", () => {
		writeConfigFile({
			endpoint_missing_tenant_filter: {
				tenant_columns: ["custom_tenant"],
			},
		});
		const cfg = load(tmpRoot);
		expect(cfg.endpoint_missing_tenant_filter.tenant_columns).toEqual(["custom_tenant"]);
		// exempt_tables stays at default.
		expect(cfg.endpoint_missing_tenant_filter.exempt_tables).toContain("sessions");
		// Other sections stay at default.
		expect(cfg.endpoint_idor_shape.auth_context_identifiers.length).toBeGreaterThan(0);
	});
});

describe("securityConfigPath()", () => {
	it("computes the canonical path under cwd", () => {
		const p = securityConfigPath("/tmp/foo");
		expect(p).toMatch(/[/\\]\.interlinked[/\\]security-config\.json$/);
	});
});
