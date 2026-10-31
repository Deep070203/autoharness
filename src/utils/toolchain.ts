import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { listTrackedFiles } from "./hunt-scope.js";

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
    if (fs.existsSync(path.join(repoPath, ".git"))) {
        // A failed listing must not walk the working tree. supabase/supabase
        // is large enough that a walk looks like a hang.
        const tracked = listTrackedFiles(repoPath);
        if (tracked) return tracked;
        return [];
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

/** Beside the file under test, the way a package test lives next to its source. */
export function typescriptProbeFile(targetFile: string): string {
    const normalized = safeRelative(targetFile);
    if (!normalized) return "hunted_probe.test.ts";
    const dir = path.posix.dirname(normalized);
    return dir === "." ? "hunted_probe.test.ts" : `${dir}/hunted_probe.test.ts`;
}

export function typescriptProbeCommand(targetFile: string): string {
    return `${typescriptRunnerPrefix()} ${shellQuote(typescriptProbeFile(targetFile))}`;
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
        return ` [TypeScript probe: ${typescriptProbeFile(relPath)}, relative import, no extension]`;
    }
    return "";
}

export function probeInstructions(language: ProjectLanguage, repoPath: string, batchFiles: string[]): string {
    if (language === "typescript") {
        const hints = batchFiles.map((file) => `- ${file}: probe ${typescriptProbeFile(file)}`).join("\n");
        return `
TASK:
The samples are TypeScript. Find a realistic call that throws, or a call that returns the wrong value.
Write the probe beside the target file (src/lib.ts -> src/hunted_probe.test.ts). It is executed with tsx from the repository root.
- ESM import/export. Import the target with a relative path and NO file extension, for example import { fn } from "./lib".
- Call the imported function. An unused import is deleted before the file runs, and the probe then exits 0.
- A wrong result is a bug even when nothing throws. Assert the correct result. The process must exit non-zero on the current code and 0 once the code is fixed. Do not assert a constant such as true or 1 === 2.
- Do not use path aliases, vitest, jest, mocha, or a test runner.
- Do not catch the exception you are trying to prove. An uncaught throw when the bug is a crash. Exit 0 when the behavior is already correct.
- No network and no watch mode. Keep the probe; it is the regression test.
Files in this round:
${hints}
probeFileName must be the hunted_probe.test.ts path next to targetFile.
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
The samples are Go. Find a realistic call that panics, or a call that returns the wrong value. Assert the correct result when nothing panics. The test must fail on the current code.
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
The samples are Rust. Find a realistic call that panics or returns the wrong value. Assert the correct result. The test must fail on the current code.
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
    if (language === "typescript") return typescriptProbeFile(targetFile);
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
    if (language === "typescript") return typescriptProbeCommand(targetFile);
    if (language === "go") return goProbeCommand(targetFile);
    if (language === "rust") return rustPackage(repoPath, targetFile)?.command;
    return undefined;
}

/**
 * A probe that catches an import failure and prints "Could not import … installed"
 * exits non-zero without ever calling the code under test. That is not a bug.
 * A later application exception (ValidationError, AttributeError, …) still counts.
 */
export function isPythonSetupFailure(trace: string): boolean {
    const setup = /ModuleNotFoundError|ImportError|SyntaxError|partially initialized module|No module named|Could not import|cannot import|Ensure .+ installed|DistributionNotFound|is not installed/i;
    if (!setup.test(trace)) return false;
    const exceptions = [...trace.matchAll(/^([A-Za-z_][\w.]*(?:Error|Exception)):/gm)].map((match) => match[1]);
    const last = exceptions[exceptions.length - 1];
    if (last && !/ImportError|ModuleNotFoundError|SyntaxError/.test(last)) return false;
    return true;
}

export function isJsonResponseError(message: string): boolean {
    return /JSON|Unexpected token|Bad escaped|Unterminated string|Unexpected end of/i.test(message);
}

export interface ProbeVerdict {
    accept: boolean;
    reason: string;
    exceptionType?: string;
    exceptionMessage?: string;
}

const FAKE_STAND_IN = /\b(?:MagicMock|AsyncMock|NonCallableMock|PropertyMock|unittest\.mock|monkeypatch|mocker|@patch)\b|(?:^|\n)\s*(?:class|struct|type)\s+\w*(?:Mock|Fake|Stub|Dummy)\w*/;

/**
 * Names the probe itself introduces. A crash that cites one of these is the
 * probe handing the library an object it just invented.
 */
export function standInsDefinedByProbe(source: string): string[] {
    const names = new Set<string>();
    for (const match of source.matchAll(/^\s*(?:class|struct)\s+([A-Za-z_]\w*)/gm)) names.add(match[1]);
    for (const match of source.matchAll(/^\s*type\s+([A-Za-z_]\w*)\s+struct\b/gm)) names.add(match[1]);
    for (const match of source.matchAll(/\btype\(\s*["']([A-Za-z_]\w*)["']/g)) names.add(match[1]);
    return [...names];
}

export function probeBuildsFake(source: string): string | undefined {
    return source.match(FAKE_STAND_IN)?.[0]?.trim();
}

export function parseTraceException(trace: string): { type?: string; message?: string } {
    const lines = trace.split("\n").map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const typed = line.match(/^([A-Za-z_][\w.]*(?:Error|Exception))\s*:\s*(.*)$/);
        if (typed) return { type: typed[1].split(".").pop(), message: typed[2] };
        if (/^panic:/.test(line) || /panicked at/.test(line)) {
            return { type: "panic", message: line.replace(/^panic:\s*/, "") };
        }
    }
    if (/assertion failed|index out of bounds/.test(trace)) return { type: "panic", message: "panic" };
    return {};
}

/**
 * Expected versus actual. A bare "AssertionError" or `assert False` does not qualify.
 */
export function isBehaviorAssertion(trace: string): boolean {
    return /left:\s*|right:\s*|expected\b|received\b|AssertionError:\s*assert\s+\S+\s*==|assertion (`left| failed)|Assertion with/i.test(trace);
}

