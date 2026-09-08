export interface LintAdapter {
    command: string;
    prefix: string[];
    reporter: string[];
    successCodes: number[];
    configFlag?: string;
    targets: string[];
    cadence?: "audit";
}

/** Only installed analyzers are invoked; reporters and read-only verbs are owned here. */
export const LINT_ADAPTERS: Readonly<Record<string, LintAdapter>> = {
    biome: { command: "biome", prefix: ["lint"], reporter: ["--reporter=json", "--max-diagnostics=none"], successCodes: [0, 1], configFlag: "--config-path", targets: ["."] },
    eslint: { command: "eslint", prefix: [], reporter: ["--format", "json"], successCodes: [0, 1], configFlag: "--config", targets: ["."] },
    oxlint: { command: "oxlint", prefix: [], reporter: ["--format=json"], successCodes: [0, 1], configFlag: "--config", targets: ["."] },
    ruff: { command: "ruff", prefix: ["check"], reporter: ["--output-format=json"], successCodes: [0, 1], configFlag: "--config", targets: ["."] },
    clippy: { command: "cargo", prefix: ["clippy"], reporter: ["--message-format=json"], successCodes: [0], targets: [], cadence: "audit" },
    "golangci-lint": { command: "golangci-lint", prefix: ["run"], reporter: ["--output.json.path=stdout", "--output.text.path="], successCodes: [0, 1], configFlag: "--config", targets: ["./..."], cadence: "audit" },
    swiftlint: { command: "swiftlint", prefix: ["lint"], reporter: ["--quiet", "--reporter", "json"], successCodes: [0, 2], configFlag: "--config", targets: [] },
    rubocop: { command: "rubocop", prefix: [], reporter: ["--format", "json"], successCodes: [0, 1], configFlag: "--config", targets: [] },
    stylelint: { command: "stylelint", prefix: [], reporter: ["--formatter", "json"], successCodes: [0, 2], configFlag: "--config", targets: ["**/*.{css,scss,less}"] },
    mypy: { command: "mypy", prefix: [], reporter: ["--output=json"], successCodes: [0, 1], configFlag: "--config-file", targets: [], cadence: "audit" },
    pylint: { command: "pylint", prefix: [], reporter: ["--output-format=json", "--reports=no", "--score=no"], successCodes: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30], configFlag: "--rcfile", targets: ["."] },
    flake8: { command: "flake8", prefix: [], reporter: ["--format=%(path)s\t%(row)d\t%(code)s\t%(text)s"], successCodes: [0, 1], configFlag: "--config", targets: ["."] },
    standardrb: { command: "standardrb", prefix: [], reporter: ["--format", "json"], successCodes: [0, 1], configFlag: "--config", targets: [] },
    shellcheck: { command: "shellcheck", prefix: [], reporter: ["--format=json1"], successCodes: [0, 1], targets: ["**/*.sh"] },
    hadolint: { command: "hadolint", prefix: [], reporter: ["--format=json"], successCodes: [0, 1], configFlag: "--config", targets: ["**/Dockerfile*"] },
    actionlint: { command: "actionlint", prefix: [], reporter: ["-format", "{{json .}}"], successCodes: [0, 1], configFlag: "-config-file", targets: [] },
    phpcs: { command: "phpcs", prefix: [], reporter: ["--report=json"], successCodes: [0, 1, 2, 3], configFlag: "--standard", targets: [] },
    phpstan: { command: "phpstan", prefix: ["analyse"], reporter: ["--error-format=json", "--no-progress"], successCodes: [0, 1], configFlag: "--configuration", targets: [], cadence: "audit" },
    psalm: { command: "psalm", prefix: [], reporter: ["--output-format=json", "--no-progress"], successCodes: [0, 2], configFlag: "--config", targets: [], cadence: "audit" },
    sqlfluff: { command: "sqlfluff", prefix: ["lint"], reporter: ["--format=json", "--disable-progress-bar"], successCodes: [0, 1], configFlag: "--config", targets: ["."] },
    semgrep: { command: "semgrep", prefix: ["scan"], reporter: ["--json", "--metrics=off", "--disable-version-check"], successCodes: [0, 1], configFlag: "--config", targets: ["."], cadence: "audit" },
    prettier: { command: "prettier", prefix: [], reporter: ["--list-different"], successCodes: [0, 1], configFlag: "--config", targets: ["."] },
};
