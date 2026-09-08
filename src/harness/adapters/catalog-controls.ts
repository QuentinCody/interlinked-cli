import catalog from "./hook-support-catalog.json" with { type: "json" };
import type { HookControl } from "./hook-contract.js";

const PROFILE_BY_PATH: Record<string, string> = {
    ".claude/settings.json": "claude-code", ".codex/hooks.json": "codex", ".github/hooks/hooks.json": "copilot-cli", ".gemini/settings.json": "gemini-cli",
    ".cursor/hooks.json": "cursor-ide", ".opencode/plugins/interlinked.ts": "opencode-v1", ".pi/extensions/interlinked.js": "pi",
};
const REPRESENTABLE: readonly HookControl[] = ["deny", "ask", "defer", "rewrite_input", "replace_result", "context", "continue", "cancel", "wake", "replace_operation"];

/** Attach only independently documented abilities; legacy control enums imply nothing. */
export function catalogControls(path: string, nativeEvent: string): readonly HookControl[] | undefined {
    const profile = catalog.surfaces.find(surface => surface.id === PROFILE_BY_PATH[path]);
    const group = profile?.event_groups.find(group => group.native_names.includes(nativeEvent));
    if (!group?.controls.length) return undefined;
    const controls = REPRESENTABLE.filter(control => group.controls.includes(control));
    if (!controls.length && !group.controls.includes("observe")) return undefined;
    return controls;
}
