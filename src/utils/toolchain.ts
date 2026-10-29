import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);

export type ProjectLanguage = "python" | "typescript" | "go" | "rust" | "other";

export interface ProjectProfile {
    language: ProjectLanguage;
    /** What a human would run. Not executed during the hunt. */
    suiteLabel: string;
    /** Fast check that the compiler or runtime is usable. */
    smokeCommand?: string;
    smokeTimeoutMs: number;
}

const SKIP_WALK = new Set([
    ".git", "node_modules", "vendor", "dist", "target", "build", "coverage", ".venv", "venv",
]);

function listFiles(repoPath: string): string[] {
    try {
        const out = execSync("git ls-files", {
            cwd: repoPath,
            encoding: "utf-8",
            timeout: 15_000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const tracked = out.split("\n").map((line) => line.trim()).filter(Boolean);
        if (tracked.length > 0) return tracked;
    } catch {
        // Fixture directories and fresh clones that are not git repos yet.
    }

    const found: string[] = [];
    const walk = (dir: string, rel: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (SKIP_WALK.has(entry.name) || entry.name.startsWith(".")) continue;
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
            else found.push(childRel);
        }
    };
    walk(repoPath, "");
    return found;
}

function ignoredSource(file: string): boolean {
    const normalized = file.split(path.sep).join("/");
    return normalized.includes("/node_modules/")
        || normalized.startsWith("node_modules/")
        || normalized.includes("/vendor/")
        || normalized.startsWith("vendor/")
        || normalized.includes("/dist/")
        || normalized.startsWith("dist/")
        || normalized.includes("/target/")
        || normalized.startsWith("target/");
}

/**
 * Picks the language the hunt should audit.
 * JavaScript and Java are intentionally not selected: a repo is TypeScript
 * only when it actually contains TypeScript sources.
 */
export function detectProject(repoPath: string): ProjectProfile {
    let python = 0;
    let typescript = 0;
    let go = 0;
    let rust = 0;

    for (const file of listFiles(repoPath)) {
        if (ignoredSource(file)) continue;
        const normalized = file.split(path.sep).join("/");
        if (normalized.endsWith(".d.ts")) continue;
        const ext = path.posix.extname(normalized);
        if (ext === ".py") python++;
        else if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") typescript++;
        else if (ext === ".go") go++;
        else if (ext === ".rs") rust++;
    }

    const ranked: { language: ProjectLanguage; count: number }[] = [
        { language: "python", count: python },
        { language: "typescript", count: typescript },
        { language: "go", count: go },
        { language: "rust", count: rust },
    ];
    ranked.sort((a, b) => b.count - a.count);

    let language: ProjectLanguage = ranked[0].count > 0 ? ranked[0].language : "other";
    if (language === "other") {
        if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) language = "rust";
        else if (fs.existsSync(path.join(repoPath, "go.mod"))) language = "go";
        else if (fs.existsSync(path.join(repoPath, "pyproject.toml")) || fs.existsSync(path.join(repoPath, "setup.py"))) {
            language = "python";
        }
    }

    return profileFor(language);
}

function profileFor(language: ProjectLanguage): ProjectProfile {
    if (language === "typescript") {
        return {
            language,
            suiteLabel: "npm test",
            smokeCommand: typescriptSmokeCommand(),
            smokeTimeoutMs: 30_000,
        };
    }
    if (language === "go") {
        return {
            language,
            suiteLabel: "go test",
            smokeCommand: "go list -m",
            smokeTimeoutMs: 30_000,
        };
    }
    if (language === "rust") {
        return {
            language,
            suiteLabel: "cargo test",
            smokeCommand: "cargo metadata --no-deps --format-version 1",
            smokeTimeoutMs: 45_000,
        };
    }
    if (language === "python") {
        return {
            language,
            suiteLabel: "pytest",
            smokeTimeoutMs: 45_000,
        };
    }
    return {
        language: "other",
        suiteLabel: "unknown",
        smokeTimeoutMs: 30_000,
    };
}

export function huntExtensions(language: ProjectLanguage): string[] {
    switch (language) {
        case "python":
            return [".py"];
        case "typescript":
            return [".ts", ".tsx", ".mts", ".cts"];
        case "go":
            return [".go"];
        case "rust":
            return [".rs"];
        default:
            return [".ts", ".js", ".py", ".go", ".rs"];
    }
}

