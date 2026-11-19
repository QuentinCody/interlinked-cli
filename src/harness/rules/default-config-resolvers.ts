// interlinked-tdd: exempt
// ===========================================
// Rules — Default Config: path resolvers + protected-file data
// ===========================================
// Leaf helpers carved out of `default-config.ts` to keep the main config
// module under the line cap: the OPF sidecar / calibration path resolvers,
// their derived absolute-path constants, the error-memory expiry constant,
// and the built-in protected-file glob catalog. Pure data + filesystem
// probing; no module-private state from the parent file.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nonNull } from "../../lib/non-null.js";
import type { ProtectedFileRule } from "../types.js";

/** Seconds in a week — used for the default error-memory expiry. */
export const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;

/** Resolve the OPF Python sidecar path across three deployment layouts:
 *    (1) dev (tsx):          src/harness/rules/default-config.ts  →  ../content-scanner/sidecars/opf-sidecar.py
 *    (2) prod-from-source:   dist/chunk-XYZ.js                     →  ../src/harness/content-scanner/sidecars/opf-sidecar.py
 *    (3) bundled server:     dist/harness/server.js                →  ../sidecars/opf-sidecar.py
 *    (4) bundled chunk:      dist/chunk-XYZ.js                     →  ./sidecars/opf-sidecar.py
 *  First existing candidate wins; if none exist we return the source-tree
 *  default so the error message points at the expected dev location. */
function resolveDefaultOpfSidecarScript(): string {
	const candidates = [
		new URL("../content-scanner/sidecars/opf-sidecar.py", import.meta.url),
		new URL("../src/harness/content-scanner/sidecars/opf-sidecar.py", import.meta.url),
		new URL("../sidecars/opf-sidecar.py", import.meta.url),
		new URL("./sidecars/opf-sidecar.py", import.meta.url),
		new URL("./opf-sidecar.py", import.meta.url),
	];
	for (const url of candidates) {
		const candidatePath = fileURLToPath(url);
		if (existsSync(candidatePath)) return candidatePath;
	}
	return fileURLToPath(nonNull(candidates[0]));
}

/** Resolve a shipped Viterbi calibration preset by filename across the same
 *  four deployment layouts as the sidecar script. Internal — only consumed by
 *  HIGH_PRECISION_OPF_CALIBRATION_PATH below. Promote to an export if/when
 *  external code (custom-preset bundles, programmatic config builders) needs
 *  to resolve installed presets without hard-coding deployment paths. */
function resolveDefaultOpfCalibrationPath(presetFileName: string): string {
	const candidates = [
		new URL(`../content-scanner/sidecars/calibrations/${presetFileName}`, import.meta.url),
		new URL(
			`../src/harness/content-scanner/sidecars/calibrations/${presetFileName}`,
			import.meta.url,
		),
		new URL(`../sidecars/calibrations/${presetFileName}`, import.meta.url),
		new URL(`./sidecars/calibrations/${presetFileName}`, import.meta.url),
		new URL(`./calibrations/${presetFileName}`, import.meta.url),
	];
	for (const url of candidates) {
		const candidatePath = fileURLToPath(url);
		if (existsSync(candidatePath)) return candidatePath;
	}
	return fileURLToPath(nonNull(candidates[0]));
}

export const DEFAULT_OPF_SIDECAR_SCRIPT = resolveDefaultOpfSidecarScript();

/** Absolute path to the shipped precision-leaning calibration preset. Used
 *  by DEFAULT_CONFIG.content_scanner.local below as the out-of-the-box
 *  `viterbi_calibration_path`. Will be re-exported once the calibration
 *  shape test (content-scanner/__tests__/calibration.test.ts) imports it. */
export const HIGH_PRECISION_OPF_CALIBRATION_PATH =
	resolveDefaultOpfCalibrationPath("high_precision.json");

