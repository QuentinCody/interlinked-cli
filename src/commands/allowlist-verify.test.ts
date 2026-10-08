// Covers the verify surfaces that the fixed-name EXTRACTORS table can't reach:
// the variably-named *.csproj (SDK-style NuGet) and the Gradle version catalog
// (libs.versions.toml). The fixed-name manifests + the exit-code contract are
// exercised by allowlist.test.ts via the re-export from allowlist.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToAllowlist, hashLockfile, loadAllowlist, saveAllowlist } from "../harness/package-allowlist.js";
import { verifyAllowlistCommand } from "./allowlist-verify.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "allowlist-verify-test-"));
	process.exitCode = undefined;
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	process.exitCode = undefined;
});

function capture(fn: () => void): string {
	let out = "";
	const spy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array): boolean => {
			out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		});
	try {
		fn();
	} finally {
		spy.mockRestore();
	}
	return out;
}

// Hegel trial 2026-10-03: the lockfile is the first artifact naming the
// transitive closure the install gate never saw.
describe("verifyAllowlistCommand — root lockfile transitive packages", () => {
	const LOCK = JSON.stringify({
		lockfileVersion: 3,
		packages: {
			"": { name: "p" },
			"node_modules/koffi": { version: "3.3.2", hasInstallScript: true },
			"node_modules/@koromix/koffi-darwin-arm64": { version: "3.3.2", os: ["darwin"], cpu: ["arm64"], optional: true },
		},
	});

	it("P: reports an unapproved transitive package once, with native evidence, and the approved direct dep not at all", () => {
		writeFileSync(join(workspace, "package.json"), JSON.stringify({ dependencies: { koffi: "3.3.2" } }));
		writeFileSync(join(workspace, "package-lock.json"), LOCK);
		addToAllowlist(workspace, "npm", "koffi", { approved_by: "x" });
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toContain("1 unapproved dep(s):");
		expect(out).toContain(
			"npm:@koromix/koffi-darwin-arm64 — transitive in package-lock.json: @koromix/koffi-darwin-arm64@3.3.2 [NATIVE: platform package (os darwin, cpu arm64); optionalDependency]; not on the allowlist",
		);
		expect(out).not.toMatch(/npm:koffi/);
		expect(process.exitCode).toBe(1);
	});

	it("P: an unapproved DIRECT dep is reported by the manifest row only (no duplicate lockfile row)", () => {
		writeFileSync(join(workspace, "package.json"), JSON.stringify({ dependencies: { koffi: "3.3.2" } }));
		writeFileSync(join(workspace, "package-lock.json"), LOCK);
		addToAllowlist(workspace, "npm", "@koromix/koffi-darwin-arm64", { approved_by: "x" });
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out.match(/npm:koffi/g)?.length).toBe(1);
		expect(out).toContain("1 unapproved dep(s):");
	});

	it("P: an unparseable lockfile is a named issue, never silently clean", () => {
		writeFileSync(join(workspace, "package-lock.json"), "{ broken");
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toContain("could not parse package-lock.json");
		expect(process.exitCode).toBe(1);
	});

	it("N: a matching lockfile snapshot grant approves the whole resolved set", () => {
		writeFileSync(join(workspace, "package-lock.json"), LOCK);
		const al = loadAllowlist(workspace);
		al.lockfile_snapshots["package-lock.json"] = {
			sha256: hashLockfile(join(workspace, "package-lock.json")) ?? "",
			approved_at: "2026-10-04T00:00:00Z",
			approved_by: "x",
		};
		saveAllowlist(workspace, al);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/all approved/);
		expect(process.exitCode).toBeUndefined();
	});

	it("N: every lockfile package approved per-package ⇒ clean", () => {
		writeFileSync(join(workspace, "package-lock.json"), LOCK);
		addToAllowlist(workspace, "npm", "koffi", { approved_by: "x" });
		addToAllowlist(workspace, "npm", "@koromix/koffi-darwin-arm64", { approved_by: "x" });
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/all approved/);
	});
});

