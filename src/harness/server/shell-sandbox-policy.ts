// ===========================================
// Shell sandbox evidence advisory
// ===========================================
// Native agent sandboxes reduce blast radius, but a workspace-write sandbox
// still writes the real repository. This check therefore records sandbox state
// as defense-in-depth evidence; it never substitutes for effect-based gates.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonObject } from "../../lib/json-file.js";
import { isJsonObject } from "../../lib/json-types.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { isBash } from "../evaluator/tool-classifiers.js";

const NOTICE_KEY = "shell-sandbox-evidence";

interface SandboxAssessment {
	evidence: NonNullable<HarnessEvent["sandbox_evidence"]>;
	detail: string;
}

function nestedObject(value: unknown): Record<string, unknown> | null {
	return isJsonObject(value) ? value : null;
}

function explicitCallAssessment(event: HarnessEvent): SandboxAssessment | null {
	const input = event.tool_input;
	if (!input) return null;
	if (input.dangerouslyDisableSandbox === true || input.sandbox_permissions === "require_escalated") {
		return { evidence: "disabled", detail: "this call explicitly requested unsandboxed/escalated execution" };
	}
	if (input.sandboxed === true) {
		return { evidence: "attested", detail: "the runner marked this call sandboxed" };
	}
	if (input.sandboxed === false) {
		return { evidence: "disabled", detail: "the runner marked this call unsandboxed" };
	}
	const mode = input.sandbox_mode;
	if (mode === "read-only" || mode === "workspace-write") {
		return { evidence: "attested", detail: `the runner reported sandbox_mode=${mode}` };
	}
	if (mode === "danger-full-access") {
		return { evidence: "disabled", detail: "the runner reported danger-full-access" };
	}
	return null;
}

function claudeAssessment(root: string): SandboxAssessment {
	const candidates = [
		join(root, ".claude", "settings.local.json"),
		join(root, ".claude", "settings.json"),
		join(homedir(), ".claude", "settings.json"),
	];
	for (const path of candidates) {
		const sandbox = nestedObject(readJsonObject(path)?.sandbox);
		if (!sandbox || typeof sandbox.enabled !== "boolean") continue;
		if (sandbox.enabled !== true) {
			return { evidence: "disabled", detail: `${path} sets sandbox.enabled=false` };
		}
		const gaps: string[] = [];
		if (sandbox.failIfUnavailable !== true) gaps.push("failIfUnavailable is not true");
		if (sandbox.allowUnsandboxedCommands !== false) gaps.push("the unsandboxed escape hatch remains enabled");
		if (Array.isArray(sandbox.excludedCommands) && sandbox.excludedCommands.length > 0) {
			gaps.push(`${sandbox.excludedCommands.length} command exclusion(s) run outside the sandbox`);
		}
		return {
			evidence: "configured",
			detail: gaps.length > 0 ? `sandbox is configured, but ${gaps.join("; ")}` : "strict sandbox configuration found",
		};
	}
	return { evidence: "unknown", detail: "no enabled Claude sandbox setting was found" };
}

function codexModeFrom(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		const lines = readFileSync(path, "utf8").replace(/#[^\n]*/g, "").split("\n");
		for (const line of lines) {
			if (/^\s*\[/.test(line)) break;
			const mode = line.match(/^\s*sandbox_mode\s*=\s*["']([^"']+)["']/)?.[1];
			if (mode) return mode;
		}
		return null;
	} catch {
		return null;
	}
}

function codexAssessment(root: string): SandboxAssessment {
	const projectMode = codexModeFrom(join(root, ".codex", "config.toml"));
	const userMode = codexModeFrom(join(homedir(), ".codex", "config.toml"));
	const mode = projectMode ?? userMode;
	if (mode === "read-only" || mode === "workspace-write") {
		return {
			evidence: "configured",
			detail: `sandbox_mode=${mode} is configured; CLI/profile overrides can still change the active call`,
		};
	}
	if (mode === "danger-full-access") {
		return { evidence: "disabled", detail: "configured sandbox_mode is danger-full-access" };
	}
	return { evidence: "unknown", detail: "no readable Codex sandbox_mode was found for this project/user" };
}

function geminiAssessment(root: string): SandboxAssessment {
	const candidates = [
		join(root, ".gemini", "settings.json"),
		join(homedir(), ".gemini", "settings.json"),
	];
	for (const path of candidates) {
		const settings = readJsonObject(path);
		const tools = nestedObject(settings?.tools);
		if (tools?.sandbox === undefined) continue;
		const security = nestedObject(settings?.security);
		if (tools.sandbox === false || security?.toolSandboxing === false) {
			return { evidence: "disabled", detail: `${path} disables Gemini tool sandboxing` };
		}
		return { evidence: "configured", detail: `Gemini sandbox is configured in ${path}` };
	}
	return { evidence: "unknown", detail: "no Gemini sandbox setting was found" };
}

/** Assess only evidence the local hook can actually see. */
export function assessShellSandbox(event: HarnessEvent, root: string): SandboxAssessment {
	const explicit = explicitCallAssessment(event);
	if (explicit) return explicit;
	switch (event.agent_source) {
		case "claude":
			return claudeAssessment(root);
		case "codex":
			return codexAssessment(root);
		case "gemini":
			return geminiAssessment(root);
		default:
			return {
				evidence: "unknown",
				detail: "this runner does not expose per-call sandbox attestation to the hook",
			};
	}
}

/** Add a once-per-session advisory for Bash calls that may execute. */
export function appendShellSandboxAdvisory(
	event: HarnessEvent,
	session: SessionTrajectory,
	decision: HarnessDecision,
	root: string,
): void {
	if (!isBash(event.tool_name) || decision.decision === "block") return;
	const assessment = assessShellSandbox(event, root);
	event.sandbox_evidence = assessment.evidence;
	const explicitRisk = assessment.evidence === "disabled";
	const acknowledged = session.acknowledged_checks;
	if (!explicitRisk && acknowledged.has(NOTICE_KEY)) return;
	if (!explicitRisk) acknowledged.add(NOTICE_KEY);
	const strength = assessment.evidence === "attested" ? "attested" : assessment.evidence;
	const message =
		`[interlinked:sandbox] Bash sandbox evidence=${strength}: ${assessment.detail}. ` +
		"Sandboxing limits blast radius but does not roll back writes inside the workspace; Interlinked still judges the observed filesystem ChangeSet after the call.";
	decision.warnings = [...(decision.warnings ?? []), message];
}