/** Built-in protected-file glob catalog consumed by DEFAULT_CONFIG. */
export const DEFAULT_PROTECTED_FILES: ProtectedFileRule[] = [
	{
		// Kill-proof receipts are evidence a gated agent is judged against; only
		// `interlinked tests prove-kill` writes them (kill-proof review L2: a receipt
		// rewritten with a recomputed digest passes every reader). Edit tools are
		// refused here; shell writes are the harness's redirect/tee guards' job.
		glob: "**/.interlinked/test-runs/kill-proofs/**",
		operations: ["Write", "Edit", "Delete"],
		reason: "Kill-proof receipts are executed evidence; only `interlinked tests prove-kill` writes them",
	},
	{
		glob: "**/*.env*",
		operations: ["Write", "Edit"],
		check: "secrets",
		reason: "Environment files may contain secrets",
	},
	{
		glob: "**/*.pem",
		operations: ["Write", "Edit", "Read"],
		reason: "Private key files should not be accessed by agents",
	},
	{
		glob: "**/*.key",
		operations: ["Write", "Edit", "Read"],
		reason: "Private key files should not be accessed by agents",
	},
	{
		glob: ".github/workflows/**",
		operations: ["Delete"],
		reason: "CI/CD config deletion breaks pipelines",
	},
	{
		glob: "**/.gitlab-ci.yml",
		operations: ["Delete"],
		reason: "CI/CD config deletion breaks pipelines",
	},
	{
		glob: "**/.circleci/**",
		operations: ["Delete"],
		reason: "CI/CD config deletion breaks pipelines",
	},
	{
		glob: "**/Jenkinsfile",
		operations: ["Delete"],
		reason: "CI/CD config deletion breaks pipelines",
	},
	{
		glob: "**/.travis.yml",
		operations: ["Delete"],
		reason: "CI/CD config deletion breaks pipelines",
	},
	{
		glob: "**/.buildkite/**",
		operations: ["Delete"],
		reason: "CI/CD config deletion breaks pipelines",
	},
	{
		glob: "**/bitbucket-pipelines.yml",
		operations: ["Delete"],
		reason: "CI/CD config deletion breaks pipelines",
	},
	{
		glob: "**/migrations/**",
		operations: ["Delete"],
		reason: "Migration file deletion corrupts migration history",
	},
	// Security config files
	{
		glob: "**/.gitignore",
		operations: ["Delete"],
		reason: "Deleting .gitignore can cause secrets and build artifacts to be committed",
	},
	{
		glob: "**/CODEOWNERS",
		operations: ["Delete"],
		reason: "CODEOWNERS deletion breaks review enforcement",
	},
	{
		glob: "**/.pre-commit-config.yaml",
		operations: ["Delete"],
		reason: "Pre-commit config deletion disables safety hooks",
	},
	// Lock files — protect from deletion (Write/Edit blocked by builtin-lockfile-tamper rule)
	{
		glob: "**/package-lock.json",
		operations: ["Delete"],
		reason: "Lock file deletion breaks deterministic builds",
	},
	{
		glob: "**/yarn.lock",
		operations: ["Delete"],
		reason: "Lock file deletion breaks deterministic builds",
	},
	{
		glob: "**/pnpm-lock.yaml",
		operations: ["Delete"],
		reason: "Lock file deletion breaks deterministic builds",
	},
	{
		glob: "**/Cargo.lock",
		operations: ["Delete"],
		reason: "Lock file deletion breaks deterministic builds",
	},
	{
		glob: "**/poetry.lock",
		operations: ["Delete"],
		reason: "Lock file deletion breaks deterministic builds",
	},
	{
		glob: "**/go.sum",
		operations: ["Delete"],
		reason: "Lock file deletion breaks deterministic builds",
	},
	// Dockerfile and docker-compose
	{
		glob: "**/Dockerfile",
		operations: ["Delete"],
		reason: "Dockerfile deletion breaks container builds and deployments",
	},
	{
		glob: "**/docker-compose*.yml",
		operations: ["Delete"],
		reason: "Docker Compose deletion breaks container orchestration",
	},
	// Content scanner LOCAL-ONLY artifacts. The whole point of
	// .interlinked/scanner/pending/ is that the raw flagged content
	// stays out of the agent's context window — if the agent can Read
	// or Edit those JSON files, the systemMessage / redacted-reason
	// design collapses. Mode 0600 only blocks OTHER users on the
	// system; the agent runs as the file owner, so the rule layer
	// has to enforce the boundary. Same logic for the audit log,
	// which records who toggled the filter off and when.
	{
		glob: ".interlinked/scanner/pending/**",
		operations: ["Read", "Write", "Edit", "Delete"],
		reason: "Pending content-scanner files contain raw flagged PII that must NOT enter the agent's context window. Mode 0600 only blocks other users; this rule blocks the agent itself. Open the file in a separate terminal/editor if you need to review.",
	},
	{
		glob: ".interlinked/content-scanner.audit.jsonl",
		operations: ["Read", "Write", "Edit", "Delete"],
		reason: "Content-scanner audit log records every toggle with actor + reason. Treat as audit data, not as program input — agents reading this could rationalize toggling the filter off in subsequent turns.",
	},
];
