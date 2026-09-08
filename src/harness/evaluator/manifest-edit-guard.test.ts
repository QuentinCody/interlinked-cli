import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToAllowlist, loadAllowlist } from "../package-allowlist.js";
import {
	evaluateManifestEdit,
	extractCargoDeps,
	extractGemfileDeps,
	extractGoModDeps,
	extractPyprojectDeps,
	parsePipRequirementLine,
} from "./manifest-edit-guard.js";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "manifest-edit-test-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

interface EditScenario {
	filename: string;
	current: string | null;
	next: string;
}

function newContent(scenario: EditScenario) {
	const path = join(workspace, scenario.filename);
	mkdirSync(dirname(path), { recursive: true });
	if (scenario.current !== null) writeFileSync(path, scenario.current);
	return {
		filePath: path,
		newContent: scenario.next,
		allowlist: loadAllowlist(workspace),
		cwd: workspace,
	};
}

describe("extractGoModDeps", () => {
	it("parses the block `require ( ... )` form", () => {
		const goMod = `module example.com/app

go 1.22

require (
	github.com/gin-gonic/gin v1.9.1
	golang.org/x/sync v0.6.0
)`;
		const deps = extractGoModDeps(goMod);
		expect(deps.get("github.com/gin-gonic/gin")).toBe("v1.9.1");
		expect(deps.get("golang.org/x/sync")).toBe("v0.6.0");
	});

	it("parses the single-line `require X Y` form", () => {
		const deps = extractGoModDeps("require github.com/pkg/errors v0.9.1");
		expect(deps.get("github.com/pkg/errors")).toBe("v0.9.1");
	});

	it("returns an empty map for a go.mod with no require directives", () => {
		expect(extractGoModDeps("module example.com/app\n\ngo 1.22\n").size).toBe(0);
	});
});

