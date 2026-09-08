// ===========================================
// interlinked init — One-command onboarding
// ===========================================
// Combines auto-detection, setup, login, and verification into
// a single streamlined flow for both humans and agents.
//
// What it does:
// 1. Auto-detect installed AI clients (Claude Code, Gemini CLI, Codex)
// 2. Auto-detect git remote → suggest workspace name
// 3. Install hooks for all detected clients
// 4. Login (interactive OAuth or env token)
// 5. Attach to workspace and register agent
// 6. Health check + send introduction message
// 7. Print summary: "Connected to X as Y. N agents online."

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolveAuthToken } from "../lib/auth.js";
import { initConfig, type LocalConfig, updateLocalConfig } from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { isJsonObject } from "../lib/json-types.js";
import {
	findProjectRoot,
	HOOK_SCRIPT_VERSION,
	installAllHooks,
	writeHookScript,
} from "../lib/hooks.js";
import { nonNull } from "../lib/non-null.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import { type ClientName, detectClients } from "../lib/settings.js";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";
import {
	emitDryRun,
	isLocalServer,
	type OnboardingResult,
	printBanner,
	printCompletion,
	printDetectedClients,
	printProjectContext,
	printServer,
} from "./init-presentation.js";
import { loginCommand } from "./login.js";

// No hardcoded production default — the public distribution has no server
// to point at. Users supply one via `--server`, and the probe/local
// defaults fall through to localhost.
const DEFAULT_REMOTE_SERVER = "http://localhost:8787";
const DEFAULT_LOCAL_SERVER = "http://localhost:8787";

/** Default timeout when probing whether the configured server is reachable during init. */
const SERVER_REACHABLE_TIMEOUT_MS = 2000;

interface InitOptions {
	server?: string;
	agent?: string;
	"sync-mode"?: string;
	"dry-run"?: boolean;
	json?: boolean;
	yes?: boolean;
}