describe("verifyAllowlistCommand — *.csproj (SDK-style NuGet)", () => {
	it("flags an unapproved <PackageReference> in a variably-named .csproj", () => {
		writeFileSync(
			join(workspace, "App.csproj"),
			'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Evil.Payload" Version="1.0.0" /></ItemGroup></Project>',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/Evil\.Payload/);
		expect(out).toMatch(/nuget/);
		expect(process.exitCode).toBe(1);
	});

	it("passes when the .csproj package is allowlisted", () => {
		addToAllowlist(workspace, "nuget", "Serilog", { approved_by: "x" });
		writeFileSync(
			join(workspace, "Api.csproj"),
			'<Project><ItemGroup><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});

describe("verifyAllowlistCommand — Gradle version catalog (libs.versions.toml)", () => {
	it("flags an unapproved module coordinate in a root libs.versions.toml", () => {
		writeFileSync(
			join(workspace, "libs.versions.toml"),
			'[libraries]\nevil = { module = "com.evil:payload", version = "1.0.0" }\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/com\.evil:payload/);
		expect(out).toMatch(/gradle/);
		expect(process.exitCode).toBe(1);
	});

	it("flags a group/name coordinate in gradle/libs.versions.toml", () => {
		mkdirSync(join(workspace, "gradle"), { recursive: true });
		writeFileSync(
			join(workspace, "gradle", "libs.versions.toml"),
			'[libraries]\nevil2 = { group = "io.evil", name = "sneaky", version = "2.0.0" }\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/io\.evil:sneaky/);
		expect(process.exitCode).toBe(1);
	});
});

describe("verifyAllowlistCommand — recursive + requirements.in coverage", () => {
	it("flags an unapproved package in a NESTED *.csproj (src/App/App.csproj)", () => {
		mkdirSync(join(workspace, "src", "App"), { recursive: true });
		writeFileSync(
			join(workspace, "src", "App", "App.csproj"),
			'<Project><ItemGroup><PackageReference Include="Nested.Evil" Version="1.0.0" /></ItemGroup></Project>',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/Nested\.Evil/);
		expect(process.exitCode).toBe(1);
	});

	it("does NOT walk a *.csproj inside node_modules", () => {
		mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
		writeFileSync(
			join(workspace, "node_modules", "pkg", "Vendored.csproj"),
			'<Project><ItemGroup><PackageReference Include="Vendored.Evil" Version="1.0.0" /></ItemGroup></Project>',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("walks requirements.in (not just requirements.txt)", () => {
		writeFileSync(join(workspace, "requirements.in"), "evil-in==1.0.0\n");
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/evil-in/);
		expect(process.exitCode).toBe(1);
	});

	it("flags a coordinate in a NESTED libs.versions.toml", () => {
		mkdirSync(join(workspace, "platform", "gradle"), { recursive: true });
		writeFileSync(
			join(workspace, "platform", "gradle", "libs.versions.toml"),
			'[libraries]\ndeep = { module = "deep.evil:lib", version = "3.0.0" }\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/deep\.evil:lib/);
		expect(process.exitCode).toBe(1);
	});
});

describe("verifyAllowlistCommand — fixed-name manifests walked recursively (edit-guard parity)", () => {
	// The manifest-EDIT guard blocks these basenames ANYWHERE in the tree, so a
	// root-only verify reported "clean" on a nested dep the edit-time guard would
	// have blocked — a repo could carry an unapproved package undetected by CI
	// (finding 2026-06).
	it("flags an unapproved dep in a NESTED pom.xml (module/pom.xml)", () => {
		mkdirSync(join(workspace, "module"), { recursive: true });
		writeFileSync(
			join(workspace, "module", "pom.xml"),
			"<project><dependencies><dependency><groupId>com.evil</groupId><artifactId>payload</artifactId><version>1.0.0</version></dependency></dependencies></project>",
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/com\.evil:payload/);
		expect(out).toMatch(/maven/);
		expect(process.exitCode).toBe(1);
	});

	it("flags an unapproved dep in a NESTED build.gradle (app/build.gradle)", () => {
		mkdirSync(join(workspace, "app"), { recursive: true });
		writeFileSync(
			join(workspace, "app", "build.gradle"),
			'dependencies {\n  implementation "com.evil:gradle-payload:1.0.0"\n}\n',
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/com\.evil:gradle-payload/);
		expect(out).toMatch(/gradle/);
		expect(process.exitCode).toBe(1);
	});

	it("flags an unapproved dep in a NESTED package.json (packages/app/package.json)", () => {
		mkdirSync(join(workspace, "packages", "app"), { recursive: true });
		writeFileSync(
			join(workspace, "packages", "app", "package.json"),
			JSON.stringify({ dependencies: { "nested-evil": "1.0.0" } }),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/nested-evil/);
		expect(process.exitCode).toBe(1);
	});

	it("does NOT walk a fixed-name manifest inside node_modules", () => {
		mkdirSync(join(workspace, "node_modules", "dep"), { recursive: true });
		writeFileSync(
			join(workspace, "node_modules", "dep", "package.json"),
			JSON.stringify({ dependencies: { "vendored-evil": "1.0.0" } }),
		);
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("reports a parse error naming the offending package.json", () => {
		writeFileSync(join(workspace, "package.json"), "{ not valid json ");
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/could not parse package\.json/);
		expect(process.exitCode).toBe(1);
	});

	it("N1: reports a package.json that parses as valid JSON but is a JSON array, not an object", () => {
		writeFileSync(join(workspace, "package.json"), JSON.stringify(["not", "an", "object"]));
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/package\.json is not a JSON object/);
		expect(process.exitCode).toBe(1);
	});

	it("N2: ignores a dependencies field that is not a keyed object rather than crashing", () => {
		writeFileSync(join(workspace, "package.json"), JSON.stringify({ dependencies: "not-an-object" }));
		const out = capture(() => verifyAllowlistCommand({ cwd: workspace }));
		expect(out).toMatch(/clean|all approved/i);
		expect(process.exitCode ?? 0).toBe(0);
	});
});