describe("evaluateManifestEdit — package.json", () => {
	it("blocks adding a new unapproved dep to dependencies", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify(
					{ name: "x", dependencies: { existing: "1.0.0" } },
					null,
					2,
				),
				next: JSON.stringify(
					{ name: "x", dependencies: { existing: "1.0.0", evil: "9.9.9" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
		// Pin the exact field values the harness relies on downstream — a
		// mutant that blanks any of these would still "block" but lose the
		// rule identity / severity / category the pipeline routes on.
		expect(r?.rule_id).toBe("supply-chain-manifest-add");
		expect(r?.severity).toBe("high");
		expect(r?.category).toBe("supply-chain");
		expect(r?.reason).toMatch(/npm dependency/);
	});

	it("allows adding an allowlisted dep", () => {
		addToAllowlist(workspace, "npm", "lodash", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ name: "x", dependencies: {} }, null, 2),
				next: JSON.stringify(
					{ name: "x", dependencies: { lodash: "^4.17.21" } },
					null,
					2,
				),
			}),
		);
		expect(r).toBeNull();
	});

	it("allows version bumps on an existing dep without re-approval", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: { existing: "1.0.0" } }, null, 2),
				next: JSON.stringify({ dependencies: { existing: "1.0.1" } }, null, 2),
			}),
		);
		// Same package name, different version → not a "new dep" gate; allow.
		expect(r).toBeNull();
	});

	it("allows removing a dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: { a: "1", b: "1" } }, null, 2),
				next: JSON.stringify({ dependencies: { a: "1" } }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});

	it("blocks new entries in devDependencies", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ devDependencies: {} }, null, 2),
				next: JSON.stringify({ devDependencies: { evil: "1" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
	});

	it("blocks new entries in optionalDependencies", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ optionalDependencies: {} }, null, 2),
				next: JSON.stringify({ optionalDependencies: { evil: "1" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
	});

	it("blocks new entries in peerDependencies", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ peerDependencies: {} }, null, 2),
				next: JSON.stringify({ peerDependencies: { evil: "1" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
	});

	it("blocks git URL value even on existing-name field (resolves to a different package)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: { foo: "^1.0.0" } }, null, 2),
				next: JSON.stringify(
					{ dependencies: { foo: "git+https://attacker.com/evil.git" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git/i);
	});

	it("blocks tarball URL value", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: {} }, null, 2),
				next: JSON.stringify(
					{ dependencies: { foo: "https://attacker.com/payload.tgz" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — requirements.txt", () => {
	it("blocks a new unapproved Python dep line", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "requests==2.31.0\n",
				next: "requests==2.31.0\nevil-pkg==1.0\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil-pkg/);
	});

	it("allows a new approved line", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "",
				next: "requests==2.31.0\n",
			}),
		);
		expect(r).toBeNull();
	});

	it("ignores comments and blank lines", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "# old\n",
				next: "# new comment\n\n# another\n",
			}),
		);
		expect(r).toBeNull();
	});

	it("blocks new git+ URL line even with same name", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "",
				next: "git+https://attacker.com/evil.git\n",
			}),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — pyproject.toml", () => {
	it("blocks adding a poetry dep that's not on the allowlist", () => {
		const before = `[tool.poetry.dependencies]\npython = "^3.11"\n`;
		const after = `[tool.poetry.dependencies]\npython = "^3.11"\nevil = "^1.0"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("allows adding an approved poetry dep", () => {
		addToAllowlist(workspace, "pypi", "fastapi", { approved_by: "x" });
		const before = `[tool.poetry.dependencies]\npython = "^3.11"\n`;
		const after = `[tool.poetry.dependencies]\npython = "^3.11"\nfastapi = "^0.110"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — Cargo.toml", () => {
	it("blocks adding an unapproved cargo dep", () => {
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = "1"\nevil = "1"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("blocks repinning an approved dep to a git source (P2.5)", () => {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = { git = "https://attacker.com/serde" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git|serde/i);
		// "serde" always appears in the outer reason (it's delta.name, set
		// before classification runs) — that alone doesn't prove the value was
		// classified as git_url. Pin the INNER package-allowlist reason text,
		// which only appears when classifyManifestValue actually returned
		// { kind: "git_url", ... } for this inline `git = "..."` form.
		expect(r?.reason).toMatch(/git URL installs are never auto-allowed/);
	});

	it("blocks repinning to a path source pointing outside the workspace (P2.5)", () => {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = { path = "/etc/evil" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		// Same pin as above but for the file_url branch (inline `path = "..."`).
		expect(r?.reason).toMatch(/file: installs are never auto-allowed/);
	});

	it("allows a plain version bump on an approved cargo dep", () => {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1.0"\n`;
		const after = `[dependencies]\nserde = "1.1"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — pyproject.toml repin (P2.5)", () => {
	it("blocks repinning an approved poetry dep to a git source", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const before = `[tool.poetry.dependencies]\nrequests = "^2.32"\n`;
		const after = `[tool.poetry.dependencies]\nrequests = { git = "https://attacker.com/requests" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — Gemfile repin (P2.5)", () => {
	it("blocks repinning an approved gem to a git source", () => {
		addToAllowlist(workspace, "rubygems", "rails", { approved_by: "x" });
		const before = `gem "rails", "~> 7"\n`;
		const after = `gem "rails", git: "https://attacker.com/rails"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Gemfile", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("evaluateManifestEdit — composer.json", () => {
	it("blocks adding an unapproved require dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ require: { php: ">=8.1" } }, null, 2),
				next: JSON.stringify(
					{ require: { php: ">=8.1", "evil/pkg": "^1.0" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil\/pkg/);
		expect(r?.reason).toMatch(/composer/);
	});

	it("blocks an unapproved require-dev dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ "require-dev": {} }, null, 2),
				next: JSON.stringify(
					{ "require-dev": { "phpunit/phpunit": "^10" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/phpunit/);
	});

	it("blocks flipping an approved dep to an inline git source", () => {
		addToAllowlist(workspace, "composer", "monolog/monolog", { approved_by: "x" });
		const before = JSON.stringify({ require: { "monolog/monolog": "^3.0" } }, null, 2);
		const after = JSON.stringify(
			{ require: { "monolog/monolog": "dev-main git=https://attacker.test/monolog" } },
			null,
			2,
		);
		const r = evaluateManifestEdit(
			newContent({ filename: "composer.json", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
	});

	it("allows adding an allowlisted composer dep", () => {
		addToAllowlist(workspace, "composer", "monolog/monolog", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ require: {} }, null, 2),
				next: JSON.stringify(
					{ require: { "monolog/monolog": "^3.0" } },
					null,
					2,
				),
			}),
		);
		expect(r).toBeNull();
	});

	it("allows a plain version bump on an existing dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ require: { "monolog/monolog": "^3.0" } }, null, 2),
				next: JSON.stringify({ require: { "monolog/monolog": "^3.1" } }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});

	it("returns null on a no-dep edit (only metadata changed)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "composer.json",
				current: JSON.stringify({ name: "vendor/a", require: {} }, null, 2),
				next: JSON.stringify({ name: "vendor/b", require: {} }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — pom.xml (maven)", () => {
	const POM_BASE = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
  </dependencies>
</project>`;

	it("blocks adding an unapproved <dependency>", () => {
		const after = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
    <dependency>
      <groupId>com.evil</groupId>
      <artifactId>payload</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pom.xml", current: POM_BASE, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/com\.evil:payload/);
		expect(r?.reason).toMatch(/maven/);
	});

	it("allows adding an allowlisted maven coordinate", () => {
		// Seed BEFORE newContent so loadAllowlist picks up the grant. The only
		// delta vs POM_BASE is the new junit dep (guava is unchanged, so not
		// re-checked); the new junit coordinate must be allowlisted.
		addToAllowlist(workspace, "maven", "org.junit.jupiter:junit-jupiter", {
			approved_by: "x",
		});
		const after = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
    </dependency>
  </dependencies>
</project>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pom.xml", current: POM_BASE, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null when no dependency changed (whitespace-only edit)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "pom.xml",
				current: POM_BASE,
				next: `${POM_BASE}\n`,
			}),
		);
		expect(r).toBeNull();
	});

	it("returns null for a pom edit touching only <build> plugins (not deps)", () => {
		const after = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
  </dependencies>
  <build><plugins><plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-surefire-plugin</artifactId>
  </plugin></plugins></build>
</project>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pom.xml", current: POM_BASE, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — build.gradle / build.gradle.kts", () => {
	it("blocks an unapproved Groovy implementation line specifically", () => {
		addToAllowlist(workspace, "gradle", "com.google.guava:guava", { approved_by: "x" });
		const before = `dependencies {\n  implementation "com.google.guava:guava:33.0.0-jre"\n}`;
		const after = `dependencies {\n  implementation "com.google.guava:guava:33.0.0-jre"\n  implementation "com.evil:payload:1.0.0"\n}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/com\.evil:payload/);
		expect(r?.reason).toMatch(/gradle/);
	});

	it('blocks an unapproved Kotlin-DSL implementation("...") line', () => {
		const before = `dependencies {\n}`;
		const after = `dependencies {\n  implementation("io.evil:ktor-evil:2.3.7")\n}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle.kts", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/io\.evil:ktor-evil/);
	});

	it("allows an allowlisted gradle coordinate", () => {
		addToAllowlist(workspace, "gradle", "com.squareup.okhttp3:okhttp", {
			approved_by: "x",
		});
		const before = `dependencies {\n}`;
		const after = `dependencies {\n  implementation "com.squareup.okhttp3:okhttp:4.12.0"\n}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null on a version bump of an existing coordinate", () => {
		const before = `dependencies {\n  implementation "com.google.guava:guava:33.0.0-jre"\n}`;
		const after = `dependencies {\n  implementation "com.google.guava:guava:33.1.0-jre"\n}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null on a non-dependency edit (a task block, no coordinate)", () => {
		const before = `dependencies {\n}\ntasks.register("hello") {}`;
		const after = `dependencies {\n}\ntasks.register("goodbye") {}`;
		const r = evaluateManifestEdit(
			newContent({ filename: "build.gradle", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — packages.config (nuget)", () => {
	it("blocks adding an unapproved <package> entry", () => {
		addToAllowlist(workspace, "nuget", "Newtonsoft.Json", { approved_by: "x" });
		const before = `<packages>\n  <package id="Newtonsoft.Json" version="13.0.3" />\n</packages>`;
		const after = `<packages>\n  <package id="Newtonsoft.Json" version="13.0.3" />\n  <package id="Evil.Payload" version="1.0.0" />\n</packages>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "packages.config", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/Evil\.Payload/);
		expect(r?.reason).toMatch(/nuget/);
	});

	it("allows an allowlisted nuget package", () => {
		addToAllowlist(workspace, "nuget", "Serilog", { approved_by: "x" });
		const before = `<packages>\n</packages>`;
		const after = `<packages>\n  <package id="Serilog" version="3.1.1" />\n</packages>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "packages.config", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null on a version bump of an existing package", () => {
		const before = `<packages>\n  <package id="Newtonsoft.Json" version="13.0.2" />\n</packages>`;
		const after = `<packages>\n  <package id="Newtonsoft.Json" version="13.0.3" />\n</packages>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "packages.config", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("returns null on a no-package edit (comment only)", () => {
		const before = `<packages>\n</packages>`;
		const after = `<packages>\n  <!-- restored -->\n</packages>`;
		const r = evaluateManifestEdit(
			newContent({ filename: "packages.config", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — irrelevant files", () => {
	it("returns null for non-manifest files", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "src/foo.ts",
				current: "export const x = 1;",
				next: "export const x = 2;",
			}),
		);
		expect(r).toBeNull();
	});

	it("returns null for malformed JSON (don't fail-closed on parse errors — agents need feedback)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: '{"valid":true}',
				next: "{not json",
			}),
		);
		// Parse failure means we can't compute diff. Don't block on syntax;
		// other guards will surface JSON validity feedback separately.
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — new file (no current)", () => {
	it("blocks a brand-new package.json that introduces unapproved deps", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: null,
				next: JSON.stringify({ dependencies: { evil: "1" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
	});

	it("allows a brand-new package.json with no deps", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: null,
				next: JSON.stringify({ name: "x" }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — license policy (recorded field, never network)", () => {
	function approveWithLicense(name: string, license?: string): void {
		addToAllowlist(workspace, "npm", name, {
			approved_by: "qcody",
			...(license !== undefined ? { license } : {}),
		});
	}

	function editAddingDep(dep: string, warnings: string[]) {
		const base = newContent({
			filename: "package.json",
			current: JSON.stringify({ name: "x", dependencies: {} }, null, 2),
			next: JSON.stringify({ name: "x", dependencies: { [dep]: "1.0.0" } }, null, 2),
		});
		return { ...base, allowlist: loadAllowlist(workspace), warnings };
	}

	it("warns when an allowed dep's recorded license is outside the SPDX allowlist", () => {
		approveWithLicense("copyleft-pkg", "AGPL-3.0");
		const warnings: string[] = [];
		const r = evaluateManifestEdit(editAddingDep("copyleft-pkg", warnings));
		expect(r).toBeNull(); // allowed — license drift is a warning, not a block
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/AGPL-3\.0/);
		expect(warnings[0]).toMatch(/license_allowlist/);
	});

	it("warning fires for a --force-admitted license even though the dep is approved", () => {
		approveWithLicense("gpl-pkg", "GPL-3.0");
		const warnings: string[] = [];
		evaluateManifestEdit(editAddingDep("gpl-pkg", warnings));
		expect(warnings.some((w) => w.includes("GPL-3.0"))).toBe(true);
	});

	it("stays silent for an allowed license", () => {
		approveWithLicense("mit-pkg", "MIT");
		const warnings: string[] = [];
		const r = evaluateManifestEdit(editAddingDep("mit-pkg", warnings));
		expect(r).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("stays silent when no license was recorded at admission (no noise for old grants)", () => {
		approveWithLicense("legacy-pkg");
		const warnings: string[] = [];
		const r = evaluateManifestEdit(editAddingDep("legacy-pkg", warnings));
		expect(r).toBeNull();
		expect(warnings).toHaveLength(0);
	});

	it("does not crash when no warnings array is provided", () => {
		approveWithLicense("copyleft-pkg2", "AGPL-3.0");
		const base = newContent({
			filename: "package.json",
			current: JSON.stringify({ name: "x", dependencies: {} }, null, 2),
			next: JSON.stringify({ name: "x", dependencies: { "copyleft-pkg2": "1.0.0" } }, null, 2),
		});
		const r = evaluateManifestEdit({ ...base, allowlist: loadAllowlist(workspace) });
		expect(r).toBeNull();
	});

	it("respects a committed license_allowlist override (no warning when policy permits)", () => {
		approveWithLicense("agpl-ok", "AGPL-3.0");
		const al = loadAllowlist(workspace);
		al.license_allowlist = ["AGPL-3.0"];
		const base = newContent({
			filename: "package.json",
			current: JSON.stringify({ name: "x", dependencies: {} }, null, 2),
			next: JSON.stringify({ name: "x", dependencies: { "agpl-ok": "1.0.0" } }, null, 2),
		});
		const warnings: string[] = [];
		evaluateManifestEdit({ ...base, allowlist: al, warnings });
		expect(warnings).toHaveLength(0);
	});
});

describe("evaluateManifestEdit — requirements.in", () => {
	it("blocks a new unapproved Python dep line in requirements.in", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.in",
				current: "requests==2.31.0\n",
				next: "requests==2.31.0\nevil-pkg==1.0\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil-pkg/);
	});
});

describe("evaluateManifestEdit — requirements.txt pip-flag and unparseable lines", () => {
	it("ignores a pip flag line (not '-e ') and still blocks the real new dep", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "",
				next: "--no-binary :all:\nevil==1.0\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("skips a line that doesn't match the name pattern", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.txt",
				current: "",
				next: "===not-a-name===\n",
			}),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — go.mod", () => {
	it("blocks a new unapproved go.mod require (block form) and skips the already-present one", () => {
		const before = `module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/existing/pkg v1.0.0\n)`;
		const after = `module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/existing/pkg v1.0.0\n\tgithub.com/evil/pkg v1.0.0\n)`;
		const r = evaluateManifestEdit(
			newContent({ filename: "go.mod", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/github\.com\/evil\/pkg/);
		expect(r?.reason).not.toMatch(/existing/);
		expect(r?.reason).toMatch(/go/);
	});

	it("allows an allowlisted go.mod require", () => {
		addToAllowlist(workspace, "go", "github.com/ok/pkg", { approved_by: "x" });
		const before = `module example.com/app\n`;
		const after = `module example.com/app\n\nrequire github.com/ok/pkg v1.0.0\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "go.mod", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — package.json with non-object parsed shape", () => {
	it("treats a non-object valid-JSON 'before' as having no existing deps (recordOf guard)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify("just a string"),
				next: JSON.stringify({ dependencies: { evil: "1.0.0" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("blocks a new dep pinned to a file: spec", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: {} }, null, 2),
				next: JSON.stringify({ dependencies: { evil: "file:../evil" } }, null, 2),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/file:/);
	});
});

describe("evaluateManifestEdit — package.json manifest unreadable on disk (safeRead catch)", () => {
	it("treats an unreadable existing manifest as empty (EISDIR) rather than crashing", () => {
		const path = join(workspace, "package.json");
		mkdirSync(path, { recursive: true }); // a directory at the manifest's path — readFileSync throws EISDIR
		const r = evaluateManifestEdit({
			filePath: path,
			newContent: JSON.stringify({ dependencies: { evil: "1.0.0" } }, null, 2),
			allowlist: loadAllowlist(workspace),
			cwd: workspace,
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});
});

describe("evaluateManifestEdit — pyproject.toml project.dependencies array form", () => {
	it("blocks a new unapproved entry in the PEP 508 dependencies array", () => {
		const before = `dependencies = [\n  "requests==2.31.0",\n]\n`;
		const after = `dependencies = [\n  "requests==2.31.0",\n  "evil==1.0",\n]\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("allows an allowlisted entry in the dependencies array", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const before = `dependencies = [\n]\n`;
		const after = `dependencies = [\n  "requests==2.31.0",\n]\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — pyproject.toml malformed lines / unnamed array items", () => {
	it("skips a poetry-block line that doesn't match key = value", () => {
		const before = `[tool.poetry.dependencies]\npython = "^3.11"\n`;
		const after = `[tool.poetry.dependencies]\npython = "^3.11"\nnot-a-kv-line\nevil = "^1.0"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("ignores a dependencies-array item that doesn't start with a valid name", () => {
		const before = `dependencies = [\n  "requests==2.31.0",\n]\n`;
		const after = `dependencies = [\n  "requests==2.31.0",\n  "===not-a-name",\n]\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — Cargo.toml preamble and non-matching lines", () => {
	it("skips content before the [dependencies] header and unmatched lines inside it", () => {
		const before = `# top comment\n[dependencies]\nnot-a-valid-line-without-equals\nserde = "1"\n`;
		const after = `# top comment\n[dependencies]\nnot-a-valid-line-without-equals\nserde = "1"\nevil = "1"\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("blocks a Cargo.toml url= inline-table repin to a non-registry source", () => {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = { url = "https://attacker.com/serde.tar.gz" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		// Pin the tarball_url branch specifically (inline `url = "https://...tar.gz"` form).
		expect(r?.reason).toMatch(/tarball URL installs are never auto-allowed/);
	});
});

describe("evaluateManifestEdit — Gemfile without a version constraint", () => {
	it("blocks a new gem line with no version argument", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "Gemfile",
				current: `gem "foo"\n`,
				next: `gem "foo"\ngem "evil"\n`,
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});
});

describe("evaluateManifestEdit — .csproj / version-catalog / gradle map-notation (hardening)", () => {
	it("blocks an unapproved <PackageReference> added to a .csproj (modern .NET form)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "App.csproj",
				current: "<Project><ItemGroup></ItemGroup></Project>",
				next: '<Project><ItemGroup><PackageReference Include="Evil.Pkg" Version="1.0.0" /></ItemGroup></Project>',
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/Evil\.Pkg/);
		expect(r?.reason).toMatch(/nuget/);
	});

	it("allows an allowlisted <PackageReference> in a nested .csproj", () => {
		addToAllowlist(workspace, "nuget", "Serilog", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "src/App/App.csproj",
				current: "<Project></Project>",
				next: '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0"/></ItemGroup></Project>',
			}),
		);
		expect(r).toBeNull();
	});

	it("blocks an unapproved coordinate added to libs.versions.toml (version-catalog)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "gradle/libs.versions.toml",
				current: "[libraries]\n",
				next: '[libraries]\nevil = { module = "com.evil:payload", version = "1.0" }\n',
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/com\.evil:payload/);
		expect(r?.reason).toMatch(/gradle/);
	});

	it("allows an allowlisted version-catalog coordinate (group/name form)", () => {
		addToAllowlist(workspace, "gradle", "com.google.guava:guava", { approved_by: "x" });
		const r = evaluateManifestEdit(
			newContent({
				filename: "libs.versions.toml",
				current: "[libraries]\n",
				next: '[libraries]\nguava = { group = "com.google.guava", name = "guava", version = "33.0" }\n',
			}),
		);
		expect(r).toBeNull();
	});

	it("blocks an unapproved gradle map-notation dependency (group:/name:)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "build.gradle",
				current: "dependencies {\n}\n",
				next: "dependencies {\n  implementation group: 'com.evil', name: 'pkg', version: '1.0'\n}\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/com\.evil:pkg/);
	});

	it("does not block a non-dependency .csproj edit (property change)", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "App.csproj",
				current: "<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>",
				next: "<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
			}),
		);
		expect(r).toBeNull();
	});
});

// ============================================================
// Mutation-survivor hardening (2026-08-09). Each test below is written
// against a specific surviving mutant (see `interlinked mutation survivors
// --file manifest-edit-guard`), not against generic behavior — the goal is
// to pin a REAL boundary (exact regex reach, exact reason text, exact
// captured value) rather than just re-check decision === "block"/null.
// ============================================================

describe("evaluateManifestEdit — .csproj extension-check specificity", () => {
	it("does not treat an arbitrary file containing <package> tags as a nuget manifest (name.endsWith('.csproj') pin)", () => {
		// If the ".csproj" literal ever degrades to "" (endsWith("") is always
		// true), every file would resolve to the nuget handler.
		const r = evaluateManifestEdit(
			newContent({
				filename: "notes.txt",
				current: "<packages>\n</packages>",
				next: '<packages>\n  <package id="Evil.Payload" version="1.0.0" />\n</packages>',
			}),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — brand-new-file fallback content", () => {
	it("treats a brand-new requirements.txt as having no prior deps, not literal placeholder text", () => {
		// The "before" fallback for a non-existent file is the empty string.
		// If that literal ever becomes something else (e.g. "Stryker was
		// here!"), diffLineOriented would parse a bogus prior dep name out of
		// it and swallow a same-named new dependency.
		const r = evaluateManifestEdit(
			newContent({
				filename: "requirements.in",
				current: null,
				next: "Stryker==1.0\n",
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/Stryker/);
	});
});

describe("evaluateManifestEdit — safeRead catch-path content", () => {
	it("treats an unreadable manifest as truly empty, not literal placeholder text (line-oriented sensitivity)", () => {
		// package.json's before/after diff can't distinguish "" from bogus
		// placeholder text (both parse to {} via parseJsonSafe), so the
		// existing EISDIR test doesn't pin safeRead's own catch-return value.
		// requirements.txt is line-oriented and does distinguish them.
		const path = join(workspace, "requirements.txt");
		mkdirSync(path, { recursive: true }); // EISDIR on readFileSync
		const r = evaluateManifestEdit({
			filePath: path,
			newContent: "Stryker==1.0\n",
			allowlist: loadAllowlist(workspace),
			cwd: workspace,
		});
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/Stryker/);
	});
});

describe("evaluateManifestEdit — diffPackageJson non-string / unchanged old values", () => {
	it("does not treat a non-string old dep value as diffable (typeof guard pin)", () => {
		// oldDeps["foo"] is a number here — the re-pin check must require the
		// OLD value to be a string before comparing/inspecting the new one.
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: { foo: 123 } }, null, 2),
				next: JSON.stringify(
					{ dependencies: { foo: "git+https://attacker.com/evil.git" } },
					null,
					2,
				),
			}),
		);
		expect(r).toBeNull();
	});

	it("does not re-flag an unchanged git-URL-pinned dep as a new delta (identity guard pin)", () => {
		const pinned = JSON.stringify(
			{ dependencies: { foo: "git+https://ok.example/foo.git" } },
			null,
			2,
		);
		const r = evaluateManifestEdit(
			newContent({ filename: "package.json", current: pinned, next: pinned }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — diffByValueShape identity guard (TOML ecosystems)", () => {
	it("does not re-block an unchanged git-pinned Cargo dep (oldValue !== value pin)", () => {
		const pinned = `[dependencies]\nserde = { git = "https://ok.example/serde" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: pinned, next: pinned }),
		);
		expect(r).toBeNull();
	});
});

describe("evaluateManifestEdit — diffLineOriented multi-line before-set (regex-anchor pin)", () => {
	it("computes the before-set from every line, not just the first, on an unchanged multi-dep file", () => {
		// A regex that degrades from /\r?\n/ to /\r\n/ can't split \n-only
		// content, so a multi-line "before" collapses into a single blob and
		// only the first dep name survives into beforeSet.
		const content = "requests==2.31.0\nfoo==1.0\n";
		const r = evaluateManifestEdit(
			newContent({ filename: "requirements.txt", current: content, next: content }),
		);
		expect(r).toBeNull();
	});
});

describe("classifyManifestValue — tarball_url boundary (via package.json new-dep values)", () => {
	function classify(value: string) {
		return evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: {} }, null, 2),
				next: JSON.stringify({ dependencies: { foo: value } }, null, 2),
			}),
		);
	}

	it("classifies a bare .tgz URL as tarball_url", () => {
		const r = classify("https://attacker.com/foo.tgz");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/tarball URL installs are never auto-allowed/);
	});

	it("classifies a bare .tgz URL over plain http (not only https)", () => {
		const r = classify("http://attacker.com/foo.tgz");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/tarball URL installs are never auto-allowed/);
	});

	it("does not classify a tarball extension followed by trailing non-query junk as tarball_url", () => {
		const r = classify("https://attacker.com/foo.tgz.README");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
	});

	it("classifies a tarball URL with a query string as tarball_url", () => {
		const r = classify("https://attacker.com/foo.tgz?token=abc123");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/tarball URL installs are never auto-allowed/);
	});

	it("does not classify a value that merely contains a tarball URL substring, unanchored (anchor pin)", () => {
		const r = classify("1.0.0 (mirrors https://attacker.com/foo.tgz)");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
	});
});

describe("looksLikeUrlSpec — package.json repin prefixes (existing-name value change)", () => {
	function repin(before: string, after: string) {
		return evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: { foo: before } }, null, 2),
				next: JSON.stringify({ dependencies: { foo: after } }, null, 2),
			}),
		);
	}

	it("blocks repinning to a file: spec", () => {
		const r = repin("^1.0.0", "file:../evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/file: installs are never auto-allowed/);
	});

	it("blocks repinning to a github: shorthand", () => {
		const r = repin("^1.0.0", "github:attacker/evil");
		expect(r?.decision).toBe("block");
	});

	it("blocks repinning to a gitlab: shorthand", () => {
		const r = repin("^1.0.0", "gitlab:attacker/evil");
		expect(r?.decision).toBe("block");
	});

	it("blocks repinning to a bitbucket: shorthand", () => {
		const r = repin("^1.0.0", "bitbucket:attacker/evil");
		expect(r?.decision).toBe("block");
	});

	it("blocks repinning to a plain https: URL (no .git/tarball suffix)", () => {
		const r = repin("^1.0.0", "https://mirror.evil/foo");
		expect(r?.decision).toBe("block");
	});

	it("does not repin-flag a version string merely containing 'https:' without starting with it (anchor pin)", () => {
		const r = repin("^1.0.0", "1.0.0 (see https://example.com)");
		expect(r).toBeNull();
	});

	it("does not repin-flag a value merely CONTAINING 'git+' when it doesn't start there (leading-anchor pin: git+)", () => {
		const r = repin("^1.0.0", "resolved git+https://evil.git");
		expect(r).toBeNull();
	});

	it("repin-flags a bare http:// (not just https://) URL (mandatory-s regression pin)", () => {
		const r = repin("^1.0.0", "http://mirror.evil/foo");
		expect(r?.decision).toBe("block");
	});

	it("does not repin-flag a value merely CONTAINING 'file:' when it doesn't start there (leading-anchor pin: file:)", () => {
		const r = repin("^1.0.0", "resolved file:../evil");
		expect(r).toBeNull();
	});

	it("does not repin-flag a value merely CONTAINING 'github:' when it doesn't start there (leading-anchor pin: github:)", () => {
		const r = repin("^1.0.0", "resolved github:attacker/evil");
		expect(r).toBeNull();
	});

	it("does not repin-flag a value merely CONTAINING 'gitlab:' when it doesn't start there (leading-anchor pin: gitlab:)", () => {
		const r = repin("^1.0.0", "resolved gitlab:attacker/evil");
		expect(r).toBeNull();
	});

	it("does not repin-flag a value merely CONTAINING 'bitbucket:' when it doesn't start there (leading-anchor pin: bitbucket:)", () => {
		const r = repin("^1.0.0", "resolved bitbucket:attacker/evil");
		expect(r).toBeNull();
	});
});

describe("looksLikeNonRegistrySource — TOML inline-table repins (Cargo)", () => {
	// Unlike git=/path=/url=, classifyManifestValue has no dedicated branch
	// for repository=/registry=/source= — a value matched by
	// looksLikeNonRegistrySource() but not one of those three inline forms
	// falls through to a plain { kind: "registry", name } classification.
	// So if the package name was ALREADY approved (as the git=/path=/url=
	// siblings above pre-approve it to prove the repin itself is what's
	// gated), the repin would be silently ALLOWED instead of blocked — these
	// three deliberately leave "serde" unapproved so the assertion still
	// distinguishes "delta detected" (blocked, unapproved name) from
	// "delta not detected" (null) if looksLikeNonRegistrySource regresses.
	function repinCargoUnapproved(after: string) {
		const before = `[dependencies]\nserde = "1"\n`;
		return evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
	}

	it("blocks repinning to a repository= source (unapproved name — proves the delta was detected)", () => {
		const r = repinCargoUnapproved(
			`[dependencies]\nserde = { repository = "https://mirror.evil/index" }\n`,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/serde/);
	});

	it("blocks repinning to a registry= source (unapproved name — proves the delta was detected)", () => {
		const r = repinCargoUnapproved(
			`[dependencies]\nserde = { version = "1", registry = "my-registry" }\n`,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/serde/);
	});

	it("blocks repinning to a source= source (unapproved name — proves the delta was detected)", () => {
		const r = repinCargoUnapproved(`[dependencies]\nserde = { source = "vendored-registry" }\n`);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/serde/);
	});
});

describe("looksLikeNonRegistrySource — bare-prefix repins (composer.json, unquoted JSON values)", () => {
	function repinComposer(after: string) {
		addToAllowlist(workspace, "composer", "monolog/monolog", { approved_by: "x" });
		const before = JSON.stringify({ require: { "monolog/monolog": "^3.0" } }, null, 2);
		return evaluateManifestEdit(
			newContent({ filename: "composer.json", current: before, next: after }),
		);
	}

	it("blocks repinning to a bare github: value with no key prefix", () => {
		const r = repinComposer(
			JSON.stringify({ require: { "monolog/monolog": "github:attacker/monolog" } }, null, 2),
		);
		expect(r?.decision).toBe("block");
	});

	it("blocks repinning to a bare https: value with no key prefix", () => {
		const r = repinComposer(
			JSON.stringify(
				{ require: { "monolog/monolog": "https://mirror.evil/monolog.zip" } },
				null,
				2,
			),
		);
		expect(r?.decision).toBe("block");
	});

	it("blocks repinning to a bare file: value with no key prefix", () => {
		const r = repinComposer(
			JSON.stringify({ require: { "monolog/monolog": "file:../evil" } }, null, 2),
		);
		expect(r?.decision).toBe("block");
	});
});

describe("classifyManifestValue — registry=/repository=/source= inline-table redirects", () => {
	// Security-gap regression: looksLikeNonRegistrySource() (the diff-detection
	// layer) already recognizes repository=/registry=/source= and produces a
	// delta, but classifyManifestValue() (the classification layer that decides
	// WHICH allowlist rule applies) had no branch for them — a value shaped
	// like `{ registry = "…" }` fell through to `{ kind: "registry", name }`.
	// That's harmless when the name is unapproved (blocked either way, as the
	// "TOML inline-table repins (Cargo)" describe above proves), but when the
	// name IS already approved for the default registry, the redirect rode
	// through silently as an ordinary version bump — the allowlist entry says
	// nothing about the alternate host. These cases pre-approve the name so a
	// regression back to the old fallthrough would flip block -> allow (null).
	function repinCargoApproved(after: string) {
		addToAllowlist(workspace, "cargo", "serde", { approved_by: "x" });
		const before = `[dependencies]\nserde = "1"\n`;
		return evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
	}

	it("P1: blocks repinning an APPROVED cargo dep to a bare registry= alias", () => {
		const r = repinCargoApproved(`[dependencies]\nserde = { registry = "my-registry" }\n`);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/serde/);
		expect(r?.reason).toMatch(/never auto-allowed/);
	});

	it("P2: blocks repinning an APPROVED cargo dep to a repository= mirror URL", () => {
		const r = repinCargoApproved(
			`[dependencies]\nserde = { repository = "https://mirror.evil/index" }\n`,
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/serde/);
		expect(r?.reason).toMatch(/never auto-allowed/);
	});

	it("P3: blocks repinning an APPROVED pyproject.toml poetry dep to a source= alias", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const before = '[tool.poetry.dependencies]\nrequests = "^2.31"\n';
		const after =
			'[tool.poetry.dependencies]\nrequests = { version = "^2.31", source = "private-index" }\n';
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/requests/);
		expect(r?.reason).toMatch(/never auto-allowed/);
	});

	it("P4: blocks repinning an APPROVED Gemfile dep to a source: private-server key", () => {
		addToAllowlist(workspace, "rubygems", "foo", { approved_by: "x" });
		const before = 'gem "foo", "~> 1.0"\n';
		const after = 'gem "foo", source: "https://gems.example.com"\n';
		const r = evaluateManifestEdit(
			newContent({ filename: "Gemfile", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/foo/);
		expect(r?.reason).toMatch(/never auto-allowed/);
	});

	it("N1: does not block an APPROVED cargo dep's plain version bump (no registry/repository/source key)", () => {
		const r = repinCargoApproved(`[dependencies]\nserde = "1.2"\n`);
		expect(r).toBeNull();
	});

	it("N2: does not block an APPROVED pyproject.toml dep's plain version bump", () => {
		addToAllowlist(workspace, "pypi", "requests", { approved_by: "x" });
		const before = '[tool.poetry.dependencies]\nrequests = "^2.31"\n';
		const after = '[tool.poetry.dependencies]\nrequests = "^2.32"\n';
		const r = evaluateManifestEdit(
			newContent({ filename: "pyproject.toml", current: before, next: after }),
		);
		expect(r).toBeNull();
	});

	it("N3: does not mis-fire on a value containing 'source' as a substring, not a key (word-boundary check)", () => {
		// "opensource" has no word boundary before its embedded "source" — the
		// \bsource\s*[:=] regex must not match inside it. Uses a brand-NEW dep
		// (not a repin) so classifyManifestValue is always reached regardless
		// of the diff layer's own gating, isolating the classifier's own
		// word-boundary behavior. If the regex over-matched, the reason would
		// say "never auto-allowed" instead of the plain unapproved-name reason.
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = "1"\nfoo = { version = "1", note = "opensource" }\n`;
		const r = evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/foo/);
		expect(r?.reason).not.toMatch(/never auto-allowed/);
		expect(r?.reason).toMatch(/not in the cargo allowlist/);
	});
});

describe("evaluateManifestEdit — recordOf null/non-object field safety", () => {
	it("does not let a null 'dependencies' field swallow detection of a new devDependencies entry", () => {
		// If `v && typeof v === "object"` ever degrades to `v || typeof v ===
		// "object"`, a literal JSON null passes (typeof null === "object" is
		// the classic JS quirk) and recordOf returns null instead of {},
		// which throws inside Object.entries() and gets swallowed by
		// evaluateManifestEdit's outer try/catch — masking a real new dep in
		// a LATER field of the same edit.
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: null, devDependencies: {} }, null, 2),
				next: JSON.stringify(
					{ dependencies: null, devDependencies: { evil: "1.0.0" } },
					null,
					2,
				),
			}),
		);
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/evil/);
	});

	it("ignores a non-object 'dependencies' field (string) rather than iterating its characters", () => {
		const r = evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: {} }, null, 2),
				next: JSON.stringify({ dependencies: "not-an-object" }, null, 2),
			}),
		);
		expect(r).toBeNull();
	});
});

describe("extractPyprojectDeps (direct)", () => {
	it("does not parse pre-header content as a dependency (inDepsBlock starts false)", () => {
		const content = 'foo = "should-not-count"\n[tool.poetry.dependencies]\nrequests = "^2.31"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.has("foo")).toBe(false);
		expect(deps.get("requests")).toBe('"^2.31"');
	});

	it("does not capture dependency-shaped lines before any recognized header (!inDepsBlock guard pin)", () => {
		const content = 'stray = "1.0"\n[some.other.section]\nreal = "2.0"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.has("stray")).toBe(false);
		expect(deps.has("real")).toBe(false);
	});

	it("recognizes a tool.poetry.group.<name>.dependencies header (group-name char-class pin)", () => {
		const content = '[tool.poetry.group.dev.dependencies]\npytest = "^7.4"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("pytest")).toBe('"^7.4"');
	});

	it("recognizes a project.optional-dependencies.<name> header (suffix char-class pin)", () => {
		const content = '[project.optional-dependencies.test]\nrich = ">=13"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("rich")).toBe('">=13"');
	});

	it("trims leading whitespace from an indented dependency line (raw.trim() pin)", () => {
		const content = '[tool.poetry.dependencies]\n  indented = "1.0"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("indented")).toBe('"1.0"');
	});

	it("does not treat a line merely ending in '#' as a comment line (endsWith vs startsWith pin)", () => {
		const content = "[tool.poetry.dependencies]\nfoo = 1#\n";
		const deps = extractPyprojectDeps(content);
		expect(deps.get("foo")).toBe("1");
	});

	it("does not capture a dependency name from mid-line with a leading invalid character (anchor pin)", () => {
		const content = '[tool.poetry.dependencies]\n!foo = "1.0"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.has("foo")).toBe(false);
	});

	it("parses a dependency line with no space before '=' (whitespace-quantifier pin: before =)", () => {
		const content = '[tool.poetry.dependencies]\nfoo="1.0"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("foo")).toBe('"1.0"');
	});

	it("parses a dependency line with no space after '=' (whitespace-quantifier pin: after =)", () => {
		const content = '[tool.poetry.dependencies]\nfoo ="1.0"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("foo")).toBe('"1.0"');
	});

	it("captures the dependency value without absorbing the leading space after '=' (whitespace-class pin)", () => {
		const content = '[tool.poetry.dependencies]\nrequests = "^2.31"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("requests")).toBe('"^2.31"');
	});

	it("cleanly strips a trailing inline comment regardless of comment-marker spacing (comment-group regex pin)", () => {
		const content = '[tool.poetry.dependencies]\nfoo = "1.0"   # keep pinned for CVE-2024-1234\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("foo")).toBe('"1.0"');
	});

	it("excludes the 'python' version-pin key from captured dependencies (python-filter pin)", () => {
		const content = '[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "^2.31"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.has("python")).toBe(false);
		expect(deps.get("requests")).toBe('"^2.31"');
	});

	it("finds the PEP 508 dependencies array even with leading indentation (array-header whitespace pin)", () => {
		const content = '  dependencies = [\n  "requests==2.31.0",\n]\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("requests")).toBe("requests==2.31.0");
	});

	it("finds the dependencies array with no space before '=' (array-header pin: before =)", () => {
		const content = 'dependencies=[\n  "requests==2.31.0",\n]\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("requests")).toBe("requests==2.31.0");
	});

	it("finds the dependencies array with no space after '=' (array-header pin: after =)", () => {
		const content = 'dependencies =[\n  "requests==2.31.0",\n]\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.get("requests")).toBe("requests==2.31.0");
	});

	it("adds no array-form dependency when the dependencies array is empty ('|| []' fallback pin)", () => {
		const content = "dependencies = []\n";
		const deps = extractPyprojectDeps(content);
		expect(deps.size).toBe(0);
	});

	it("ignores an unnamed dependencies-array item rather than throwing (nm-guard pin)", () => {
		const content = 'dependencies = [\n  "===not-a-name",\n  "requests==2.31.0",\n]\n';
		expect(() => extractPyprojectDeps(content)).not.toThrow();
		const deps = extractPyprojectDeps(content);
		expect(deps.has("===not-a-name")).toBe(false);
		expect(deps.get("requests")).toBe("requests==2.31.0");
	});
});

describe("extractCargoDeps (direct)", () => {
	it("does not capture dependency-shaped lines before any [dependencies] header (inBlock init + guard pin)", () => {
		const content = 'stray = "1.0"\n[dependencies]\nserde = "1"\n';
		const deps = extractCargoDeps(content);
		expect(deps.has("stray")).toBe(false);
		expect(deps.get("serde")).toBe('"1"');
	});

	it("recognizes a target.<triple>.dependencies header (target-name char-class pin)", () => {
		const content = "[target.x86_64-unknown-linux-gnu.dependencies]\nlibc = \"0.2\"\n";
		const deps = extractCargoDeps(content);
		expect(deps.get("libc")).toBe('"0.2"');
	});

	it("trims leading whitespace from an indented dependency line (raw.trim() pin)", () => {
		const content = '[dependencies]\n  indented = "1.0"\n';
		const deps = extractCargoDeps(content);
		expect(deps.get("indented")).toBe('"1.0"');
	});

	it("does not capture a dependency-shaped line outside any recognized section (!inBlock guard pin)", () => {
		const content = '[package]\nname = "should-not-count"\n[dependencies]\nserde = "1"\n';
		const deps = extractCargoDeps(content);
		expect(deps.has("name")).toBe(false);
		expect(deps.get("serde")).toBe('"1"');
	});

	it("does not capture a dependency name from mid-line with a leading invalid character (anchor pin)", () => {
		const content = '[dependencies]\n!serde = "1"\n';
		const deps = extractCargoDeps(content);
		expect(deps.has("serde")).toBe(false);
	});

	it("parses a dependency line with no space before '=' (whitespace-quantifier pin: before =)", () => {
		const content = '[dependencies]\nserde="1"\n';
		const deps = extractCargoDeps(content);
		expect(deps.get("serde")).toBe('"1"');
	});

	it("captures the value without a leading space after '=' (whitespace-class pin: after =)", () => {
		const content = '[dependencies]\nserde = "1"\n';
		const deps = extractCargoDeps(content);
		expect(deps.get("serde")).toBe('"1"');
	});

	it("cleanly strips a trailing inline comment regardless of comment-marker spacing (comment-group regex pin)", () => {
		const content = '[dependencies]\nserde = "1"   # pinned for CVE-2024-0000\n';
		const deps = extractCargoDeps(content);
		expect(deps.get("serde")).toBe('"1"');
	});
});

describe("extractGemfileDeps (direct)", () => {
	it("does not match 'gem' occurring after other text on the same line (anchor pin)", () => {
		const content = 'xgem "foo"\n';
		const deps = extractGemfileDeps(content);
		expect(deps.has("foo")).toBe(false);
	});

	it("requires the gem declaration to end the line — no trailing non-comma content (trailing-$ pin)", () => {
		const content = 'gem "foo" something-else\n';
		const deps = extractGemfileDeps(content);
		expect(deps.has("foo")).toBe(false);
	});

	it("captures an indented 'gem' declaration (leading-whitespace class pin)", () => {
		const content = '  gem "foo"\n';
		const deps = extractGemfileDeps(content);
		expect(deps.get("foo")).toBe("");
	});

	it("captures a 'gem' declaration with multiple spaces before the name (quantifier pin: after gem)", () => {
		const content = 'gem  "foo"\n';
		const deps = extractGemfileDeps(content);
		expect(deps.get("foo")).toBe("");
	});

	it("captures a version constraint with a space before the comma (quantifier pin: before comma)", () => {
		const content = 'gem "foo" , "~> 1.0"\n';
		const deps = extractGemfileDeps(content);
		expect(deps.get("foo")).toBe('"~> 1.0"');
	});

	it("captures a version constraint with exactly one space after the comma cleanly (non-whitespace-class pin)", () => {
		const content = 'gem "foo", "~> 1.0"\n';
		const deps = extractGemfileDeps(content);
		expect(deps.get("foo")).toBe('"~> 1.0"');
	});

	it("captures a version constraint with two spaces after the comma cleanly (quantifier pin: after comma)", () => {
		const content = 'gem "foo",  "~> 1.0"\n';
		const deps = extractGemfileDeps(content);
		expect(deps.get("foo")).toBe('"~> 1.0"');
	});

	it("defaults to an empty string value when a gem has no version constraint (default-fallback pin)", () => {
		const content = 'gem "foo"\n';
		const deps = extractGemfileDeps(content);
		expect(deps.get("foo")).toBe("");
	});
});

describe("extractGoModDeps (direct, additional)", () => {
	it("does not open a require block when 'require (' appears mid-line (startsWith vs endsWith pin)", () => {
		const goMod = "foo require (\n\tgithub.com/x/y v1.0.0\n)";
		const deps = extractGoModDeps(goMod);
		expect(deps.size).toBe(0);
	});

	it("closes the require block on a bare ')' line so later content isn't misparsed as still-in-block", () => {
		const goMod = "require (\n\tgithub.com/x/y v1.0.0\n)\ngo 1.22 extra-token\n";
		const deps = extractGoModDeps(goMod);
		expect(deps.get("github.com/x/y")).toBe("v1.0.0");
		expect(deps.has("go")).toBe(false);
	});

	it("parses an inBlock require line with multiple spaces/tabs between module and version (gofmt alignment)", () => {
		const goMod = "require (\n\tgithub.com/x/y     v1.0.0\n)";
		const deps = extractGoModDeps(goMod);
		expect(deps.get("github.com/x/y")).toBe("v1.0.0");
	});

	it("does not treat 'require' occurring mid-line as a single-line require directive (anchor pin)", () => {
		const goMod = "xrequire github.com/x/y v1.0.0\n";
		const deps = extractGoModDeps(goMod);
		expect(deps.size).toBe(0);
	});

	it("parses a single-line require with multiple spaces after 'require' (quantifier pin: after require)", () => {
		const goMod = "require  github.com/x/y v1.0.0\n";
		const deps = extractGoModDeps(goMod);
		expect(deps.get("github.com/x/y")).toBe("v1.0.0");
	});

	it("parses a single-line require with multiple spaces before the version (quantifier pin: before version)", () => {
		const goMod = "require github.com/x/y    v1.0.0\n";
		const deps = extractGoModDeps(goMod);
		expect(deps.get("github.com/x/y")).toBe("v1.0.0");
	});
});

describe("parsePipRequirementLine (direct)", () => {
	it("trims whitespace left after stripping an inline comment (trim-after-strip pin)", () => {
		const parsed = parsePipRequirementLine("  requests==2.31.0  # comment");
		expect(parsed).toEqual({ name: "requests", value: "requests==2.31.0" });
	});

	it("does not strip a comment across an embedded newline (trailing-$ pin)", () => {
		const parsed = parsePipRequirementLine("foo # comment\nrest-of-line");
		expect(parsed?.value).toBe("foo # comment\nrest-of-line");
	});

	it("removes an inline comment entirely rather than replacing it with placeholder text (replacement-text pin)", () => {
		const parsed = parsePipRequirementLine("requests==2.31.0 # pinned for CVE");
		expect(parsed?.value).toBe("requests==2.31.0");
	});

	it("strips a multi-character inline comment fully, not just one char after '#' (comment-regex greedy pin)", () => {
		const parsed = parsePipRequirementLine("requests==2.31.0 # keep");
		expect(parsed?.value).toBe("requests==2.31.0");
	});

	it("uses the full URL-spec string as both name and value for a git+ line (URL-spec fast-path pin)", () => {
		const parsed = parsePipRequirementLine("git+https://example.com/pkg.git");
		expect(parsed).toEqual({
			name: "git+https://example.com/pkg.git",
			value: "git+https://example.com/pkg.git",
		});
	});

	it("treats a '-e <path>' editable install as a name/value pair, not a pip flag (OR-vs-AND, startsWith pin)", () => {
		const parsed = parsePipRequirementLine("-e ./local-pkg");
		expect(parsed).toEqual({ name: "./local-pkg", value: "./local-pkg" });
	});

	it("only strips a leading '-e ' prefix, not one occurring mid-string (anchor pin: -e strip)", () => {
		const parsed = parsePipRequirementLine("git+https://x.com/pkg -e trick.git");
		expect(parsed?.value).toBe("git+https://x.com/pkg -e trick.git");
	});

	it("strips all whitespace after '-e ', not just one space (quantifier pin: -e strip)", () => {
		const parsed = parsePipRequirementLine("-e   ./local-pkg");
		expect(parsed).toEqual({ name: "./local-pkg", value: "./local-pkg" });
	});

	it("returns null (not a throw) when the trimmed line doesn't start with a valid name character (final regex-guard pin)", () => {
		expect(() => parsePipRequirementLine("===not-a-name===")).not.toThrow();
		expect(parsePipRequirementLine("===not-a-name===")).toBeNull();
	});
});

// ============================================================
// K2 mutation-survivor hardening (2026-08-10). Each test below targets a
// SPECIFIC regex/branch identified via `mutation survivors --file
// manifest-edit-guard --json` (assignment K2, supply-chain PreToolUse
// gate) — not a generic re-check of decision === block/null.
// ============================================================

describe("classifyManifestValue — leading/trailing anchor pins (top-level branches)", () => {
	function classify(value: string) {
		return evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: {} }, null, 2),
				next: JSON.stringify({ dependencies: { foo: value } }, null, 2),
			}),
		);
	}

	it("does not classify a value merely CONTAINING a tarball URL when it doesn't start there (leading-anchor pin: tarball)", () => {
		const r = classify("resolved-from https://attacker.com/foo.tgz");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
		expect(r?.reason).not.toMatch(/tarball URL installs are never auto-allowed/);
	});

	it("does not classify a value merely CONTAINING 'git+' when it doesn't start there (leading-anchor pin: git+)", () => {
		const r = classify("resolved git+https://attacker.com/evil.git");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
		expect(r?.reason).not.toMatch(/git URL installs are never auto-allowed/);
	});

	it("does not classify a value merely CONTAINING 'github:' when it doesn't start there (leading-anchor pin: github:)", () => {
		const r = classify("see github:attacker/evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
		expect(r?.reason).not.toMatch(/git URL installs are never auto-allowed/);
	});

	it("does not classify a value merely CONTAINING 'gitlab:' when it doesn't start there (leading-anchor pin: gitlab:)", () => {
		const r = classify("see gitlab:attacker/evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
		expect(r?.reason).not.toMatch(/git URL installs are never auto-allowed/);
	});

	it("does not classify a value merely CONTAINING 'bitbucket:' when it doesn't start there (leading-anchor pin: bitbucket:)", () => {
		const r = classify("see bitbucket:attacker/evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
		expect(r?.reason).not.toMatch(/git URL installs are never auto-allowed/);
	});

	it("does not classify a bare-https .git URL when it doesn't start at the value's beginning (leading-anchor pin: https .git)", () => {
		const r = classify("mirror-of https://attacker.com/evil.git");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
		expect(r?.reason).not.toMatch(/git URL installs are never auto-allowed/);
	});

	it("does not classify a bare-https .git URL followed by trailing non-fragment text (trailing-anchor pin: https .git)", () => {
		const r = classify("https://attacker.com/evil.gitconfig");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
		expect(r?.reason).not.toMatch(/git URL installs are never auto-allowed/);
	});

	it("classifies a bare http:// (not just https://) .git URL as git_url (mandatory-s regression pin)", () => {
		const r = classify("http://attacker.com/evil.git");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git URL installs are never auto-allowed/);
	});

	it("classifies a bare https .git URL with a multi-char host/path and no fragment (single-char-host + optional-fragment pins)", () => {
		const r = classify("https://attacker.com/evil.git");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git URL installs are never auto-allowed/);
	});

	it("classifies a bare https .git URL with a multi-character fragment (single-char-fragment pin)", () => {
		const r = classify("https://attacker.com/evil.git#deadbeef");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git URL installs are never auto-allowed/);
	});
});

describe("classifyManifestValue — file: branch (anchor + replacement-text pins)", () => {
	function classify(value: string) {
		return evaluateManifestEdit(
			newContent({
				filename: "package.json",
				current: JSON.stringify({ dependencies: {} }, null, 2),
				next: JSON.stringify({ dependencies: { foo: value } }, null, 2),
			}),
		);
	}

	it("does not classify a value merely CONTAINING 'file:' when it doesn't start there (leading-anchor pin: file:)", () => {
		const r = classify("resolved file:../evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the npm allowlist/);
		expect(r?.reason).not.toMatch(/file: installs are never auto-allowed/);
	});

	it("strips zero slashes after 'file:' when none are present (quantifier pin: replace-regex slash-star vs literal slash)", () => {
		const r = classify("file:evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/file: installs are never auto-allowed \(evil\)/);
	});

	it("removes the file: prefix cleanly rather than substituting placeholder text (replacement-text pin)", () => {
		const r = classify("file:../evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/file: installs are never auto-allowed \(\.\.\/evil\)/);
	});
});

describe("classifyManifestValue — inline-table capture width/quantifier/class pins", () => {
	function classifyCargo(value: string) {
		const before = `[dependencies]\n`;
		const after = `[dependencies]\nfoo = ${value}\n`;
		return evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
	}

	it("captures the full inline git= value, not just its first character (quantifier pin: gitInline)", () => {
		const r = classifyCargo('{ git = "https://attacker.com/foo-evil-pkg" }');
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("https://attacker.com/foo-evil-pkg");
	});

	it("matches the path key with no whitespace around '=' or before the opening quote (quantifier pins: both \\s* around path's separator)", () => {
		const r = classifyCargo('{ path="../evil" }');
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/file: installs are never auto-allowed/);
	});

	it("requires an actual ':' or '=' immediately after 'path' (negated-class regression pin: path key)", () => {
		const r = classifyCargo("pathological-value");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/is not in the cargo allowlist/);
		expect(r?.reason).not.toMatch(/file: installs are never auto-allowed/);
	});

	it("matches path values with no surrounding quotes and captures ordinary (non-whitespace) characters (mandatory-quote + capture-class pins)", () => {
		const r = classifyCargo("path = ../evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/file: installs are never auto-allowed/);
	});

	it("captures the full path value, not just its first character (quantifier pin: pathInline final capture group)", () => {
		const r = classifyCargo('{ path = "../evil-long-path" }');
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("../evil-long-path");
	});

	it("does not require whitespace, quotes, or a specifically-'https' scheme around the url= key (quantifier + literal pins: urlInline)", () => {
		const r = classifyCargo("{ url=http://mirror.evil/payload }");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/tarball URL installs are never auto-allowed/);
	});

	it("captures the full inline url= value, not just its first character after the scheme (quantifier pin: urlInline final capture group)", () => {
		const r = classifyCargo('{ url = "https://attacker.com/payload-full-path.tgz" }');
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("https://attacker.com/payload-full-path.tgz");
	});

	it("does not require whitespace or quotes around the repository= key, and requires a real separator + varied capture characters (compact regression pin: repositoryInline)", () => {
		const r = classifyCargo("repository=../evil");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git URL installs are never auto-allowed/);
	});

	it("captures the full inline repository= value, not just its first character (quantifier pin: repositoryInline final capture group)", () => {
		const r = classifyCargo('{ repository = "https://mirror.evil/very-long-repo-path" }');
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("https://mirror.evil/very-long-repo-path");
	});

	it("does not require whitespace or quotes around the registry= key, and requires a real separator + varied capture characters (compact regression pin: registryInline)", () => {
		const r = classifyCargo("registry=alt-index-value");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git URL installs are never auto-allowed/);
	});

	it("captures the full inline registry= value, not just its first character (quantifier pin: registryInline final capture group)", () => {
		const r = classifyCargo('{ registry = "https://mirror.evil/very-long-registry-path" }');
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("https://mirror.evil/very-long-registry-path");
	});

	it("does not require whitespace or quotes around the source= key, and requires varied capture characters (compact regression pin: sourceInline)", () => {
		const r = classifyCargo("source=vendored-value");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toMatch(/git URL installs are never auto-allowed/);
	});

	it("captures the full inline source= value, not just its first character (quantifier pin: sourceInline final capture group)", () => {
		const r = classifyCargo('{ source = "https://mirror.evil/very-long-source-path" }');
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("https://mirror.evil/very-long-source-path");
	});
});

describe("looksLikeNonRegistrySource — key-detection quantifier/class/anchor pins (repin gating)", () => {
	function repinUnapproved(afterValue: string) {
		const before = `[dependencies]\nserde = "1"\n`;
		const after = `[dependencies]\nserde = ${afterValue}\n`;
		return evaluateManifestEdit(
			newContent({ filename: "Cargo.toml", current: before, next: after }),
		);
	}

	it("detects a bare path= repin with no surrounding whitespace (quantifier pin: path)", () => {
		expect(repinUnapproved("{path=/etc/evil}")?.decision).toBe("block");
	});

	it("detects a bare repository= repin with no surrounding whitespace (quantifier pin: repository)", () => {
		expect(repinUnapproved("{repository=https://mirror.evil}")?.decision).toBe("block");
	});

	it("detects a bare registry= repin with no surrounding whitespace (quantifier pin: registry)", () => {
		expect(repinUnapproved("{registry=alt-index}")?.decision).toBe("block");
	});

	it("detects a bare url= repin with no surrounding whitespace (quantifier pin: url)", () => {
		expect(repinUnapproved("{url=https://mirror.evil/x.tgz}")?.decision).toBe("block");
	});

	it("detects a bare source= repin with no surrounding whitespace (quantifier pin: source)", () => {
		expect(repinUnapproved("{source=vendored}")?.decision).toBe("block");
	});

	it("does not treat a repin as non-registry merely because path/repository/registry/url/source appear without a real separator (negated-class regression pin, all five keys)", () => {
		const r = repinUnapproved("pathological-registryless-repositoryless-urlless-sourceless");
		expect(r).toBeNull();
	});

	it("does not treat a repin as non-registry merely because it CONTAINS 'git+' (leading-anchor pin: git+)", () => {
		const r = repinUnapproved("resolved git+https://evil.git");
		expect(r).toBeNull();
	});

	it("does not treat a repin as non-registry merely because it CONTAINS 'https:' (leading-anchor pin: https?)", () => {
		const r = repinUnapproved("mirror at https://evil.example/pkg");
		expect(r).toBeNull();
	});

	it("detects a bare http:// (not just https://) repin as a non-registry source (mandatory-s regression pin: https?)", () => {
		const r = repinUnapproved("http://mirror.evil/pkg");
		expect(r?.decision).toBe("block");
	});

	it("does not treat a repin as non-registry merely because it CONTAINS 'file:' (leading-anchor pin: file:)", () => {
		const r = repinUnapproved("resolved file:../evil");
		expect(r).toBeNull();
	});

	it("does not treat a repin as non-registry merely because it CONTAINS 'github:' (leading-anchor pin: github:)", () => {
		const r = repinUnapproved("resolved github:attacker/evil");
		expect(r).toBeNull();
	});
});

describe("extractCargoDeps — TARGET header anchor + comment-marker direction pin", () => {
	it("does not treat a section header as [dependencies] merely because that text appears later in the line (leading-anchor pin)", () => {
		const content = '[foo][dependencies]\nserde = "1"\n';
		const deps = extractCargoDeps(content);
		expect(deps.has("serde")).toBe(false);
	});

	it("skips lines starting with '#', not lines merely ending with '#' (startsWith vs endsWith pin)", () => {
		const content = '[dependencies]\nserde = "1" #\n';
		const deps = extractCargoDeps(content);
		expect(deps.get("serde")).toBe('"1"');
	});
});

describe("extractPyprojectDeps — TARGET_HEADERS anchor pin", () => {
	it("does not enter a dependencies block merely because the header text appears later in the line (leading-anchor pin)", () => {
		const content = '[foo][tool.poetry.dependencies]\nrequests = "^2.31"\n';
		const deps = extractPyprojectDeps(content);
		expect(deps.has("requests")).toBe(false);
	});
});
