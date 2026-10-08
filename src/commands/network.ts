import { codexNetworkProfile, installCodexNetworkProfile } from "../lib/codex-network-profile.js";
import { checkNetworkAccess } from "../lib/network-access.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export async function networkCheckCommand(endpoints: string[], options: { json?: boolean }): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const result = await checkNetworkAccess(endpoints);
        output(mode, result, {
            normal: () => [
                ...result.probes.map((probe) => `${probe.reachable ? "REACHABLE" : "UNREACHABLE"} ${probe.endpoint}: ${probe.http_status ?? probe.failure}`),
                `Runtime: sandbox=${result.runtime.codex_sandbox ?? "unreported"}, network_disabled=${result.runtime.network_disabled}`,
                result.guidance,
                ...(!result.reachable ? ["Review the host's reusable execution-permission profile. Interlinked cannot change an active OS sandbox; retain hooks and workspace filesystem limits."] : []),
            ].join("\n"),
        });
        if (!result.reachable) process.exitCode = 1;
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : "Network check failed");
    }
}

export function networkCodexProfileCommand(name: string, options: { allow: string[]; write?: boolean; json?: boolean }): void {
    const mode = getOutputMode(options);
    try {
        const profile = options.write
            ? installCodexNetworkProfile(name, options.allow)
            : { ...codexNetworkProfile(name, options.allow), path: null, changed: false };
        const guidance = `Select with codex --profile ${name} (or codex --profile ${name} resume <session-id>). This does not change a running session. Requires Codex config-file profiles and permissions support. Legacy sandbox_mode or --sandbox overrides take precedence; managed requirements remain authoritative. Verify with interlinked network check inside the resumed agent. Domain rules cover all ports; application authentication is not tested.`;
        output(mode, { ...profile, guidance }, {
            normal: () => `${profile.path ? `Profile ${profile.changed ? "created" : "unchanged"}: ${profile.path}\n` : "Preview (use --write to install):\n"}${profile.text}\n${guidance}`,
        });
    } catch (error) {
        outputError(mode, error instanceof Error ? error.message : "Profile generation failed");
    }
}
