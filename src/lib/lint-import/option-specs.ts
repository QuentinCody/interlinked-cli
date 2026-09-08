/** Semantic options that can be preserved without executing a source shell command. */
export const LINT_VALUE_OPTIONS: Readonly<Record<string, string[]>> = {
    eslint: ["--ext", "--rule", "--ignore-pattern", "--parser", "--parser-options", "--plugin"],
    oxlint: ["-A", "-W", "-D", "--allow", "--warn", "--deny", "--ignore-pattern", "--threads"],
    biome: ["--only", "--skip"],
    ruff: ["--select", "--extend-select", "--ignore", "--extend-ignore", "--exclude", "--extend-exclude", "--target-version", "--line-length"],
    mypy: ["--python-version", "--platform", "--enable-error-code", "--disable-error-code", "--exclude", "-p", "--package", "-m", "--module"],
    pylint: ["--enable", "--disable", "--load-plugins", "--ignore", "--ignore-patterns", "--py-version", "--max-line-length"],
    flake8: ["--select", "--extend-select", "--ignore", "--extend-ignore", "--exclude", "--extend-exclude", "--max-line-length", "--max-complexity"],
    clippy: ["--package", "-p", "--features", "--target", "--bin", "--example", "--test", "--bench"],
    "golangci-lint": ["--enable", "--disable", "--enable-only", "--build-tags", "--timeout", "--concurrency"],
    rubocop: ["--only", "--except"], standardrb: ["--ruby-version", "--only", "--except"],
    swiftlint: ["--only-rule"], stylelint: ["--ignore-pattern", "--custom-syntax"],
    shellcheck: ["--shell", "-s", "--exclude", "-e", "--enable", "-o", "--severity", "-S"],
    hadolint: ["--ignore", "--trusted-registry", "--failure-threshold"], actionlint: ["-ignore"],
    phpcs: ["--extensions", "--ignore", "--sniffs", "--exclude", "--severity", "--error-severity", "--warning-severity"],
    phpstan: ["--level", "--memory-limit"], psalm: ["--threads", "--php-version"],
    sqlfluff: ["--dialect", "--rules", "--exclude-rules", "--templater", "--ignore"],
    semgrep: ["--include", "--exclude", "--severity", "--jobs", "--timeout", "--max-target-bytes"],
    prettier: ["--parser", "--tab-width", "--print-width", "--trailing-comma", "--end-of-line", "--prose-wrap"],
};

export const LINT_BOOLEAN_OPTIONS: Readonly<Record<string, string[]>> = {
    eslint: ["--no-ignore", "--no-config-lookup", "--no-inline-config", "--report-unused-disable-directives"],
    oxlint: ["--type-aware", "--type-check", "--no-ignore", "--disable-nested-config", "--import-plugin", "--react-plugin", "--jest-plugin", "--vitest-plugin", "--promise-plugin", "--node-plugin", "--jsx-a11y-plugin"],
    ruff: ["--preview", "--no-preview", "--isolated", "--respect-gitignore", "--no-respect-gitignore", "--force-exclude", "--no-force-exclude"],
    mypy: ["--strict", "--no-incremental", "--ignore-missing-imports", "--follow-untyped-imports", "--warn-unused-ignores", "--disallow-untyped-defs", "--check-untyped-defs", "--no-namespace-packages", "--explicit-package-bases"],
    pylint: ["--recursive=y"], flake8: ["--isolated"],
    clippy: ["--workspace", "--all-targets", "--all-features", "--no-default-features", "--lib", "--bins", "--tests", "--examples", "--benches", "--locked", "--offline", "--release"],
    rubocop: ["--force-exclusion", "--ignore-parent-exclusion", "--parallel"], standardrb: ["--no-parallel"],
    swiftlint: ["--strict", "--lenient", "--force-exclude"], stylelint: ["--disable-ignore"],
    shellcheck: ["--external-sources", "-x", "--norc"], hadolint: ["--no-color", "--disable-ignore-pragma"],
    actionlint: ["-oneline", "-no-color"], phpcs: ["-s"], phpstan: ["--debug"],
    psalm: ["--no-cache", "--show-info=true", "--show-info=false"],
    sqlfluff: ["--ignore-local-config", "--disregard-sqlfluffignores"], semgrep: ["--no-git-ignore", "--no-rewrite-rule-ids"],
    prettier: ["--single-quote", "--no-semi", "--use-tabs", "--single-attribute-per-line"],
};

export const LINT_PATH_OPTIONS: Readonly<Record<string, string[]>> = {
    eslint: ["--ignore-path"], oxlint: ["--ignore-path", "--tsconfig"], clippy: ["--manifest-path"],
    stylelint: ["--ignore-path"], prettier: ["--ignore-path"], phpstan: ["--autoload-file"],
};

export const LINT_REPORT_OPTIONS: Readonly<Record<string, string[]>> = {
    eslint: ["--format", "-f"], oxlint: ["--format", "-f"], biome: ["--reporter"],
    ruff: ["--output-format"], mypy: ["--output", "-O"], pylint: ["--output-format", "-f"],
    flake8: ["--format"], clippy: ["--message-format"], swiftlint: ["--reporter"],
    rubocop: ["--format", "-f"], standardrb: ["--format", "-f"], stylelint: ["--formatter", "-f"],
    shellcheck: ["--format", "-f"], hadolint: ["--format", "-f"], actionlint: ["-format"],
    phpcs: ["--report"], phpstan: ["--error-format"], psalm: ["--output-format"], sqlfluff: ["--format", "-f"],
};
