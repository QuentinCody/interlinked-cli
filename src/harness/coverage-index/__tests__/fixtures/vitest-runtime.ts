import { constants, cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

interface PackageManifest {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
}

function packageDirectory(name: string, from: string): string | undefined {
    const requireFromPackage = createRequire(join(from, "package.json"));
    for (const directory of requireFromPackage.resolve.paths(name) ?? []) {
        const candidate = join(directory, name);
        if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    return undefined;
}

function installedDependencies(source: string): string[] {
    // SAFETY: npm-installed package manifests supply string-keyed dependency maps.
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as PackageManifest;
    const required = Object.keys(manifest.dependencies ?? {});
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    const names = new Set([...required, ...optional, ...Object.keys(manifest.peerDependencies ?? {})]);
    return [...names].flatMap(name => {
        const dependency = packageDirectory(name, source);
        if (dependency) return [dependency];
        if (required.includes(name) && !optional.has(name)) throw new Error(`Missing ${name} required by ${source}`);
        return [];
    });
}

/** Copy real runner packages, preserving nested versions and installed optional/peer dependencies. */
export function copyVitestRuntime(root: string): void {
    const sourceRoot = realpathSync(join(process.cwd(), "node_modules"));
    const pending = ["vitest", "@vitest/coverage-v8"].map(name => {
        const source = packageDirectory(name, process.cwd());
        if (!source) throw new Error(`Missing fixture runner package: ${name}`);
        return source;
    });
    const copied = new Set<string>();
    for (let source = pending.pop(); source !== undefined; source = pending.pop()) {
        if (copied.has(source)) continue;
        copied.add(source);
        const path = relative(sourceRoot, source);
        if (isAbsolute(path) || path.startsWith("..")) throw new Error(`External fixture dependency: ${source}`);
        const target = join(root, "node_modules", path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
            filter: entry => basename(entry) !== ".vite-temp" && basename(entry) !== ".vite" });
        pending.push(...installedDependencies(source));
    }
}
