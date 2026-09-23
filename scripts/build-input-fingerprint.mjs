import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const INPUT_DIRECTORIES = ["src", "skills"];
const INPUT_FILES = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "scripts/build-atomic.mjs",
    "scripts/build-atomic-cli.mjs",
    "scripts/build-input-fingerprint.mjs",
    "scripts/build-lease.mjs",
    "scripts/build-publish.mjs",
    "scripts/fix-dist-dts.mjs",
    "scripts/copy-runtime-assets.mjs",
];

function isProductBuildInput(relativePath) {
    const normalized = relativePath.split(sep).join("/");
    if (/(?:^|\/)(?:__tests__|__fixtures__)(?:\/|$)/.test(normalized)) return false;
    return !/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(normalized);
}

function collectFiles(root, current, out) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name);
        const rel = relative(root, absolute);
        if (!isProductBuildInput(rel)) continue;
        if (entry.isSymbolicLink() || lstatSync(absolute).isSymbolicLink()) {
            throw new Error(`Build inputs must not be symbolic links: ${rel}`);
        }
        if (entry.isDirectory()) collectFiles(root, absolute, out);
        else if (entry.isFile()) out.push(rel);
    }
}

function buildInputFiles(root) {
    const files = [];
    for (const directory of INPUT_DIRECTORIES) {
        const absolute = join(root, directory);
        if (existsSync(absolute)) collectFiles(root, absolute, files);
    }
    for (const rel of INPUT_FILES) {
        if (existsSync(join(root, rel))) files.push(rel);
    }
    return [...new Set(files)].sort();
}

/** Public build seam: fingerprint every product source, bundled skill, and build recipe input. */
export function fingerprintBuildInputs(projectRoot, { mode = "standard" } = {}) {
    const root = resolve(projectRoot);
    const hash = createHash("sha256");
    hash.update(`mode:${mode}\0`);
    for (const rel of buildInputFiles(root)) {
        const content = readFileSync(join(root, rel));
        hash.update(rel.split(sep).join("/"));
        hash.update("\0");
        hash.update(String(content.byteLength));
        hash.update("\0");
        hash.update(content);
        hash.update("\0");
    }
    return hash.digest("hex");
}
