// ===========================================
// RunnerAdapter contract
// ===========================================
// Every supported coding-agent CLI (Claude Code, Copilot CLI, Cursor, Gemini
// CLI, Codex, OpenCode, and Pi) provides an implementation of this interface. The adapter's job
// is to normalize native hook events into a UnifiedHookEvent and translate
// HarnessDecision back into the runner's expected stdout/stderr/exit-code
// format. See docs/design/cli-hook-normalization.md §"Per-runner adapters".

import type { HarnessDecision } from "../types.js";
import type {
	RunnerId,
	ToolClass,
	UnifiedHookEvent,
	UnifiedPhase,
} from "../unified-event.js";

export type MergeStrategy = "deep-merge" | "array-append" | "replace-key";

export interface SettingsFragment {
	/** Settings file path relative to the user's home or the project root.
	 *  `user`-scope paths start with `~/`; project-scope paths are relative. */
	path: string;
	/** The JSON/YAML/etc. fragment to merge into the target. */
	fragment: unknown;
	/** How to merge. `array-append` is essential for hook arrays so we never
	 *  clobber user-owned entries. */
	mergeStrategy: MergeStrategy;
	/** Exact provider-owned plugin/extension source. When present, installers
	 *  manage this file as a whole instead of treating `fragment` as JSON. */
	fileContent?: string;
}

export interface AdapterOutput {
	/** What the adapter writes to stdout. Format is runner-specific. */
	stdout?: string | undefined;
	/** What the adapter writes to stderr. `warnings[]` always land here. */
	stderr?: string | undefined;
	/** Process exit code the adapter requests (0 = allow, 2 = deny on most runners). */
	exit_code: number;
}

/** What a native hook event can do on its provider. */
export type NativeDecisionControl =
	| "observe"
	| "deny"
	| "ask"
	| "permission"
	| "replace"
	| "continue";

export interface NativeHookEventCapability {
	name: string;
	phase: UnifiedPhase;
	/** False for events an adapter can parse but deliberately does not install. */
	install: boolean;
	control: NativeDecisionControl;
	/** Whether non-blocking feedback can be delivered to the model. */
	model_context: boolean;
	/** Whether the provider should launch this observational hook in the background. */
	background?: boolean;
	missing_runtime: "fail_closed" | "warn_open";
}

/** Provider semantics shared by normalization, installation, diagnostics, and
 * conformance tests. Provider-specific settings syntax stays in the adapter. */
export interface RunnerCapabilities {
	events: readonly NativeHookEventCapability[];
	/** Project-relative native hook definition used by installers and runtime
	 * receipt verification. */
	project_hook_path: string;
	hook_trust: "implicit" | "definition-review" | "provider-managed";
	status_line: "custom-command" | "built-in-only" | "none";
}

export interface InstallerManifestEntry {
	runner: RunnerId;
	scope: "user" | "project" | "local";
	settings_path: string;
	/** JSON-pointer paths that the installer wrote (for precise uninstall). */
	added_paths: string[];
	/** Binary path or script path referenced from the hook entry. */
	binary_path: string;
	/** How the installed artifact is owned and verified. Older manifests omit
	 *  this and are interpreted as JSON settings entries. */
	artifact_kind?: "json-settings" | "managed-file";
	/** SHA-256 of an exact managed file, used to detect user edits safely. */
	artifact_sha256?: string;
	/** ISO timestamp of install. */
	installed_at: string;
	/** Did the adapter's out-of-band `postInstall` side-effects complete?
	 *
	 *  An adapter only declares `postInstall` when the JSON fragment alone
	 *  leaves the install INERT — Codex ignores its hooks.json entirely until
	 *  `[features] hooks = true` is in `.codex/config.toml`. So a failure here
	 *  is not cosmetic, and it used to be swallowed: the installer wrote one
	 *  stderr line and still recorded `ok: true`, producing a successful
	 *  manifest for an installation that fires no hooks. A first-time failure
	 *  is recorded so uninstall can remove its partial fragment; a failed
	 *  replacement restores and retains the prior working manifest entry.
	 *
	 *  Manifests written before this field existed have no value; the reader
	 *  coerces those to `"ok"`. */
	post_install: "ok" | "failed";
	/** Why `postInstall` failed. Present only when `post_install` is `"failed"`. */
	post_install_error?: string;
	/** Schema version of the manifest record. */
	schema_version: "1";
}

export interface RunnerAdapter {
	readonly id: RunnerId;

	/** Human-friendly label ("Claude Code", "GitHub Copilot CLI"). */
	readonly label: string;

	/** When true we may flag this adapter as experimental in the installer UI. */
	readonly experimental?: boolean;
	readonly capabilities: RunnerCapabilities;

	/** Heuristic detection. True if the current process environment suggests
	 *  this adapter is the caller. Used by install-hooks when the user passes
	 *  no explicit `--runner`. Must be a fast, side-effect-free check. */
	detectFromEnv(env: NodeJS.ProcessEnv): boolean;

	/** Native hook event names this adapter knows how to parse. Used to
	 *  validate installation fragments and to classify incoming payloads. */
	readonly nativeEventNames: readonly string[];

	/** Translate a native hook-input JSON payload + event name into a unified
	 *  event. Must be tolerant of unknown fields — runners evolve their
	 *  payload shapes and we must not crash on new keys. */
	parseHookInput(nativeJson: unknown, nativeEventName: string): UnifiedHookEvent;

	/** Classify a tool call into a ToolClass. Runs after parseHookInput so the
	 *  adapter can inject runner-specific heuristics (e.g. Claude's
	 *  `MultiEdit` → modify). Falls back to the shared command classifier. */
	classifyToolClass(toolName: string, toolInput: unknown): ToolClass;

	/** Produce a settings-file fragment for the installer. Must be merge-safe;
	 *  `array-append` merge on hook arrays is mandatory. The returned
	 *  `added_paths` list is used to construct the installer manifest. */
	renderSettingsFragment(
		binaryPath: string,
		scope: "user" | "project" | "local",
	): SettingsFragment;

	/** Translate a canonical HarnessDecision into the runner-specific output
	 *  (stdout JSON / stderr / exit code). Adapters are responsible for
	 *  mapping the internal "block" value to the runner's native keyword
	 *  (Claude: "deny"; Copilot: exit code 2; etc.). */
	encodeDecision(decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput;

	/** Optional side-effects to run after the JSON settings fragment has been
	 *  merged into the target file. Used by runners that need additional
	 *  out-of-band configuration the JSON merger can't express — e.g. Codex
	 *  CLI requires `[features] hooks = true` in `.codex/config.toml`
	 *  (legacy `codex_hooks` auto-migrated by the writer)
	 *  before any hooks.json is honored. The installer calls this after
	 *  writing the JSON fragment, with the resolved scope and the dryRun
	 *  flag so adapters can no-op or trace under `--dry-run`. */
	postInstall?(opts: PostInstallOptions): void;

	/** Optional cleanup after the JSON fragment has been unmerged. OpenCode v2
	 *  writes a JS plugin file the JSON merger cannot own. */
	postUninstall?(opts: PostInstallOptions): void;
}

export interface PostInstallOptions {
	/** Repo root for project/local scope; user home for user scope. */
	cwd: string;
	/** Scope the install ran under. Adapters typically only care about this
	 *  to decide which directory layer to write to (project vs user). */
	scope: "user" | "project" | "local";
	/** When true, adapters must not write files — only log what they would do. */
	dryRun: boolean;
}
