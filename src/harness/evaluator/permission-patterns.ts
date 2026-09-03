// ===========================================
// Permission Pattern Detection
// ===========================================
//
// When an agent issues the same tool-call shape N times in a row, we learn
// that pattern and proactively add it to `.claude/settings.json` so the
// user no longer gets prompted for it. This module owns pattern extraction
// and the safe subset of auto-permittable commands.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import { isBash } from "./tool-classifiers.js";

/** Commands that should NEVER be auto-permitted */
const DANGEROUS_COMMANDS = new Set([
	"rm",
	"rmdir",
	"sudo",
	"chmod",
	"chown",
	"kill",
	"pkill",
	"killall",
	"dd",
	"mkfs",
	"fdisk",
	"shutdown",
	"reboot",
	"halt",
	"git push",
	"git reset",
	"git clean",
	"git checkout",
	"docker rm",
	"docker system",
	"docker compose down",
	"kubectl delete",
	"kubectl drain",
	"terraform destroy",
	"terraform apply",
	"wrangler delete",
	"vercel rm",
	"vercel remove",
	"curl",
	"wget",
]);

/** Tools whose first-part subcommand is meaningful enough to include in the
 *  learned permission pattern (e.g., `Bash(git status *)` rather than just `Bash(git *)`). */
const MULTI_SUBCOMMAND_TOOLS = new Set(["git", "npm", "npx", "node", "cargo"]);

/** Public API — consumed by evaluator.ts and server.ts to extract a Claude Code
 *  permission pattern from a tool call. Returns null for destructive commands
 *  (never auto-permit those) or when no stable pattern can be derived. */
export function extractPermissionPattern(toolName: string, toolInput: JsonObject): string | null {
	if (isBash(toolName)) {
		return extractBashPattern((toolInput.command as string) || "");
	}
	if (toolName === "WebFetch" || toolName === "web_fetch") {
		const url = (toolInput.url as string) || "";
		try {
			const host = new URL(url).hostname;
			return `WebFetch(domain:${host})`;
		} catch {
			return null;
		}
	}
	return null;
}

/** Build a skeleton pattern for compound `a && b && c` bash commands, or a
 *  single-command pattern otherwise. Returns null when the command is
 *  destructive or structurally trivial. */
function extractBashPattern(cmd: string): string | null {
	if (!cmd) return null;

	// For compound commands (&&-chained), extract the structural skeleton.
	if (cmd.includes("&&")) {
		return extractCompoundBashPattern(cmd);
	}

	const parts = cmd.trim().split(/\s+/);
	const first = parts[0];
	if (!first) return null;

	// Never auto-permit destructive or network commands
	if (DANGEROUS_COMMANDS.has(first)) return null;
	if (parts[1] && DANGEROUS_COMMANDS.has(`${first} ${parts[1]}`)) return null;

	// For npx/bunx, include the package name
	if ((first === "npx" || first === "bunx") && parts[1]) {
		return `Bash(${first} ${parts[1]} *)`;
	}
	// For npm/yarn/pnpm, include the subcommand
	if ((first === "npm" || first === "yarn" || first === "pnpm") && parts[1]) {
		return `Bash(${first} ${parts[1]} *)`;
	}
	return `Bash(${first} *)`;
}

/** What one segment of an &&-chain contributes to the skeleton: a command name
 *  to keep, a deny-listed command that voids the whole pattern, or nothing. */
type SegmentVerdict = { kind: "skip" } | { kind: "deny" } | { kind: "keep"; entry: string };

/** Index of the first token that is a real command, skipping leading variable
 *  assignments (`FOO=bar`, `FOO=$(...)`). */
function commandStartIndex(segParts: string[]): number {
	let cmdStart = 0;
	while (cmdStart < segParts.length && /^[A-Z_]+=/.test(nonNull(segParts[cmdStart]))) {
		cmdStart++;
	}
	return cmdStart;
}

/** Skeleton entry for a tool whose subcommand is meaningful (`git status`),
 *  falling back to the bare command when no subcommand token is present. */
function multiSubcommandEntry(segParts: string[], cmdStart: number, core: string): string {
	const subCmd = segParts.find(
		(p, i) => i > cmdStart && !p.startsWith("-") && !p.startsWith("$") && !p.startsWith('"'),
	);
	return subCmd ? `${core} ${subCmd}` : core;
}

/** Reduce one &&-chain segment to its skeleton contribution. */
function classifyCompoundSegment(seg: string): SegmentVerdict {
	const segParts = seg.trim().split(/\s+/);
	const cmdStart = commandStartIndex(segParts);
	const core = segParts[cmdStart] || "";
	if (!core) return { kind: "skip" };

	// Abort if any segment triggers the deny-list
	if (DANGEROUS_COMMANDS.has(core)) return { kind: "deny" };
	const sub = segParts[cmdStart + 1] || "";
	if (sub && DANGEROUS_COMMANDS.has(`${core} ${sub}`)) return { kind: "deny" };

	if (MULTI_SUBCOMMAND_TOOLS.has(core)) {
		return { kind: "keep", entry: multiSubcommandEntry(segParts, cmdStart, core) };
	}
	return { kind: "keep", entry: core };
}

/** Build a skeleton from an &&-chained compound command, e.g.
 *  `BOOT=$(mktemp -d) && cp src/* $BOOT/ && git -C $BOOT init && git commit`
 *  becomes `Bash(mktemp && cp && git init && git commit *)`. */
function extractCompoundBashPattern(cmd: string): string | null {
	const segments = cmd.split(/\s*&&\s*/);
	const skeleton: string[] = [];

	for (const seg of segments) {
		const verdict = classifyCompoundSegment(seg);
		if (verdict.kind === "deny") return null;
		if (verdict.kind === "keep") skeleton.push(verdict.entry);
	}

	if (skeleton.length >= 2) {
		return `Bash(${skeleton.join(" && ")} *)`;
	}
	return null;
}

/** Public API — consumed by evaluator.ts to persist a learned permission
 *  pattern into the project's `.claude/settings.json` so the user no longer
 *  gets prompted for matching calls. Returns true when newly added, false
 *  on duplicate or write failure. */
export function addPermissionToSettings(pattern: string): boolean {
	try {
		const settingsDir = join(process.cwd(), ".claude");
		const settingsPath = join(settingsDir, "settings.json");

		let settings: JsonObject = {};
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			mkdirSync(settingsDir, { recursive: true });
		}

		if (!settings.permissions) settings.permissions = {};
		const perms = settings.permissions as JsonObject;
		if (!Array.isArray(perms.allow)) perms.allow = [];
		const allowList = perms.allow as string[];

		// Don't add duplicates
		if (allowList.includes(pattern)) return false;

		allowList.push(pattern);
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}
