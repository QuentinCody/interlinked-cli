import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProcessAsync } from "../../harness/check-engine/spawn-async.js";
import { runImportedLintAsync } from "../../harness/check-engine/tool-runners/lint-import.js";
import { tightenLintBaseline } from "./baseline.js";
import { lintInheritance } from "./inheritance.js";
import { checkLintSources, LINT_BASELINE_PATH, LINT_POLICY_PATH, writeLintJson } from "./policy.js";
import { measureImportedLint } from "./runner.js";
import { prepareLintImport } from "./selection.js";

vi.mock("../../harness/check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
const roots: string[] = [];

function project() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lint-inheritance-")));
    roots.push(root);
    return { root, put(file: string, text: string): void {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
    } };
}

beforeEach(() => { vi.mocked(runProcessAsync).mockReset(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("analyzer inheritance input graphs", () => {
    it.each(["ruff.toml", ".ruff.toml", "pyproject.toml"])("tracks transitive bare Ruff paths from %s relative to each declaring file", file => {
        const { root, put } = project();
        put(file, `${file === "pyproject.toml" ? "[tool.ruff]\n" : ""}extend = "config/base.toml"\n`);
        put("config/base.toml", "extend = 'leaf.toml'\n");
        put("config/leaf.toml", '[lint]\nselect = ["F"]\n');
        const { policy } = prepareLintImport(root, {});
        expect(Object.keys(policy.digests).sort()).toEqual([file, "config/base.toml", "config/leaf.toml"].sort());
        expect(() => checkLintSources(root, policy)).not.toThrow();
        put("config/leaf.toml", "[lint]\nselect = []\n");
        expect(() => checkLintSources(root, policy)).toThrow("Lint configuration changed: config/leaf.toml");
    });

    it("preserves a selected Ruff configuration's directory when its lint scope differs", () => {
        const { root, put } = project();
        put("config/python.toml", 'extend = "base.toml"\n');
        put("config/base.toml", '[lint]\nselect = ["F"]\n');
        const { policy } = prepareLintImport(root, { config: ["ruff=config/python.toml"] });
        expect(policy.entries[0]?.scope).toBe(".");
        expect(policy.digests["config/base.toml"]).toMatch(/^[a-f0-9]{64}$/);
    });

    it.each([
        { file: "biome.jsonc", tool: "biome" },
        { file: ".oxlintrc.json", tool: "oxlint" },
    ])("tracks $tool extends while excluding unrelated bare settings", ({ file }) => {
        const { root, put } = project();
        put(file, '{"extends":["config/base.json"],"settings":{"name":"unrelated.json"}}');
        put("config/base.json", '{"extends":["leaf.json"]}');
        put("config/leaf.json", "{}");
        put("unrelated.json", "{}");
        const { policy } = prepareLintImport(root, {});
        expect(Object.keys(policy.digests).sort()).toEqual([file, "config/base.json", "config/leaf.json"].sort());
        put("config/leaf.json", '{"rules":{}}');
        expect(() => checkLintSources(root, policy)).toThrow("Lint configuration changed: config/leaf.json");
    });

    it("requires review for policies saved before literal inheritance was tracked", () => {
        const { root, put } = project();
        put("ruff.toml", 'extend = "base.toml"\n');
        put("base.toml", "");
        const { policy } = prepareLintImport(root, {});
        const legacy = { ...policy,
            entries: policy.entries.map(entry => ({ ...entry, sources: entry.sources.filter(file => file !== "base.toml") })),
            digests: Object.fromEntries(Object.entries(policy.digests).filter(([file]) => file !== "base.toml")),
        };
        expect(() => checkLintSources(root, legacy)).toThrow("New lint configuration dependency: base.toml");
        expect(Object.hasOwn(legacy.digests, "base.toml")).toBe(false);
    });

    it("rejects absent inheritance instead of guessing an extension or forgetting a deleted input", () => {
        const { root, put } = project();
        put("ruff.toml", 'extend = "base.toml"\n');
        put("base.toml.js", "");
        expect(() => prepareLintImport(root, {})).toThrow("Missing lint inheritance input: ruff.toml -> base.toml");
        put("base.toml", "");
        const { policy } = prepareLintImport(root, {});
        rmSync(join(root, "base.toml"));
        expect(() => checkLintSources(root, policy)).toThrow("Lint configuration changed: base.toml");
    });

    it.each(["${CONFIG_DIR}/base.toml", "~/base.toml", "https://example.test/base.toml", "*.toml", "../outside.toml"])("does not silently omit unresolved inheritance %s", reference => {
        const { root, put } = project();
        put("ruff.toml", `extend = ${JSON.stringify(reference)}\n`);
        expect(() => prepareLintImport(root, {})).toThrow(/requires review|Out-of-project/);
    });

    it("refuses inherited drift before an analyzer can report clean and retire existing debt", async () => {
        const { root, put } = project();
        put("ruff.toml", 'extend = "base.toml"\n');
        put("base.toml", '[lint]\nselect = ["F"]\n');
        put("a.py", "import os\n");
        const { policy } = prepareLintImport(root, {});
        writeLintJson(root, LINT_POLICY_PATH, policy);
        vi.mocked(runProcessAsync).mockResolvedValue({ code: 1, stdout: JSON.stringify([
            { filename: "a.py", location: { row: 1 }, code: "F401", message: "unused os" },
        ]), stderr: "", timedOut: false, killed: false });
        const measured = await measureImportedLint(root, policy);
        expect(measured[0]?.findings).toHaveLength(1);
        tightenLintBaseline(root, measured);
        const before = readFileSync(join(root, LINT_BASELINE_PATH), "utf8");
        put("base.toml", "[lint]\nselect = []\n");
        vi.mocked(runProcessAsync).mockReset().mockResolvedValue({ code: 0, stdout: "[]", stderr: "", timedOut: false, killed: false });
        await expect(runImportedLintAsync({ scope: { projectRoot: root, mode: "project" }, timeoutMs: 1000 })).rejects.toThrow("Lint configuration changed: base.toml");
        expect(runProcessAsync).not.toHaveBeenCalled();
        expect(readFileSync(join(root, LINT_BASELINE_PATH), "utf8")).toBe(before);
    });
});

describe("literal inheritance field selection", () => {
    it.each([
        '[tool.ruff]\nextend = "base.toml" # comment',
        "[tool.'ruff']\n'extend' = 'base.toml'",
        'tool.ruff.extend = "base.toml"',
        'tool = { ruff = { extend = "base.toml", exclude = ["other.toml"] } }',
        '[tool.ruff]\nextend = """base.toml"""',
    ])("reads Ruff's actual field in %s", content => {
        expect(lintInheritance("ruff", "pyproject.toml", content)).toEqual(["base.toml"]);
    });

    it("ignores comments, multiline descriptions, literal dotted keys and unrelated tables", () => {
        const content = `# extend = "comment.toml"
"tool.ruff.extend" = "quoted-key.toml"
[project]
description = '''
[tool.ruff]
extend = "description.toml"
'''
[tool.ruff]
exclude = ["excluded.toml"]
[[tool.other]]
extend = "other.toml"
`;
        expect(lintInheritance("ruff", "pyproject.toml", content)).toEqual([]);
    });

    it("does not mistake package presets for bare Biome files", () => {
        expect(lintInheritance("biome", "biome.jsonc", '{"extends":["@team/biome", "base.jsonc"],}')).toEqual(["base.jsonc"]);
    });

    it("rejects nonliteral inheritance values", () => {
        expect(() => lintInheritance("oxlint", ".oxlintrc.json", '{"extends":[12]}')).toThrow("literal configuration paths");
        expect(() => lintInheritance("ruff", "ruff.toml", "extend = 42")).toThrow("literal string");
    });
});
