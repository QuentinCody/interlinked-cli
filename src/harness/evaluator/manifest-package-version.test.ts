import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToAllowlist, loadAllowlist } from "../package-allowlist.js";
import type { Ecosystem } from "../package-install-parser.js";
import { evaluateManifestEdit } from "./manifest-edit-guard.js";

let workspace: string;

beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "manifest-version-"));
});

afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
});

interface ManifestCase {
    filename: string;
    ecosystem: Ecosystem;
    name: string;
    version: string;
    content: string;
}

const exactCases: ManifestCase[] = [
    { filename: "requirements.txt", ecosystem: "pypi", name: "pyyaml", version: "6.0.3", content: "pyyaml==6.0.3\n" },
    { filename: "requirements.in", ecosystem: "pypi", name: "pyyaml", version: "6.0.3", content: "pyyaml[yaml] == 6.0.3 ; python_version >= '3.10' # comment\n" },
    { filename: "pyproject.toml", ecosystem: "pypi", name: "pyyaml", version: "6.0.3", content: '[project]\ndependencies = ["pyyaml[yaml]==6.0.3"]\n' },
    { filename: "pyproject.toml", ecosystem: "pypi", name: "pyyaml", version: "6.0.3", content: '[project]\ndependencies = [\'pyyaml==6.0.3 ; python_version >= "3.10"\']\n' },
    { filename: "pyproject.toml", ecosystem: "pypi", name: "pyyaml", version: "6.0.3", content: '[tool.poetry.dependencies]\npyyaml = "6.0.3"\n' },
    { filename: "pyproject.toml", ecosystem: "pypi", name: "pyyaml", version: "6.0.3", content: '[tool.poetry.dependencies]\npyyaml = { version = "==6.0.3", optional = true }\n' },
    { filename: "package.json", ecosystem: "npm", name: "library", version: "1.2.3", content: '{"dependencies":{"library":"1.2.3"}}' },
    { filename: "Cargo.toml", ecosystem: "cargo", name: "library", version: "1.2.3", content: '[dependencies]\nlibrary = "=1.2.3"\n' },
    { filename: "Cargo.toml", ecosystem: "cargo", name: "library", version: "1.2.3", content: '[dependencies]\nlibrary = { version = "=1.2.3", features = ["derive"] }\n' },
    { filename: "go.mod", ecosystem: "go", name: "example.com/library", version: "v1.2.3", content: 'require example.com/library v1.2.3\n' },
    { filename: "Gemfile", ecosystem: "rubygems", name: "library", version: "1.2.3", content: 'gem "library", "1.2.3"\n' },
    { filename: "composer.json", ecosystem: "composer", name: "vendor/library", version: "1.2.3", content: '{"require":{"vendor/library":"1.2.3"}}' },
    { filename: "pom.xml", ecosystem: "maven", name: "example:library", version: "1.2.3", content: '<dependency><groupId>example</groupId><artifactId>library</artifactId><version>1.2.3</version></dependency>' },
    { filename: "build.gradle", ecosystem: "gradle", name: "example:library", version: "1.2.3", content: 'implementation "example:library:1.2.3"' },
    { filename: "library.csproj", ecosystem: "nuget", name: "Library", version: "1.2.3", content: '<PackageReference Include="Library" Version="1.2.3" />' },
];

function approve(scenario: ManifestCase): void {
    addToAllowlist(workspace, scenario.ecosystem, scenario.name, {
        approved_by: "test-operator",
        version_range: scenario.version,
    });
}

function decide(filename: string, content: string) {
    return evaluateManifestEdit({
        filePath: join(workspace, filename),
        newContent: content,
        cwd: workspace,
        allowlist: loadAllowlist(workspace),
    });
}

describe("manifest additions with an exact operator approval", () => {
    it.each(exactCases)("accepts the approved pin in $filename: $content", (scenario) => {
        approve(scenario);
        expect(decide(scenario.filename, scenario.content)).toBeNull();
    });

    it.each(exactCases)("rejects a different version in $filename: $content", (scenario) => {
        approve(scenario);
        const wrong = scenario.content.replaceAll(scenario.version.replace(/^v/, ""), "9.9.9");
        const decision = decide(scenario.filename, wrong);
        expect(decision?.decision).toBe("block");
        expect(decision?.reason).toContain("9.9.9");
        expect(decision?.reason).not.toContain("<unspecified>");
    });

    it.each([
        "pyyaml", "pyyaml>=6.0.3", "pyyaml~=6.0.3", "pyyaml==6.0.*",
        "pyyaml==6.0.3,!=6.0.3", "pyyaml; python_version == '6.0.3'",
        "pyyaml @ https://example.com/pyyaml-6.0.3.whl",
        "pyyaml @ https://example.com/pyyaml.whl#version==6.0.3",
    ])("refuses a missing, floating or borrowed Python pin: %s", (requirement) => {
        approve(exactCases[0]!);
        expect(decide("requirements.txt", requirement)?.decision).toBe("block");
    });

    it.each(["pyyaml[yaml]>=6.0.3", "pyyaml[yaml]; python_version == '6.0.3'"])("does not lose PEP 508 extras before checking %s", (requirement) => {
        approve(exactCases[0]!);
        const content = `[project]\ndependencies = ["${requirement}"]\n`;
        expect(decide("pyproject.toml", content)?.decision).toBe("block");
    });

    it.each(["^6.0.3", "~6.0.3", ">=6.0.3"])("does not treat Poetry %s as an exact approved pin", (constraint) => {
        approve(exactCases[0]!);
        expect(decide("pyproject.toml", `[tool.poetry.dependencies]\npyyaml = "${constraint}"\n`)?.decision).toBe("block");
    });

    it.each(["^1.2.3", "~1.2.3"])("does not inherit permissive allowlist range normalization for npm %s", (constraint) => {
        approve(exactCases[6]!);
        expect(decide("package.json", JSON.stringify({ dependencies: { library: constraint } }))?.decision).toBe("block");
    });

    it.each(['{ version = "6.0.3", git = "https://example.com/repo.git" }', '{ version = "6.0.3", source = "private" }', '{ version = "6.0.3", path = "../outside" }'])("retains source restrictions alongside a matching version: %s", (value) => {
        approve(exactCases[0]!);
        expect(decide("pyproject.toml", `[tool.poetry.dependencies]\npyyaml = ${value}\n`)?.decision).toBe("block");
    });

    it("preserves the existing-dependency version-bump scope", () => {
        approve(exactCases[0]!);
        writeFileSync(join(workspace, "requirements.txt"), "pyyaml==6.0.2\n");
        expect(decide("requirements.txt", "pyyaml==9.9.9\n")).toBeNull();
    });

    it.each([
        '{ description = "{ version = \'6.0.3\' }" }',
        '{ metadata = { version = "6.0.3" } }',
        '{ version = "9.9.9", version = "6.0.3" }',
    ])("never borrows an inline version from another value: %s", (value) => {
        approve(exactCases[0]!);
        expect(decide("pyproject.toml", `[tool.poetry.dependencies]\npyyaml = ${value}\n`)?.decision).toBe("block");
    });

    it("finds the actual inline version after optional and extras fields", () => {
        approve(exactCases[0]!);
        const content = '[tool.poetry.dependencies]\npyyaml = { optional = true, extras = ["yaml"], version = "6.0.3" }\n';
        expect(decide("pyproject.toml", content)).toBeNull();
    });
});
