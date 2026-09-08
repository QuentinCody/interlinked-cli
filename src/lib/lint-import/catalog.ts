import { LINT_ADAPTERS } from "./adapters.js";
import { isReportTool } from "./custom-adapters.js";

export interface LintDetector {
    tool: string;
    files: RegExp;
    manifests?: Record<string, RegExp>;
    runnable?: boolean;
}

/** Discovery includes configurations whose execution still needs an adapter. */
export const LINT_DETECTORS: readonly LintDetector[] = [
    { tool: "eslint", files: /^(?:\.eslintrc(?:\..+)?|eslint(?:\.[\w-]+)?\.config\.[cm]?[jt]s|\.eslintignore|eslint-suppressions\.json)$/, manifests: { "package.json": /"eslintConfig"\s*:/ }, runnable: true },
    { tool: "biome", files: /^biome\.jsonc?$/, runnable: true },
    { tool: "oxlint", files: /^(?:\.oxlintrc\.json|oxlint\.config\.[cm]?[jt]s|\.eslintignore)$/, runnable: true },
    { tool: "ruff", files: /^\.?ruff\.toml$/, manifests: { "pyproject.toml": /^\s*\[tool\.ruff(?:\.|\])/m }, runnable: true },
    { tool: "mypy", files: /^\.?mypy\.ini$/, manifests: { "pyproject.toml": /^\s*\[tool\.mypy(?:\.|\])/m, "setup.cfg": /^\s*\[mypy(?:-|\])/m } },
    { tool: "pylint", files: /^\.?(?:pylintrc|pylint\.toml)$/, manifests: { "pyproject.toml": /^\s*\[tool\.pylint(?:\.|\])/m, "setup.cfg": /^\s*\[pylint/m } },
    { tool: "flake8", files: /^\.flake8$/, manifests: { "setup.cfg": /^\s*\[flake8\]/m, "tox.ini": /^\s*\[flake8\]/m } },
    { tool: "clippy", files: /^\.?clippy\.toml$/, manifests: { "Cargo.toml": /^\s*\[(?:workspace\.)?lints(?:\.|\])/m }, runnable: true },
    { tool: "golangci-lint", files: /^\.golangci\.(?:ya?ml|json|toml)$/, runnable: true },
    { tool: "clang-tidy", files: /^\.clang-tidy$/ },
    { tool: "cppcheck", files: /(?:\.cppcheck|^cppcheck.*\.xml)$/ },
    { tool: "swiftlint", files: /^\.?swiftlint(?:[.-].*)?\.ya?ml$/, runnable: true },
    { tool: "shellcheck", files: /^\.?shellcheckrc$/ },
    { tool: "rubocop", files: /^\.rubocop(?:[._-].*)?\.ya?ml$/, runnable: true },
    { tool: "standardrb", files: /^\.standard\.ya?ml$/ },
    { tool: "checkstyle", files: /^(?:checkstyle(?:[.-].*)?|.*[.-]checkstyle)\.xml$/, manifests: { "pom.xml": /maven-checkstyle-plugin/, "build.gradle": /\bcheckstyle\b/, "build.gradle.kts": /\bcheckstyle\b/ } },
    { tool: "pmd", files: /^(?:pmd(?:[.-].*)?|ruleset)\.xml$/, manifests: { "pom.xml": /maven-pmd-plugin/, "build.gradle": /\bpmd\b/, "build.gradle.kts": /\bpmd\b/ } },
    { tool: "detekt", files: /^detekt(?:[.-].*)?\.ya?ml$/, manifests: { "build.gradle": /\bdetekt\b/, "build.gradle.kts": /\bdetekt\b/ } },
    { tool: "ktlint", files: /^\.ktlint.*$/, manifests: { ".editorconfig": /\bktlint_/ } },
    { tool: "roslyn", files: /(?:\.ruleset|\.globalconfig)$/, manifests: { ".editorconfig": /\bdotnet_diagnostic\./ } },
    { tool: "phpcs", files: /^\.?phpcs\.xml(?:\.dist)?$/ },
    { tool: "phpstan", files: /^phpstan(?:[.-].*)?\.neon(?:\.dist)?$/ },
    { tool: "psalm", files: /^psalm\.xml(?:\.dist)?$/ },
    { tool: "stylelint", files: /^(?:\.stylelintrc(?:\..+)?|stylelint\.config\.[cm]?[jt]s|\.stylelintignore)$/, manifests: { "package.json": /"stylelint"\s*:\s*\{/ }, runnable: true },
    { tool: "sqlfluff", files: /^\.sqlfluff$/, manifests: { "pyproject.toml": /^\s*\[tool\.sqlfluff(?:\.|\])/m } },
    { tool: "hadolint", files: /^\.?hadolint\.ya?ml$/ },
    { tool: "actionlint", files: /^actionlint\.ya?ml$/ },
    { tool: "semgrep", files: /^\.?semgrep(?:\.ya?ml)?$/ },
    { tool: "prettier", files: /^(?:\.prettierrc(?:\..+)?|prettier\.config\.[cm]?[jt]s|\.prettierignore)$/, manifests: { "package.json": /"prettier"\s*:\s*\{/ } },
    { tool: "shared-ignore", files: /^\.(?:gitignore|ignore)$/ },
];

export function supportsLintImport(tool: string): boolean {
    return Object.hasOwn(LINT_ADAPTERS, tool) || isReportTool(tool);
}