export function commandTimeoutMs(command: string, floor = 30_000): number {
    const trimmed = command.trim();
    if (/^cargo\b/.test(trimmed)) return Math.max(floor, 180_000);
    if (/^go\b/.test(trimmed)) return Math.max(floor, 90_000);
    return floor;
}

export function resolveTsxBin(): string | undefined {
    try {
        const pkgJson = require.resolve("tsx/package.json");
        const bin = path.join(path.dirname(pkgJson), "dist", "cli.mjs");
        return fs.existsSync(bin) ? bin : undefined;
    } catch {
        return undefined;
    }
}

function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:+@=-]+$/.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
}

/** Prefix that executes a TypeScript file from the repo root. */
export function typescriptRunnerPrefix(): string {
    const tsxBin = resolveTsxBin();
    if (tsxBin) return `node ${shellQuote(tsxBin)}`;
    return "node --experimental-strip-types";
}

function typescriptSmokeCommand(): string {
    return `${typescriptRunnerPrefix()} -e "process.stdout.write('ok')"`;
}

export function typescriptProbeCommand(): string {
    return `${typescriptRunnerPrefix()} tests/test_hunted_probe.ts`;
}

function safeRelative(file: string): string | undefined {
    if (!file || path.isAbsolute(file)) return undefined;
    const normalized = file.split(path.sep).join("/");
    if (normalized.split("/").includes("..")) return undefined;
    return normalized;
}

export function goProbeFile(targetFile: string): string | undefined {
    const normalized = safeRelative(targetFile);
    if (!normalized || !normalized.endsWith(".go")) return undefined;
    const dir = path.posix.dirname(normalized);
    return dir === "." ? "hunted_probe_test.go" : `${dir}/hunted_probe_test.go`;
}

export function goProbeCommand(targetFile: string): string | undefined {
    const normalized = safeRelative(targetFile);
    if (!normalized) return undefined;
    const dir = path.posix.dirname(normalized);
    const pkg = dir === "." ? "." : `./${dir}`;
    return `go test -count=1 -timeout 60s -run '^TestHuntedProbe$' ${pkg}`;
}

export function goPackageName(source: string): string | undefined {
    return source.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1];
}

export interface RustPackage {
    name: string;
    /** Repo-relative directory containing Cargo.toml. "." for the root crate. */
    dir: string;
    probeFile: string;
    command: string;
}

export function rustPackage(repoPath: string, targetFile: string): RustPackage | undefined {
    const normalized = safeRelative(targetFile);
    if (!normalized) return undefined;
    let dir = path.resolve(repoPath, path.posix.dirname(normalized));
    const root = path.resolve(repoPath);
    while (dir === root || dir.startsWith(root + path.sep)) {
        const manifest = path.join(dir, "Cargo.toml");
        const name = fs.existsSync(manifest) ? cargoPackageName(manifest) : undefined;
        if (name) {
            const relDir = path.relative(root, dir).split(path.sep).join("/") || ".";
            const probeFile = relDir === "." ? "tests/hunted_probe.rs" : `${relDir}/tests/hunted_probe.rs`;
            const manifestArg = relDir === "." ? "Cargo.toml" : `${relDir}/Cargo.toml`;
            return {
                name,
                dir: relDir,
                probeFile,
                command: `cargo test --manifest-path ${shellQuote(manifestArg)} --test hunted_probe -- --exact hunted_probe`,
            };
        }
        if (dir === root) break;
        dir = path.dirname(dir);
    }
    return undefined;
}

