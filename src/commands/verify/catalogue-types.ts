/** Advisory findings. Summary coverage also runs at Stop; it never blocks. */
export interface CatalogueFinding {
    check: string;
    file: string;
    line: number;
    message: string;
    evidence?: string;
}
export interface CatalogueResult {
    findings: CatalogueFinding[];
    examined: number;
    unavailable: number;
    durationMs: number;
}
export const VERIFY_ADVISORY_CATALOGUE = [
    { id: "readme_command_drift", phase: "verify", description: "Documented CLI commands or flags absent from the current help tree" },
    { id: "unread_config_key", phase: "verify", description: "Declared configuration keys with no statically observed source read; dynamic access abstains" },
    { id: "summary_file_coverage", phase: "Stop", description: "Final-message file mentions compared with recorded completed-write targets; fenced examples excluded" },
] as const;
