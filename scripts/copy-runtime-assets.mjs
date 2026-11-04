import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Runtime assets that must accompany the bundled JS in `dist/`. The OPF
// content-scanner's default config (`harness/rules/default-config.ts`)
// passes `viterbi_calibration_path: HIGH_PRECISION_OPF_CALIBRATION_PATH`
// into the sidecar by default — so the calibration JSON has to ship in
// installed packages too, not just the Python script. Resolver layouts
// covered: `dist/sidecars/<file>` and `dist/sidecars/calibrations/<file>`
// (see `resolveDefaultOpfSidecarScript` / `resolveDefaultOpfCalibrationPath`).
const ASSETS = [
	// Fingerprint analysis runs in a short-lived compiler process from source,
	// the CLI bundle, and the nested daemon bundle.
	{
		from: "scripts/e2e-declaration-inputs.mjs",
		to: "e2e-declaration-inputs.mjs",
	},
	{
		from: "src/harness/content-scanner/sidecars/opf-sidecar.py",
		to: "sidecars/opf-sidecar.py",
	},
	{
		from: "src/harness/content-scanner/sidecars/calibrations/default.json",
		to: "sidecars/calibrations/default.json",
	},
	{
		from: "src/harness/content-scanner/sidecars/calibrations/high_precision.json",
		to: "sidecars/calibrations/high_precision.json",
	},
	// (Skill SKILL.md bodies are bundled dynamically below — every skills/<name>/.)
	// Side-loaded npm popular-packages allowlist — read at runtime by
	// `src/harness/checks/supply-chain.ts` to augment KNOWN_LEGITIMATE_PACKAGES.
	// Refreshable via `scripts/refresh-npm-popular.mjs` without rebuild.
	{
		from: "src/harness/checks/data/npm-popular-packages.json",
		to: "checks/data/npm-popular-packages.json",
	},
	// The viz dashboard — a self-contained HTML asset served by `interlinked viz`
	// at runtime via `resolveVizAsset` (which probes `dist/viz/index.html`).
	{
		from: "src/lib/viz/web/index.html",
		to: "viz/index.html",
	},
	// Live mutation-run lens (one row per measurement; SSE /api/mutation-runs).
	{
		from: "src/lib/viz/web/mutation-runs.html",
		to: "viz/mutation-runs.html",
	},
];

/** Explicit non-module inputs shared with the build fingerprint's runtime-state exclusion. */
export function runtimeAssetInputs() {
    return ASSETS.map((asset) => asset.from);
}

function copyDirectory(sourceRoot, destinationRoot) {
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
        const source = join(sourceRoot, entry.name);
        const destination = join(destinationRoot, entry.name);
        if (entry.isSymbolicLink() || lstatSync(source).isSymbolicLink()) {
            throw new Error(`Runtime skill resources must not be symlinks: ${source}`);
        }
        if (entry.isDirectory()) {
            mkdirSync(destination, { recursive: true });
            copyDirectory(source, destination);
        } else if (entry.isFile()) {
            mkdirSync(dirname(destination), { recursive: true });
            copyFileSync(source, destination);
        }
    }
}

export function copyRuntimeAssets(
    outputDirectory = join(process.cwd(), "dist"),
    sourceRoot = process.cwd(),
) {
    const outputRoot = resolve(outputDirectory);
    // Research freezes retain the exact relation implementation used by published CLIs.
    copyRelationSources(sourceRoot, outputRoot);
    for (const asset of ASSETS) {
        const src = join(sourceRoot, asset.from);
        const dest = join(outputRoot, asset.to);
        if (!existsSync(src)) {
            throw new Error(`Runtime asset missing: ${asset.from}`);
        }
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
    }

    // Bundle every complete skill directory so optional agents metadata, scripts,
    // references, and assets remain available in published installs.
    const skillsRoot = join(sourceRoot, "skills");
    if (!existsSync(skillsRoot)) return;
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = join(skillsRoot, entry.name);
        if (!existsSync(join(source, "SKILL.md"))) continue;
        copyDirectory(source, join(outputRoot, "skills", entry.name));
    }
}

function copyRelationSources(sourceRoot, outputRoot) {
    const copiedRelationSources = new Set();
    const copyRelationSource = (source) => {
        const relativePath = relative(sourceRoot, source);
        if (relativePath.startsWith("..") || copiedRelationSources.has(source) || !existsSync(source) || !statSync(source).isFile()) return;
        copiedRelationSources.add(source);
        const destination = join(outputRoot, "relation-source", relativePath);
        mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
        const content = readFileSync(source, "utf8");
        for (const match of content.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)) {
            const base = resolve(dirname(source), match[1]).replace(/\.js$/, ".ts");
            const dependency = [base, `${base}.ts`, join(base, "index.ts")].find(p => existsSync(p) && statSync(p).isFile());
            if (dependency) copyRelationSource(dependency);
        }
    };
    for (const relativePath of ["harness/semantic-graph", "lib/decision-metrics"]) {
        const source = join(sourceRoot, "src", relativePath);
        if (existsSync(source)) for (const name of readdirSync(source)) if (name.endsWith(".ts") && !name.includes(".test.")) copyRelationSource(join(source, name));
    }
    for (const relativePath of ["commands/metrics-relations.ts", "registrars/metrics-relations.ts"]) {
        const source = join(sourceRoot, "src", relativePath);
        if (existsSync(source)) {
            copyRelationSource(source);
        }
    }
    for (const name of ["package.json", "package-lock.json"]) if (existsSync(join(sourceRoot, name))) copyRelationSource(join(sourceRoot, name));
}
