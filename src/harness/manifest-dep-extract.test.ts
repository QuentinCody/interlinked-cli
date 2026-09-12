import { describe, expect, it } from "vitest";
import {
	extractComposerDeps,
	extractGradleDeps,
	extractGradleVersionCatalogDeps,
	extractNugetDeps,
	extractPomDeps,
} from "./manifest-dep-extract.js";

describe("extractComposerDeps", () => {
	it("parses require + require-dev (keys are vendor/pkg)", () => {
		const deps = extractComposerDeps(
			JSON.stringify({
				require: { "monolog/monolog": "^3.0", php: ">=8.1" },
				"require-dev": { "phpunit/phpunit": "^10.0" },
			}),
		);
		expect(deps.get("monolog/monolog")).toBe("^3.0");
		expect(deps.get("phpunit/phpunit")).toBe("^10.0");
	});

	it("drops the platform `php` pseudo-package", () => {
		const deps = extractComposerDeps(
			JSON.stringify({ require: { php: ">=8.1", "ext-mbstring": "*" } }),
		);
		// `php` and `ext-*` are platform constraints, not registry packages.
		expect(deps.has("php")).toBe(false);
		expect(deps.has("ext-mbstring")).toBe(false);
	});

	it("returns empty for a manifest with no require blocks", () => {
		expect(extractComposerDeps(JSON.stringify({ name: "x/y" })).size).toBe(0);
	});

	it("returns empty (not throw) on invalid JSON", () => {
		expect(extractComposerDeps("{not json").size).toBe(0);
	});
});

