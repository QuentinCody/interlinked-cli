import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverLintCommand } from "./command-discovery.js";
import { importedLintInvocation } from "./invocation.js";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "lint-invocation-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function command(text: string) {
    return discoverLintCommand({ command: text, scope: ".", origin: { file: "package.json", line: 1, kind: "package-script", label: "scripts.lint" } })[0]!.entry!;
}

describe("imported lint invocation", () => {
    it.each(["mypy", "phpcs"])("preserves %s configured file lists when no command targets were declared", (tool) => {
        expect(importedLintInvocation(root, { tool, scope: ".", sources: ["config"] }).args).not.toContain(".");
    });

    it("renders PHPCS config and semantic options in its required equals syntax", () => {
        const entry = command("phpcs --standard=rules.xml --extensions=php --sniffs=Generic.CodeAnalysis.EmptyStatement -s src");
        expect(importedLintInvocation(root, entry).args).toEqual([`--standard=${join(root, "rules.xml")}`, "--extensions=php", "--sniffs=Generic.CodeAnalysis.EmptyStatement", "-s", "--report=json", "src"]);
    });

    it("keeps a mypy package target without adding a directory target", () => {
        expect(importedLintInvocation(root, command("mypy --package app")).args).toEqual(["--package", "app", "--output=json"]);
    });
});
