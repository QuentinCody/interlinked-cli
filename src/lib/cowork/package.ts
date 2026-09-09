import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { coworkCapabilities, coworkHookSettings } from "./capabilities.js";
import { COWORK_PROBE_PROMPT } from "./probe.js";
import { parseCoworkPolicy, type CoworkPolicy } from "./policy.js";
import { digest } from "./receipts.js";
import { COWORK_LAUNCHER } from "./launcher.js";

export function findCoworkBundle(): string {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let level = 0; level < 6; level++) {
        for (const path of [join(directory, "cowork", "cowork-hook.js"), join(directory, "dist", "cowork", "cowork-hook.js")]) {
            if (existsSync(path)) return path;
        }
        directory = dirname(directory);
    }
    throw new Error("Cowork standalone runtime missing. Run npm run build in the Interlinked CLI checkout.");
}

const GUARD_SKILL = `---
name: interlinked
description: Understand the experimental Interlinked Cowork guard, receipts, and workspace checks.
---

Interlinked checks observed tool calls using explicit tool/path policy and its shared destructive-command guard. It does not certify every Cowork action. Read NOT CHECKED as unavailable evidence, not success. Do not retry a denied action through another tool. Ask the user to resolve the underlying policy or access issue.

The plugin runs where Cowork executes hooks; that may be a cloud container. Host paths and device VM paths are distinct. Never assume the host daemon or repository baselines are accessible. A configured bridge is mandatory for that policy: connection failure denies the pre-tool call.

Host pre-tool guidance is carried in additionalContext without granting permission on ordinary allows. Artifact feedback appends to host findings. Normal post-tool hooks run only for explicit mutating tools, including Bash and device Bash; the diagnostic probe retains broad subscriptions. Cowork-scoped host rules use active_when.agent_source set to cowork and require the bridge.

Receipts are in the plugin's evidence/events.jsonl. They contain hashes, metadata, and check names, not raw tool inputs or outputs. An emitted deny is not proof of prevention; inspect independent effects and positive controls. Skills do not enable hooks in ordinary Desktop Chat.

Use interlinked cowork artifact <file> on the machine containing the artifact for bounded Office/text checks. This does not calculate formulas, render layouts, or verify claims/citations. Use interlinked cowork verify <workspace> for existing project checks. Report unavailable/deferred checks explicitly.
`;

export interface CoworkPackageResult { directory: string; archive: string; sha256: string; mode: string; files: string[] }

export function packageCoworkPlugin(options: { output: string; policy: CoworkPolicy; runtime?: string }): CoworkPackageResult {
    const policy = parseCoworkPolicy(options.policy), runtime = options.runtime ?? findCoworkBundle();
    const name = policy.mode === "probe" ? "interlinked-cowork-probe" : "interlinked-cowork";
    const output = resolve(options.output), directory = join(output, name), archive = join(output, `${name}.plugin`);
    if (existsSync(directory) || existsSync(archive)) throw new Error("Cowork package output already exists; choose a fresh output directory");
    mkdirSync(output, { recursive: true });
    mkdirSync(directory);
    const files: Record<string, string> = {
        ".claude-plugin/plugin.json": JSON.stringify({ name, version: "0.1.0", description: "Experimental Interlinked Cowork guard and native hook conformance probe" }, null, 2),
        "hooks/hooks.json": JSON.stringify(coworkHookSettings(undefined, policy.mode === "probe"), null, 2),
        "policy.json": JSON.stringify(policy, null, 2),
        "package.json": '{"type":"module"}',
        "capabilities.json": JSON.stringify(coworkCapabilities(), null, 2),
        "skills/interlinked/SKILL.md": GUARD_SKILL,
        "scripts/cowork-hook.sh": COWORK_LAUNCHER,
    };
    if (policy.mode === "probe") files["skills/probe/SKILL.md"] = `---\nname: probe\ndescription: Run the synthetic Interlinked Cowork hook compatibility campaign.\n---\n\n${COWORK_PROBE_PROMPT}\n`;
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), `${content}\n`, { flag: "wx", mode: 0o600 });
    }
    mkdirSync(join(directory, "scripts"), { recursive: true });
    copyFileSync(runtime, join(directory, "scripts", "cowork-hook.js"));
    const names = [...Object.keys(files), "scripts/cowork-hook.js"];
    execFileSync("zip", ["-q", archive, ...names], { cwd: directory, timeout: 30000 });
    return { directory, archive, sha256: digest(readFileSync(archive)), mode: policy.mode, files: names };
}