describe("extractPomDeps", () => {
	it("parses <dependency> groupId:artifactId pairs", () => {
		const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>33.0.0-jre</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
    </dependency>
  </dependencies>
</project>`;
		const deps = extractPomDeps(pom);
		expect(deps.get("com.google.guava:guava")).toBe("33.0.0-jre");
		// No <version> → present with empty value (parent-managed version).
		expect(deps.has("org.junit.jupiter:junit-jupiter")).toBe(true);
	});

	it("ignores plugin groupId/artifactId outside a <dependency>", () => {
		const pom = `<project>
  <build><plugins><plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-surefire-plugin</artifactId>
  </plugin></plugins></build>
</project>`;
		expect(extractPomDeps(pom).size).toBe(0);
	});

	it("returns empty for a pom with no dependencies", () => {
		expect(extractPomDeps("<project></project>").size).toBe(0);
	});
});

describe("extractGradleDeps", () => {
	it("parses Groovy configuration calls with a G:A:V string", () => {
		const gradle = `dependencies {
  implementation "com.squareup.okhttp3:okhttp:4.12.0"
  api 'com.google.guava:guava:33.0.0-jre'
  testImplementation "org.junit.jupiter:junit-jupiter:5.10.0"
}`;
		const deps = extractGradleDeps(gradle);
		expect(deps.get("com.squareup.okhttp3:okhttp")).toBe("4.12.0");
		expect(deps.get("com.google.guava:guava")).toBe("33.0.0-jre");
		expect(deps.get("org.junit.jupiter:junit-jupiter")).toBe("5.10.0");
	});

	it("parses the Kotlin DSL ( \"G:A:V\" ) call form", () => {
		const kts = `dependencies {
  implementation("io.ktor:ktor-server-core:2.3.7")
  annotationProcessor("com.google.dagger:dagger-compiler:2.50")
}`;
		const deps = extractGradleDeps(kts);
		expect(deps.get("io.ktor:ktor-server-core")).toBe("2.3.7");
		expect(deps.get("com.google.dagger:dagger-compiler")).toBe("2.50");
	});

	it("ignores configuration calls that are not a G:A:V coordinate string", () => {
		const gradle = `dependencies {
  implementation project(":core")
  implementation fileTree(dir: "libs")
}`;
		expect(extractGradleDeps(gradle).size).toBe(0);
	});

	it("ignores non-dependency configuration verbs", () => {
		// `classpath` (buildscript) and arbitrary method calls are not in the
		// recognized configuration set.
		const gradle = `buildscript { dependencies { classpath "com.android.tools.build:gradle:8.2.0" } }`;
		expect(extractGradleDeps(gradle).size).toBe(0);
	});
});

describe("extractNugetDeps", () => {
	it("parses <package id=.. version=.. /> entries", () => {
		const cfg = `<?xml version="1.0" encoding="utf-8"?>
<packages>
  <package id="Newtonsoft.Json" version="13.0.3" targetFramework="net48" />
  <package id="Serilog" version="3.1.1" />
</packages>`;
		const deps = extractNugetDeps(cfg);
		expect(deps.get("Newtonsoft.Json")).toBe("13.0.3");
		expect(deps.get("Serilog")).toBe("3.1.1");
	});

	it("handles attribute order version-before-id", () => {
		const cfg = `<packages><package version="2.0.0" id="AutoMapper" /></packages>`;
		expect(extractNugetDeps(cfg).get("AutoMapper")).toBe("2.0.0");
	});

	it("returns empty for an empty packages.config", () => {
		expect(extractNugetDeps(`<packages></packages>`).size).toBe(0);
	});

	it("parses single-quoted id/version attributes (valid XML)", () => {
		// Single-quoted attrs are well-formed XML; matching only double quotes hid
		// the package from the guard and `allowlist verify` (finding 2026-06).
		expect(
			extractNugetDeps("<packages><package id='Legacy.Single' version='9.9.9' /></packages>").get(
				"Legacy.Single",
			),
		).toBe("9.9.9");
	});
});

describe("extractNugetDeps — modern <PackageReference> (.csproj)", () => {
	it("retains packages with missing versions so the install guard can reject unpinned dependencies", () => {
		expect([...extractNugetDeps('<package id="Legacy" /><PackageReference Include="Modern" />')]).toEqual([
			["Legacy", ""], ["Modern", ""],
		]);
	});
	it("parses the Version attribute form", () => {
		expect(extractNugetDeps('<PackageReference Include="Serilog" Version="3.0.0" />').get("Serilog")).toBe("3.0.0");
	});
	it("parses the child <Version> element form", () => {
		const d = extractNugetDeps('<PackageReference Include="Newtonsoft.Json"><Version>13.0.3</Version></PackageReference>');
		expect(d.get("Newtonsoft.Json")).toBe("13.0.3");
	});
	it("parses legacy <package> and modern <PackageReference> together without confusing them", () => {
		const d = extractNugetDeps('<package id="Legacy" version="1.0" /><PackageReference Include="Modern" Version="2.0"/>');
		expect(d.get("Legacy")).toBe("1.0");
		expect(d.get("Modern")).toBe("2.0");
	});
	it("returns empty for a .csproj with no package refs", () => {
		expect(extractNugetDeps("<Project><PropertyGroup/></Project>").size).toBe(0);
	});
	it("parses single-quoted Include/Version attributes (valid XML)", () => {
		expect(
			extractNugetDeps("<PackageReference Include='Evil.Single' Version='1.2.3' />").get(
				"Evil.Single",
			),
		).toBe("1.2.3");
	});
});

describe("extractGradleDeps — map-notation + 4-part coordinate", () => {
	it("parses the map-notation group:/name: form", () => {
		expect(extractGradleDeps("implementation group: 'com.evil', name: 'pkg', version: '1.0'").has("com.evil:pkg")).toBe(true);
	});
	it("parses map-notation when name precedes group", () => {
		expect(extractGradleDeps("implementation name: 'payload', group: 'com.evil', version: '1.0'").has("com.evil:payload")).toBe(true);
	});
	it("records a clean version for a 4-part coordinate (classifier not folded in)", () => {
		expect(extractGradleDeps('implementation "g:a:1.0:sources"').get("g:a")).toBe("1.0");
	});
	it("ignores non-dependency verbs (project/fileTree)", () => {
		expect(extractGradleDeps("project(':core')\nfileTree('libs')").size).toBe(0);
	});
});

describe("extractGradleVersionCatalogDeps — libs.versions.toml [libraries]", () => {
	it("parses the module = \"g:a\" form", () => {
		expect(extractGradleVersionCatalogDeps('[libraries]\nfoo = { module = "com.evil:payload", version = "1.0" }').has("com.evil:payload")).toBe(true);
	});
	it("parses the group/name form", () => {
		expect(extractGradleVersionCatalogDeps('[libraries]\nguava = { group = "com.google.guava", name = "guava" }').has("com.google.guava:guava")).toBe(true);
	});
	it("ignores [versions]/[plugins] sections", () => {
		expect(extractGradleVersionCatalogDeps('[versions]\nfoo = "1.0"\n[plugins]\np = { id = "x", version = "1" }').size).toBe(0);
	});
	it("parses single-quoted TOML literal `module` strings", () => {
		// TOML literal strings are single-quoted; matching only double quotes let
		// the coordinate slip past the guard and `allowlist verify` (finding 2026-06).
		expect(
			extractGradleVersionCatalogDeps(
				"[libraries]\nfoo = { module = 'com.evil:payload', version = '1.0' }",
			).has("com.evil:payload"),
		).toBe(true);
	});
	it("parses single-quoted `group`/`name` literal strings", () => {
		expect(
			extractGradleVersionCatalogDeps(
				"[libraries]\nbar = { group = 'io.evil', name = 'sneaky' }",
			).has("io.evil:sneaky"),
		).toBe(true);
	});
});
