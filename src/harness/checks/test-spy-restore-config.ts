// Bounded, read-only discovery for spy_without_restore. Never import/execute config.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseTsSource } from "./cyclomatic-ast.js";
import { testCallKind, walkTestNodes } from "./test-quality-ast.js";

const CONFIG_NAMES = ["vitest", "jest"].flatMap((runner) => ["ts", "mts", "cts", "js", "mjs", "cjs", "json"].map((ext) => `${runner}.config.${ext}`));

function readText(path: string): string | null {
    try { return readFileSync(path, "utf8"); } catch { return null; }
}

function projectDirectory(filePath: string): string | null {
    if (!isAbsolute(filePath)) return null;
    let directory = dirname(filePath);
    for (let depth = 0; depth < 12; depth++) {
        if (existsSync(join(directory, "package.json"))) return directory;
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    return null;
}

interface RestoreSettings { automatic: boolean; setupFiles: string[]; unresolved: boolean; }

function restoreSettings(content: string): RestoreSettings {
    const result: RestoreSettings = { automatic: false, setupFiles: [], unresolved: false };
    const parsed = parseTsSource(content, "restore-config.ts");
    if (!parsed) return result;
    const { ts, sf } = parsed;
    walkTestNodes(ts, sf, (node) => {
        if (!ts.isPropertyAssignment(node)) return;
        const key = node.name.getText(sf).replace(/["']/g, "");
        if (key === "restoreMocks" && node.initializer.kind === ts.SyntaxKind.TrueKeyword) result.automatic = true;
        if (!["setupFiles", "setupFilesAfterEnv"].includes(key)) return;
        const values = ts.isArrayLiteralExpression(node.initializer) ? node.initializer.elements : [node.initializer];
        for (const value of values) {
            if (ts.isStringLiteralLike(value)) result.setupFiles.push(value.text);
            else result.unresolved = true;
        }
    });
    return result;
}

function setupRestores(content: string): boolean {
    const parsed = parseTsSource(content, "restore-setup.ts");
    if (!parsed) return false;
    const { ts, sf } = parsed;
    let restores = false;
    walkTestNodes(ts, sf, (node) => {
        if (!ts.isCallExpression(node)) return;
        const hook = testCallKind(ts, node.expression);
        if (!hook || !["beforeEach", "afterEach", "afterAll"].includes(hook.root)) return;
        walkTestNodes(ts, node, (child) => {
            if (!ts.isCallExpression(child)) return;
            const kind = testCallKind(ts, child.expression);
            if (kind && ["vi", "jest"].includes(kind.root) && kind.modifiers.includes("restoreAllMocks")) restores = true;
        });
    });
    return restores;
}

function configRestores(content: string, directory: string): boolean {
    const settings = restoreSettings(content);
    if (settings.automatic || settings.unresolved) return true;
    return settings.setupFiles.some((file) => {
        const path = resolve(directory, file.replace(/^<rootDir>\//, ""));
        const setup = readText(path);
        // Unreadable/dynamic setup has no absence verdict: avoid a warning we cannot substantiate.
        return setup === null || setupRestores(setup);
    });
}

/** Whether discovered runner config supplies cleanup, or setup cannot be resolved safely. */
export function projectRestoresSpies(filePath: string): boolean {
    const directory = projectDirectory(filePath);
    if (!directory) return false;
    const packageText = readText(join(directory, "package.json"));
    if (packageText && configRestores(`const packageConfig = ${packageText}`, directory)) return true;
    return CONFIG_NAMES.some((name) => {
        const text = readText(join(directory, name));
        if (text === null) return false;
        return configRestores(name.endsWith(".json") ? `const config = ${text}` : text, directory);
    });
}