/** The probe has to call the library. Asserting a constant does not. */
export function probeTouchesLibrary(probeSource: string, targetFile: string): boolean {
    const stem = path.posix.basename(targetFile).replace(/\.[^.]+$/, "");
    if (stem.length >= 3 && probeSource.toLowerCase().includes(stem.toLowerCase())) return true;
    const ignored = /^(assert|expect|require|check|refute|it|test|describe|fatal|errorf|fatalf|error|log|logf|run|skip)$/i;
    for (const match of probeSource.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        if (!ignored.test(match[1])) return true;
    }
    return false;
}

function traceEntersTarget(trace: string, targetFile: string): boolean {
    const normalized = targetFile.replace(/\\/g, "/");
    return trace.replace(/\\/g, "/").includes(normalized);
}

const REMOTE_EXCEPTION = /Unauthorized|HTTPStatus|ConnectError|ConnectTimeout|ReadTimeout|PoolTimeout|NetworkError|ConnectionError|ConnectionRefusedError|URLError|SSLError|ProxyError/;

/**
 * A 401 from Prefect Cloud, or any traceback that shows a live HTTP call,
 * means the probe left the machine. That is an account or network failure.
 */
export function remoteServiceFailure(trace: string, type?: string, message?: string): string | undefined {
    if (type && type !== "panic" && REMOTE_EXCEPTION.test(type)) return type;
    const blob = `${message || ""}\n${trace}`;
    return blob.match(/Invalid authentication credentials|401 Unauthorized|403 Forbidden|for url 'https?:\/\/|ECONNREFUSED|ENOTFOUND|getaddrinfo|httpx\._client|httpx\/_client/)?.[0];
}

function claimedExceptionTypes(claimedText: string): string[] {
    const found = [...claimedText.matchAll(/\b([A-Za-z_][\w.]*(?:Error|Exception))\b/g)].map((match) => match[1].split(".").pop()!);
    return [...new Set(found)];
}

/**
 * A failing probe is a bug only when the library itself raises, inside the
 * file under audit, on an object the probe did not invent.
 * The Prefect false positive was a TypeError naming MockPrefectClient, a
 * class the probe defined and passed in as the client.
 */
export function assessProbeFailure(input: {
    trace: string;
    probeSource: string;
    targetFile: string;
    claimedText?: string;
}): ProbeVerdict {
    const fake = probeBuildsFake(input.probeSource);
    if (fake) {
        return {
            accept: false,
            reason: `the probe defines a stand-in (${fake}). A crash of that stand-in is the probe, not the library`,
        };
    }

    const { type, message } = parseTraceException(input.trace);
    const assertion = isBehaviorAssertion(input.trace);

    const remote = remoteServiceFailure(input.trace, type, message);
    if (remote) {
        return {
            accept: false,
            reason: `the probe reached a remote service (${remote}). An authentication or network failure is not a bug in the library`,
        };
    }

    // A wrong result often fails in the test, not inside the library.
    // storage's signed-url test, supabase-py's channel test, etl's OID
    // assertion, and PostHogFeature's fallback test all work this way.
    if (assertion && (type === "AssertionError" || !traceEntersTarget(input.trace, input.targetFile))) {
        if (!probeTouchesLibrary(input.probeSource, input.targetFile)) {
            return {
                accept: false,
                reason: "the assertion does not call the library. A constant comparison is not a bug",
            };
        }
        return {
            accept: true,
            reason: `the current code fails the behavior test: ${(message || input.trace).trim().slice(0, 180)}`,
            exceptionType: type || "AssertionError",
            exceptionMessage: message,
        };
    }

    if (!type) {
        return { accept: false, reason: "the probe exited non-zero without an exception from the library" };
    }

    if (!traceEntersTarget(input.trace, input.targetFile)) {
        return { accept: false, reason: `the traceback never entered ${input.targetFile}` };
    }

    if (input.claimedText && type !== "panic" && type !== "AssertionError") {
        const claimed = claimedExceptionTypes(input.claimedText);
        if (claimed.length > 0 && !claimed.includes(type)) {
            return {
                accept: false,
                reason: `the hypothesis claims ${claimed.join(" or ")}, but the probe raised ${type}: ${message || ""}`.trim(),
            };
        }
    }

    const cited = standInsDefinedByProbe(input.probeSource).find((name) =>
        (message || "").includes(name) || input.trace.includes(`'${name}'`) || input.trace.includes(`"${name}"`)
    );
    if (cited) {
        return {
            accept: false,
            reason: `the exception names ${cited}, a type the probe defined. The library is rejecting that stand-in`,
        };
    }

    return {
        accept: true,
        reason: `${type}: ${message || ""}`.trim(),
        exceptionType: type,
        exceptionMessage: message,
    };
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
    return isPythonSetupFailure(trace);
}