function isInteractiveTty(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function isServerReachable(
	serverUrl: string,
	timeoutMs: number = SERVER_REACHABLE_TIMEOUT_MS,
): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${serverUrl}/health`, { signal: controller.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Derive a workspace/project name from git remote URL.
 * e.g., "git@github.com:user/my-project.git" → "my-project"
 */
function deriveProjectFromGit(cwd: string): string | null {
	const projectRoot = findProjectRoot(cwd);
	if (!projectRoot) return null;

	// Try git remote URL first
	const gitConfigPath = join(projectRoot, ".git", "config");
	if (existsSync(gitConfigPath)) {
		try {
			const content = readFileSync(gitConfigPath, "utf-8");
			const urlMatch = content.match(/url\s*=\s*(.+)/);
			if (urlMatch) {
				const url = nonNull(urlMatch[1]).trim();
				// Extract repo name from URL
				const repoMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
				if (repoMatch) return nonNull(repoMatch[1]);
			}
		} catch (_) {
			/* intentional: unable to parse git config, fall through to directory name */
		}
	}

	// Fallback: directory name
	return basename(projectRoot);
}

/**
 * Suggest an agent name based on environment and client.
 */
function suggestAgentName(detectedClients: ClientName[]): string {
	const envName = process.env.INTERLINKED_AGENT_NAME || process.env.INTERLINKED_AGENT;
	if (envName) return envName;

	const user = process.env.USER || process.env.USERNAME || "agent";
	const client = detectedClients[0] || "cli";
	return `${user}-${client}`;
}

type HarnessStatus = ReturnType<typeof isHarnessRunning>;

/** Step 3: resolve the target server URL (flag → env → reachability probe). */
async function resolveServerUrl(options: InitOptions): Promise<string> {
	const explicit = options.server || process.env.INTERLINKED_SERVER_URL;
	if (explicit) return explicit;
	const localHealthy = await isServerReachable(DEFAULT_LOCAL_SERVER);
	return localHealthy ? DEFAULT_LOCAL_SERVER : DEFAULT_REMOTE_SERVER;
}
/** Step 4: resolve the agent name, prompting interactively when appropriate. */
async function resolveAgentName(
	options: InitOptions,
	detectedNames: ClientName[],
	autoConfirm: boolean,
	isJson: boolean,
): Promise<string> {
	let agentName = options.agent || suggestAgentName(detectedNames);

	if (isInteractiveTty() && !autoConfirm && !options.agent) {
		const rl = createInterface({ input, output });
		try {
			const answer = await rl.question(`${c.bold("4.")} Agent name [${agentName}]: `);
			if (answer.trim()) agentName = answer.trim();
		} finally {
			rl.close();
		}
	} else if (!isJson) {
		console.log(`${c.bold("4.")} Agent name: ${c.cyan(agentName)}`);
	}

	if (!isJson) console.log("");
	return agentName;
}

/** Step 5: write config + hook script and install hooks for detected clients. */
function parseSyncMode(value: string): NonNullable<LocalConfig["sync_mode"]> {
	if (value === "realtime" || value === "local" || value === "manual") return value;
	throw new Error(`Invalid --sync-mode: ${value}. Expected realtime, local, or manual.`);
}

function installConfigAndHooks(
	cwd: string,
	serverUrl: string,
	agentName: string,
	syncMode: NonNullable<LocalConfig["sync_mode"]>,
	detectedNames: ClientName[],
	isJson: boolean,
): void {
	if (!isJson) {
		console.log(`${c.bold("5.")} Installing...`);
	}

	initConfig({ serverUrl, agentName }, cwd);
	updateLocalConfig({ sync_mode: syncMode }, cwd);

	if (!isJson) {
		console.log(`   ${c.green("✓")} Config written to .interlinked/`);
	}

	// Write the generated .mjs — kept as the unbuilt-source-checkout binary
	// fallback; the canonical hook binary is resolved inside installAllHooks.
	writeHookScript(cwd);
	if (!isJson) {
		console.log(`   ${c.green("✓")} Hook script v${HOOK_SCRIPT_VERSION}`);
	}

	if (detectedNames.length > 0) {
		const results = installAllHooks(cwd, detectedNames);
		for (const r of results) {
			if (r.installed && !isJson) {
				console.log(`   ${c.green("✓")} ${r.client} hooks (${r.events.length} events)`);
			} else if (r.error && !isJson) {
				console.log(`   ${c.yellow("!")} ${r.client}: ${r.error}`);
			}
		}
	}
	if (!isJson) console.log("");
}

/** Step 6: authenticate against a remote server when not already authed. */
async function authenticate(serverUrl: string, isJson: boolean): Promise<void> {
	const hasAuth = !!resolveAuthToken();
	const envToken = process.env.INTERLINKED_TOKEN || process.env.INTERLINKED_ACCESS_TOKEN;

	if (!hasAuth && !isLocalServer(serverUrl)) {
		if (!isJson) {
			console.log(`${c.bold("6.")} Authenticating...`);
		}
		if (envToken) {
			await loginCommand({ server: serverUrl, token: envToken });
		} else if (isInteractiveTty()) {
			await loginCommand({ server: serverUrl });
		} else if (!isJson) {
			console.log(
				`   ${c.yellow("Skipped")} — no TTY. Set INTERLINKED_TOKEN or run: interlinked login`,
			);
		}
	} else if (!isJson) {
		console.log(`${c.bold("6.")} Auth: ${c.green("already authenticated")}`);
	}
	if (!isJson) console.log("");
}

/** Step 7: register the agent on the server and report the outcome. */
async function runOnboarding(
	serverUrl: string,
	agentName: string,
	isJson: boolean,
): Promise<OnboardingResult> {
	if (!isJson) {
		console.log(`${c.bold("7.")} Connecting to workspace...`);
	}

	const onboarding = await ensureRemoteOnboarding({ serverUrl });
	if (isJson) return onboarding;

	if (onboarding.status === "linked") {
		const tag = onboarding.isNewAgent ? "registered" : "reconnected";
		console.log(`   ${c.green("✓")} Agent ${c.cyan(onboarding.agentName || agentName)} ${tag}`);
		if (onboarding.workspaceName) {
			console.log(`   ${c.dim(`Workspace: ${onboarding.workspaceName}`)}`);
		}
	} else if (onboarding.status === "skipped") {
		console.log(`   ${c.dim(`Remote onboarding skipped: ${onboarding.reason || "unknown"}`)}`);
	} else {
		console.log(`   ${c.yellow("!")} Remote onboarding: ${onboarding.error || "failed"}`);
	}
	return onboarding;
}

/** Step 9: best-effort health check returning reachability + online-agent count. */
async function checkServerHealth(
	serverUrl: string,
): Promise<{ serverReachable: boolean; onlineAgents: number }> {
	try {
		const { InterlinkedClient } = await import("../lib/api-client.js");
		const token = resolveAuthToken();
		const client = new InterlinkedClient({
			serverUrl,
			...(token ? { token } : {}),
		});
		await client.callTool("health_check");

		let onlineAgents = 0;
		try {
			const result = await client.callTool(
				"list_online_agents",
				{ threshold_minutes: 5 },
			);
			if (isJsonObject(result) && Array.isArray(result.agents) && result.agents.every((agent) => isJsonObject(agent) && typeof agent.name === "string")) {
				onlineAgents = result.agents.length;
			}
		} catch (_) {
			/* intentional: list_online_agents is best-effort during init */
		}
		return { serverReachable: true, onlineAgents };
	} catch (_) {
		/* intentional: init-time workspace check is best-effort, proceed without context */
		return { serverReachable: false, onlineAgents: 0 };
	}
}

/** Resolve whether to start the harness, prompting on an interactive TTY. */
async function shouldStartHarness(autoConfirm: boolean): Promise<boolean> {
	if (autoConfirm) return true;
	if (!isInteractiveTty()) return false;
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question("   Start harness server for guard evaluation? [Y/n] ");
		return !answer.trim() || answer.trim().toLowerCase() !== "n";
	} finally {
		rl.close();
	}
}

/** Start the harness daemon and report the post-start status. */
async function startHarness(cwd: string, isJson: boolean): Promise<boolean> {
	const harnessInitOpts = { daemon: true, json: true };
	await harnessStartCommand(harnessInitOpts);
	const afterStart = isHarnessRunning(cwd);
	if (!isJson) {
		if (afterStart.running) {
			console.log(`   ${c.green("✓")} Harness started (PID ${afterStart.pid})`);
		} else {
			console.log(
				`   ${c.yellow("!")} Failed to start harness. Run: interlinked harness start --verbose`,
			);
		}
	}
	return afterStart.running;
}

/** Step 8: ensure the harness is running, returning whether it ended up started. */
async function setupHarness(
	cwd: string,
	harnessStatus: HarnessStatus,
	autoConfirm: boolean,
	isJson: boolean,
): Promise<boolean> {
	if (!isJson) {
		console.log("");
		console.log(`${c.bold("8.")} Harness setup...`);
	}

	if (harnessStatus.running) {
		if (!isJson) {
			console.log(`   ${c.green("✓")} Harness already running (PID ${harnessStatus.pid})`);
		}
		return true;
	}

	const start = await shouldStartHarness(autoConfirm);
	if (start) return startHarness(cwd, isJson);

	if (!isJson) {
		console.log(`   ${c.dim("Skipped — start later with: interlinked harness start")}`);
	}
	return false;
}

export async function initCommand(options: InitOptions): Promise<void> {
	const cwd = process.cwd();
	const dryRun = options["dry-run"] || false;
	const isJson = options.json || false;
	const autoConfirm = options.yes || !isInteractiveTty();

	printBanner(isJson);

	// Step 1: Auto-detect clients
	const detectedClients = detectClients(cwd).filter((client) => client.exists);
	const detectedNames = detectedClients.map((client) => client.name);
	printDetectedClients(detectedClients, isJson);

	// Step 2: Detect git context
	const projectName = deriveProjectFromGit(cwd);
	const projectRoot = findProjectRoot(cwd);
	printProjectContext(projectName, projectRoot, isJson);

	// Step 3: Determine server
	const serverUrl = await resolveServerUrl(options);
	printServer(serverUrl, isJson);

	// Step 4: Agent name
	const agentName = await resolveAgentName(options, detectedNames, autoConfirm, isJson);

	// Step 5: Sync mode
	const syncMode = parseSyncMode(options["sync-mode"] || "realtime");

	if (dryRun) {
		emitDryRun(serverUrl, agentName, projectName, syncMode, detectedNames, isJson);
		return;
	}

	// Step 6: Install hooks and config
	installConfigAndHooks(cwd, serverUrl, agentName, syncMode, detectedNames, isJson);

	// Step 7: Authentication
	await authenticate(serverUrl, isJson);

	// Step 8: Remote onboarding (register agent on server)
	const onboarding = await runOnboarding(serverUrl, agentName, isJson);

	// Step 9: Verification — health check
	const { serverReachable, onlineAgents } = await checkServerHealth(serverUrl);

	// Step 10: Harness setup
	const harnessStatus = isHarnessRunning(cwd);
	const harnessStarted = await setupHarness(cwd, harnessStatus, autoConfirm, isJson);

	// Final summary / completion payload
	printCompletion(
		serverUrl,
		agentName,
		projectName,
		syncMode,
		detectedNames,
		serverReachable,
		onlineAgents,
		onboarding,
		harnessStarted,
		isJson,
	);
}
