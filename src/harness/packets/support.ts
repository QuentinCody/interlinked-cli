// Instruction packets — phase × tool delivery support (design §5, R7).
//
// A packet is live only where the runner's hooks actually deliver the event it
// listens on. The replay corpus holds PreToolUse rows for EVERY tool, but the
// Claude Code adapter registers PostToolUse only for the write tools of
// `lib/write-tool-registry.ts` plus Bash (`CLAUDE_POST_TOOL_USE_MATCHER`), and
// Codex only for its own write verbs — so a `Read`/PostToolUse packet matches
// the corpus and never executes. The table here is DERIVED from those
// registries and the adapters' installed-event lists; nothing is retyped.

import { CLIENT_TO_RUNNER } from "../../lib/settings.js";
import { CLAUDE_CODE_WRITE_TOOLS, CODEX_WRITE_TOOLS } from "../../lib/write-tool-registry.js";
import { CLAUDE_CODE_CAPABILITIES, CODEX_CAPABILITIES, installedEventNames } from "../adapters/provider-capabilities.js";
import type { RunnerCapabilities } from "../adapters/types.js";
import type { Packet, PacketPhase } from "./types.js";

export type PacketSupport = { supported: true } | { supported: false; reason: string };

interface DeliveryTable {
	capabilities: RunnerCapabilities;
	/** Tool names the PostToolUse matcher admits. */
	postToolUse: readonly string[];
}

const TABLES: Record<string, DeliveryTable> = {
	"claude-code": { capabilities: CLAUDE_CODE_CAPABILITIES, postToolUse: CLAUDE_CODE_WRITE_TOOLS },
	codex: { capabilities: CODEX_CAPABILITIES, postToolUse: CODEX_WRITE_TOOLS },
};

/** Native event name a packet phase listens on. */
const PHASE_EVENT: Record<PacketPhase, string> = {
	pre: "PreToolUse",
	post: "PostToolUse",
	stop: "Stop",
	session_start: "SessionStart",
};

/** The adapter id for a hook event's `agent_source` (legacy client ids: `claude` → `claude-code`); unknown ids pass through. */
export function runnerIdOf(agentSource: string): string {
	return (CLIENT_TO_RUNNER as Record<string, string>)[agentSource] ?? agentSource;
}

/** The PostToolUse tool list for a runner, or null when no table exists (unmeasured, not none). */
export function postToolUseTools(runner: string): readonly string[] | null {
	return TABLES[runnerIdOf(runner)]?.postToolUse ?? null;
}

/** Whether `packet` can execute live on `runner`; the reason names the first gap. */
export function packetSupport(packet: Packet, runnerOrSource: string): PacketSupport {
	const runner = runnerIdOf(runnerOrSource);
	const table = TABLES[runner];
	if (!table) return { supported: false, reason: `no delivery table for runner "${runner}"; a packet is never assumed live` };
	const event = PHASE_EVENT[packet.applies.phase];
	if (!installedEventNames(table.capabilities).includes(event)) {
		return { supported: false, reason: `${runner} does not install ${event}, which phase "${packet.applies.phase}" needs` };
	}
	if (packet.applies.phase === "post") {
		const missing = packet.applies.tools.filter((t) => !table.postToolUse.includes(t));
		if (missing.length > 0) {
			return { supported: false, reason: `${missing.join(", ")}: not in the PostToolUse matcher of ${runner} (${table.postToolUse.join("|")})` };
		}
	}
	return { supported: true };
}

/** True when the runner's native PreToolUse control can express an ASK (a permission prompt). Codex's can only
 *  deny, so a cosign `ask` there would become a hard block — and a packet never blocks (design §3). */
export function runnerSupportsAsk(runnerOrSource: string): boolean {
	const table = TABLES[runnerIdOf(runnerOrSource)];
	const pre = table?.capabilities.events.find((e) => e.name === "PreToolUse" && e.install);
	return pre?.control === "ask" || pre?.control === "permission";
}