function cargoPackageName(manifestPath: string): string | undefined {
    const text = fs.readFileSync(manifestPath, "utf-8");
    const start = text.search(/^\[package\]\s*$/m);
    if (start === -1) return undefined;
    const rest = text.slice(start);
    const next = rest.slice(1).search(/\n\[/);
    const body = next === -1 ? rest : rest.slice(0, next + 1);
    return body.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
}

export function auditNote(language: ProjectLanguage, repoPath: string, relPath: string, source: string): string {
    if (language === "go") {
        const probe = goProbeFile(relPath);
        const pkg = goPackageName(source);
        if (!probe) return "";
        return ` [Go probe: ${probe}, package ${pkg || "the file's package clause"}, test TestHuntedProbe]`;
    }
    if (language === "rust") {
        const crate = rustPackage(repoPath, relPath);
        if (!crate) return "";
        return ` [Rust crate \`${crate.name}\`, probe ${crate.probeFile}, \`use ${crate.name}::...\`]`;
    }
    if (language === "typescript") {
        return " [TypeScript probe: tests/test_hunted_probe.ts, relative import, no extension]";
    }
    return "";
}

export function probeInstructions(language: ProjectLanguage, repoPath: string, batchFiles: string[]): string {
    if (language === "typescript") {
        return `
TASK:
The samples are TypeScript. Find a realistic call that throws (TypeError, RangeError, or a failed invariant).
Write tests/test_hunted_probe.ts. It is executed with tsx from the repository root.
- ESM import/export. Import the target with a relative path and NO file extension, for example import { fn } from "../src/lib".
- Call the imported function. An unused import is deleted before the file runs, and the probe then exits 0.
- Do not use path aliases, vitest, jest, mocha, or a test runner.
- Do not catch the exception you are trying to prove. process.exit(1) or an uncaught throw when the bug is present. Exit 0 when it is not.
- No network and no watch mode.
probeFileName must be "tests/test_hunted_probe.ts".
`;
    }
    if (language === "go") {
        const hints = batchFiles.map((file) => {
            let source = "";
            try {
                source = fs.readFileSync(path.join(repoPath, file), "utf-8");
            } catch {
                source = "";
            }
            return `- ${file}: package ${goPackageName(source) || "?"}, probe file ${goProbeFile(file) || "?"}`;
        }).join("\n");
        return `
TASK:
The samples are Go. Find a realistic call that panics (nil pointer, index out of range, or a bad type assertion).
Write a test in the SAME directory as targetFile, named hunted_probe_test.go.
- Use the same package clause as the target file, not package foo_test.
- The test function must be named TestHuntedProbe.
- Do not recover the panic. t.Fatal or a panic when the bug is present. The test passes when the bug is absent.
- No network. No extra build tags.
Files in this round:
${hints}
probeFileName must be the hunted_probe_test.go path next to targetFile.
`;
    }
    if (language === "rust") {
        const hints = batchFiles.map((file) => {
            const crate = rustPackage(repoPath, file);
            return crate
                ? `- ${file}: crate \`${crate.name}\` in ${crate.dir}, probe ${crate.probeFile}`
                : `- ${file}: no Cargo package found`;
        }).join("\n");
        return `
TASK:
The samples are Rust. Find a realistic call that panics or returns a wrong Result.
Write an integration test at the probe path for the crate that contains targetFile. The test function must be named hunted_probe.
- Call the public API: use <crate_name>::...
- Do not catch the panic with catch_unwind. assert! or panic! when the bug is present. The test passes when the bug is absent.
- No network. Do not edit Cargo.toml.
Files in this round:
${hints}
probeFileName must be that crate's tests/hunted_probe.rs.
`;
    }
    return "";
}

export function resolveProbeFile(
    language: ProjectLanguage,
    repoPath: string,
    targetFile: string,
    requested?: string
): string | undefined {
    if (language === "typescript") return "tests/test_hunted_probe.ts";
    if (language === "go") return goProbeFile(targetFile);
    if (language === "rust") return rustPackage(repoPath, targetFile)?.probeFile
        || (requested && safeRelative(requested))
        || undefined;
    const fallback = requested && safeRelative(requested);
    return fallback;
}

export function buildProbeCommand(
    language: ProjectLanguage,
    repoPath: string,
    targetFile: string
): string | undefined {
    if (language === "typescript") return typescriptProbeCommand();
    if (language === "go") return goProbeCommand(targetFile);
    if (language === "rust") return rustPackage(repoPath, targetFile)?.command;
    return undefined;
}

export function isEnvironmentalProbeFailure(language: ProjectLanguage, trace: string, _probeFile: string): boolean {
    if (/command not found|ETIMEDOUT|spawnSync \/bin\/sh ETIMEDOUT/.test(trace)) return true;
    if (language === "typescript") {
        return /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError|does not provide an export|Cannot use import statement|Transform failed|error TS\d+/.test(trace);
    }
    if (language === "go") {
        if (/--- FAIL:|panic:/.test(trace) && !/build failed/.test(trace)) return false;
        return /build failed|could not import|no required module provides|go: cannot find main module|undefined:|syntax error/.test(trace);
    }
    if (language === "rust") {
        if (/panicked at|assertion failed/.test(trace)) return false;
        return /error\[E|could not compile|cannot find/.test(trace);
    }
    return /ModuleNotFoundError|ImportError|SyntaxError/.test(trace);
}
