/** Shared with verify and tool discovery; adoption must preserve the audit cadence. */
export const TYPED_ESLINT_PROFILE = {
    id: "tseslint-types",
    tool: "eslint",
    config: "eslint.interlinked-types.config.mjs",
    scope: ".",
    cadence: "audit",
    timeoutMs: 300_000,
} as const;

export function typedEslintArgs(): string[] {
	return [TYPED_ESLINT_PROFILE.tool, "--config", TYPED_ESLINT_PROFILE.config, "--format", "json", TYPED_ESLINT_PROFILE.scope];
}
