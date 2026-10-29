import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BehavioralMemory } from "../utils/memory.js";
import { resolveRepoEnv, normalizeCommandWithVenv, primaryPackageName, pythonImportCheckCommand, pythonScriptCommand } from "../utils/env.js";
import {
    auditNote,
    buildProbeCommand,
    commandTimeoutMs,
    detectProject,
    huntExtensions,
    isEnvironmentalProbeFailure,
    isJsonResponseError,
    probeInstructions,
    resolveProbeFile,
    type ProjectProfile,
} from "../utils/toolchain.js";

const MODEL: LanguageModel = google("gemini-2.5-flash") as unknown as LanguageModel;

export interface HuntedBug {
    title: string;
    description: string;
    archetype: string;
    targetFile: string;
    probeFilePath: string;
    probeCommand: string;
    failureTrace: string;
    sourceType: "hunted";
}

export interface GroundingContext {
    baselinePassed: boolean;
    detectedRunner?: string;
    recentCommits: { hash: string; message: string; diffStat: string }[];
    churnedFiles: string[];
}

/**
 * Breken-Style Autonomous Bug Hunter Agent with SWE Grounding.
 *
 * Workflow:
 * 1. Establish baseline test health and detect test runner.
 * 2. Analyze recent git commits and diffs (the "fresh code" delta).
 * 3. Formulate edge-case hypotheses targeting newly introduced or modified logic.
 * 4. Execute the probe test. Confirm it crashes with a genuine application error
 *    (AttributeError, TypeError, KeyError, IndexError, AssertionError).
 */
export class BugHunterAgent {
    private memory: BehavioralMemory;
    private projectProfile?: ProjectProfile;

    constructor(
        private repoPath: string,
        private owner: string,
        private repo: string,
        memory?: BehavioralMemory
    ) {
        this.memory = memory || new BehavioralMemory();
    }

    private loadProject(): ProjectProfile {
        if (!this.projectProfile) {
            this.projectProfile = detectProject(this.repoPath);
        }
        return this.projectProfile;
    }

    /**
     * Step 1: Runs the baseline health check like a professional SWE.
     */
    public async runBaselineCheck(onLog?: (msg: string) => void): Promise<{ passed: boolean; runner?: string; output: string }> {
        const log = (msg: string) => {
            console.log(`[Grounding] ${msg}`);
            if (onLog) onLog(msg);
        };

        const profile = this.loadProject();
        log(`Project language: ${profile.language}.`);
        if (profile.language === "typescript" || profile.language === "go" || profile.language === "rust") {
            return this.runLanguageSmoke(profile, log);
        }

        const cached = this.memory.getRepoEnvironment(this.owner, this.repo);
        let runner = cached?.detectedRunner;

        if (!runner) {
            if (fs.existsSync(path.join(this.repoPath, "package.json"))) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(path.join(this.repoPath, "package.json"), "utf-8"));
                    if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes("no test specified")) {
                        runner = "npm test";
                    }
                } catch (e) {}
            }
            if (!runner && (fs.existsSync(path.join(this.repoPath, "pyproject.toml")) || fs.existsSync(path.join(this.repoPath, "setup.py")))) {
                runner = "pytest -q --tb=short";
            }
            if (!runner && fs.existsSync(path.join(this.repoPath, "Cargo.toml"))) {
                runner = "cargo test";
            }
            if (!runner && fs.existsSync(path.join(this.repoPath, "go.mod"))) {
                runner = "go test ./...";
            }
        }

        if (!runner) {
            log("No standard test runner detected; proceeding with standalone probe verification.");
            return { passed: true, output: "No runner detected" };
        }

        const repoEnv = resolveRepoEnv(this.repoPath);
        if (repoEnv.venvDir) {
            log(`Discovered virtual environment: ${path.relative(this.repoPath, repoEnv.venvDir)}`);
        }

        // A full-suite run on a popular repo blows the hunt budget and, with a
        // broken PYTHONPATH, crashes instantly. Confirm the package imports.
        const pythonPkg = primaryPackageName(this.repoPath, this.repo);
        const pythonRunner = !runner || /pytest|python/.test(runner);
        if (pythonPkg && pythonRunner) {
            if (runner) {
                log(`Detected test runner \`${runner}\`. Verifying \`import ${pythonPkg}\` instead of the full suite.`);
            }
            const importCmd = pythonImportCheckCommand(pythonPkg, repoEnv.pythonBin);
            if (!importCmd) {
                return { passed: true, runner, output: "No import check" };
            }
            log(`Running import smoke test: \`${importCmd}\`...`);
            try {
                const out = execSync(importCmd, {
                    cwd: this.repoPath,
                    encoding: "utf-8",
                    timeout: 45_000,
                    env: repoEnv.env
                });
                log(`✅ Package \`${pythonPkg}\` imports. Hunt environment is usable.`);
                this.memory.saveRepoEnvironment(this.owner, this.repo, {
                    detectedRunner: runner,
                    baselinePassed: true,
                    lastTestedAt: new Date().toISOString()
                });
                return { passed: true, runner, output: out.substring(0, 1500) };
            } catch (err: any) {
                const output = (err.stdout || err.stderr || err.message || "").substring(0, 2000);
                log(`⚠️ \`import ${pythonPkg}\` failed. Probes will be discarded until imports work.\n${output.split("\n").slice(-4).join("\n")}`);
                this.memory.saveRepoEnvironment(this.owner, this.repo, {
                    detectedRunner: runner,
                    baselinePassed: false,
                    lastTestedAt: new Date().toISOString()
                });
                return { passed: false, runner, output };
            }
        }

        const normalizedRunner = normalizeCommandWithVenv(runner, repoEnv.pythonBin);
        log(`Running baseline test suite: \`${normalizedRunner}\`...`);
        try {
            const out = execSync(normalizedRunner, {
                cwd: this.repoPath,
                encoding: "utf-8",
                timeout: 60_000,
                env: repoEnv.env
            });
            log(`✅ Baseline tests passed cleanly.`);
            this.memory.saveRepoEnvironment(this.owner, this.repo, {
                detectedRunner: runner,
                baselinePassed: true,
                lastTestedAt: new Date().toISOString()
            });
            return { passed: true, runner, output: out.substring(0, 1500) };
        } catch (err: any) {
            const output = (err.stdout || err.stderr || err.message).substring(0, 2000);
            log(`⚠️ Baseline tests finished with non-zero exit. Existing state captured to avoid false regressions.`);
            this.memory.saveRepoEnvironment(this.owner, this.repo, {
                detectedRunner: runner,
                baselinePassed: false,
                lastTestedAt: new Date().toISOString()
            });
            return { passed: false, runner, output };
        }
    }

    /**
     * TypeScript, Go, and Rust suites are too large to execute during a hunt.
     * Confirm the compiler or runtime starts, then let the probe test the hypothesis.
     */
    private runLanguageSmoke(
        profile: ProjectProfile,
        log: (msg: string) => void
    ): { passed: boolean; runner?: string; output: string } {
        const repoEnv = resolveRepoEnv(this.repoPath);
        log(`Detected ${profile.suiteLabel}. Verifying the toolchain instead of the full suite.`);
        if (profile.language === "typescript" && !fs.existsSync(path.join(this.repoPath, "node_modules"))) {
            log("node_modules is missing. Probes can still import this repo's source, but third-party imports will fail until dependencies are installed.");
        }
        if (!profile.smokeCommand) {
            return { passed: true, runner: profile.suiteLabel, output: "No smoke command" };
        }
        log(`Running toolchain check: \`${profile.smokeCommand}\`...`);
        try {
            const out = execSync(profile.smokeCommand, {
                cwd: this.repoPath,
                encoding: "utf-8",
                timeout: profile.smokeTimeoutMs,
                env: { ...repoEnv.env, CARGO_TERM_COLOR: "never" },
                stdio: ["ignore", "pipe", "pipe"],
            });
            log(`✅ ${profile.language} toolchain is usable.`);
            this.memory.saveRepoEnvironment(this.owner, this.repo, {
                detectedRunner: profile.suiteLabel,
                baselinePassed: true,
                lastTestedAt: new Date().toISOString(),
            });
            return { passed: true, runner: profile.suiteLabel, output: out.substring(0, 1500) };
        } catch (err: any) {
            const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").substring(0, 2000);
            log(`⚠️ Toolchain check failed. Probes that need this compiler will be discarded.\n${output.split("\n").slice(-4).join("\n")}`);
            this.memory.saveRepoEnvironment(this.owner, this.repo, {
                detectedRunner: profile.suiteLabel,
                baselinePassed: false,
                lastTestedAt: new Date().toISOString(),
            });
            return { passed: false, runner: profile.suiteLabel, output };
        }
    }

    /**
     * Step 2: Analyzes recent git commits to find high-churn files where bugs cluster.
     */
    public getRecentGitChurn(): GroundingContext {
        const recentCommits: { hash: string; message: string; diffStat: string }[] = [];
        const churnedFilesSet = new Set<string>();

        try {
            const logOut = execSync('git log -n 10 --pretty=format:"%H|%s" --no-merges', {
                cwd: this.repoPath,
                encoding: "utf-8",
                timeout: 10_000
            });

            for (const line of logOut.split("\n")) {
                const [hash, ...rest] = line.split("|");
                const message = rest.join("|").trim();
                if (!hash || !message) continue;

                let diffStat = "";
                try {
                    diffStat = execSync(`git show ${hash} --stat --oneline`, {
                        cwd: this.repoPath,
                        encoding: "utf-8",
                        timeout: 5_000
                    });

                    // Extract modified filenames from diffStat
                    const fileLines = diffStat.split("\n").slice(1);
                    for (const fl of fileLines) {
                        const match = fl.trim().match(/^([^\s|]+)\s*\|/);
                        if (match) {
                            const filename = match[1].trim();
                            if (
                                !filename.startsWith(".") &&
                                !filename.includes("test") &&
                                !filename.includes("docs/")
                            ) {
                                churnedFilesSet.add(filename);
                            }
                        }
                    }
                } catch (e) {}

                recentCommits.push({ hash, message, diffStat: diffStat.substring(0, 500) });
            }
        } catch (e) {}

        return {
            baselinePassed: true,
            recentCommits,
            churnedFiles: Array.from(churnedFilesSet)
        };
    }

    /**
     * Main Hunting Execution Loop
     */
    public async hunt(onLog?: (msg: string) => void): Promise<HuntedBug | null> {
        const log = (msg: string) => {
            console.log(`[BugHunter] ${msg}`);
            if (onLog) onLog(msg);
        };

        log(`Starting deep autonomous bug hunt in ${this.owner}/${this.repo}...`);

        // 1. Establish Baseline Health
        const baseline = await this.runBaselineCheck(onLog);

        // 2. Extract Recent Git Churn
        log("Analyzing recent git commits and modified files to locate fresh, high-churn code...");
        const grounding = this.getRecentGitChurn();
        if (grounding.churnedFiles.length > 0) {
            log(`Identified ${grounding.churnedFiles.length} recently churned files: ${grounding.churnedFiles.slice(0, 5).join(", ")}`);
        }

        // 3. Discover and rank candidate core source files
        let allSourceFiles: string[] = [];
        try {
            const ls = execSync("git ls-files", { cwd: this.repoPath, encoding: "utf-8", timeout: 10_000 });
            allSourceFiles = ls
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => {
                    if (!s) return false;
                    const ext = path.extname(s);
                    const isCode = huntExtensions(this.loadProject().language).includes(ext);
                    const isIgnored =
                        s.startsWith(".") ||
                        s.includes("/.") ||
                        s.toLowerCase().includes("test") ||
                        s.toLowerCase().includes("spec") ||
                        s.includes("vendor/") ||
                        s.includes("dist/") ||
                        s.includes("node_modules/") ||
                        s.startsWith("scripts/") ||
                        s.startsWith("docs/") ||
                        s.startsWith("examples/") ||
                        s.startsWith("benchmarks/") ||
                        s.startsWith("target/") ||
                        s.includes("/target/") ||
                        s.endsWith(".d.ts") ||
                        s.endsWith("__init__.py");
                    return isCode && !isIgnored;
                });
        } catch (e) {
            log("Could not enumerate files.");
            return null;
        }

        if (allSourceFiles.length === 0) {
            log("No eligible source code files found to audit.");
            return null;
        }

        // Rank files: Recently churned files FIRST, followed by utility/parsing/config files
        const highYieldKeywords = ["util", "helper", "color", "split", "format", "config", "parse", "clean", "type", "rule", "model", "match", "transform", "sanitize"];
        const churnSet = new Set(grounding.churnedFiles);

        allSourceFiles.sort((a, b) => {
            const aIsChurn = churnSet.has(a) ? 10 : 0;
            const bIsChurn = churnSet.has(b) ? 10 : 0;
            const aKeyword = highYieldKeywords.some(k => a.toLowerCase().includes(k)) ? 2 : 0;
            const bKeyword = highYieldKeywords.some(k => b.toLowerCase().includes(k)) ? 2 : 0;
            return (bIsChurn + bKeyword) - (aIsChurn + aKeyword);
        });

        // Filter out files that were already probed in previous runs
        const unprobedFiles = allSourceFiles.filter(f => !this.memory.isProbeAlreadyTested(this.owner, this.repo, f));
        const candidateFiles = unprobedFiles.length > 0 ? unprobedFiles : allSourceFiles;

        log(`Ranked ${candidateFiles.length} candidate files. Top targets: ${candidateFiles.slice(0, 5).join(", ")}`);

        // Batch audit: Try up to 4 batches of 2-3 files
        const batchSize = 3;
        const maxBatches = 4;
        const numBatches = Math.min(maxBatches, Math.ceil(candidateFiles.length / batchSize));

        for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
            const batchFiles = candidateFiles.slice(batchIdx * batchSize, (batchIdx + 1) * batchSize);
            log(`[Audit Round ${batchIdx + 1}/${numBatches}] Auditing code in: ${batchFiles.join(", ")}`);

            const language = this.loadProject().language;
            const fileSamples = batchFiles.map((relPath) => {
                const absPath = path.join(this.repoPath, relPath);
                try {
                    const content = fs.readFileSync(absPath, "utf-8");
                    const note = auditNote(language, this.repoPath, relPath, content);
                    return `--- File: ${relPath}${note} ---\n${content.substring(0, 3500)}`;
                } catch (e) {
                    return `--- File: ${relPath} (unreadable) ---`;
                }
            }).join("\n\n");

            const recentCommitsSummary = grounding.recentCommits.slice(0, 5).map(c => `- ${c.hash.substring(0, 7)}: ${c.message}`).join("\n");
            const focusedLanguage = language === "typescript" || language === "go" || language === "rust";
            const outputFormat = `
OUTPUT FORMAT (exact JSON only, no markdown wrapping, no extra text):
{
  "title": "Conventional Commit title",
  "archetype": "Type & Nil Panics | Empty Collection Indexing | Boolean Fallback Inversion | In-Place Mutation",
  "targetFile": "relative/path/to/the file under test",
  "explanation": "Concrete explanation of the root cause and the minimal fix",
  "probeCode": "source of the probe",
  "probeFileName": "path required by the task"
}`;
            const taskSection = focusedLanguage
                ? `${probeInstructions(language, this.repoPath, batchFiles)}\n${outputFormat}`
                : `TASK:
Audit the provided code. Look for a realistic function call with plausible inputs (e.g. passing None, missing optional parameters, empty collections, or unexpected types) that crashes with an unhandled exception.
Write a standalone script in the same language. It is executed directly (python -P <file> for Python) from the repository root and must finish in under 5 seconds.
- Import the public package (from prefect.module import fn). Package roots are already on PYTHONPATH.
- Do NOT modify sys.path. Never put a package interior such as src/<package> on the path — that shadows the stdlib (types, functools, logging) and the probe is discarded as an environment failure.
- Do NOT use pytest, fixtures, conftest, databases, cloud services, or network calls.
- Do NOT catch ImportError or ModuleNotFoundError. A printed message such as "Could not import" or "is installed" is not the bug.
- When the bug is present the process must crash with a traceback (ValidationError, AttributeError, TypeError, KeyError, IndexError, or ValueError). When the bug is absent it must exit 0.
${outputFormat}`;

            const hypothesisPrompt = `
You are an expert security researcher and software engineer finding latent bugs in open-source projects (Breken AI standard).

### 7 High-Yield Bug Archetypes:
1. Type & Nil Panics: Passing valid/common edge-case types (None/null, empty strings, numbers, dicts, instances) to functions that fail to validate input and raise unhandled AttributeError or TypeError.
2. In-Place State Mutation: Modifying incoming arguments, options dictionaries, or lists in-place instead of making a copy.
3. Boolean / Fallback Inversion: \`if not val:\` or \`if val:\` where \`val === 0\` or \`val is False\` or \`""\` is valid input but gets incorrectly overridden.
4. Empty Collection / Missing Key Indexing: Accessing \`arr[0]\` or \`dict[key]\` without boundary or existence check, causing IndexError or KeyError.
5. Path & Delimiter Splitting: String splits on colons or slashes that drop components or fail on empty segments.
6. Type Coercion / Enum Fallback: Converting input to enum or string where passing None or unexpected values triggers ValueError/KeyError instead of default.
7. Unchecked Return Values: Functions returning None on failure which callers immediately dereference.

### Recent Commit Context:
${recentCommitsSummary || "No recent commits found."}

### Source Code Samples for this Round:
${fileSamples}

${taskSection}
`;

            let importFeedback = "";
            for (let attempt = 1; attempt <= 2; attempt++) {
                const retryHint = focusedLanguage
                    ? "Follow the probe file name, package, and import rules exactly."
                    : "Do not modify sys.path. Import the public package only.";
                const prompt = importFeedback
                    ? `${hypothesisPrompt}\n\nThe previous probe failed before it could reach the hypothesis. Rewrite it and output JSON again.\n${retryHint}\nFailure:\n${importFeedback.slice(0, 1500)}\n`
                    : hypothesisPrompt;
                try {
                    const { text } = await generateText({
                        model: MODEL,
                        prompt,
                        system: "You are an elite Bug Hunter. Output strictly valid JSON only.",
                    });

                    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
                    const parsed = JSON.parse(cleaned);
                    const requestedName = typeof parsed.probeFileName === "string" ? parsed.probeFileName : "";
                    const probeFileName = focusedLanguage
                        ? resolveProbeFile(language, this.repoPath, String(parsed.targetFile || ""), requestedName)
                        : (requestedName || "tests/test_hunted_probe.py");

                    if (!parsed.targetFile || !parsed.probeCode || !probeFileName || probeFileName.includes("..") || path.isAbsolute(probeFileName)) {
                        log(`Round ${batchIdx + 1}: Hypothesis did not yield structured probe. Continuing...`);
                        break;
                    }

                    log(`Round ${batchIdx + 1}: Hypothesis Formulated: "${parsed.title}" in ${parsed.targetFile}`);
                    log(`Writing probe test file to ${probeFileName}...`);

                    const probeCode = String(parsed.probeCode).replace(/^```[a-z]*\n/i, "").replace(/\n```$/, "");
                    const probeAbsPath = path.join(this.repoPath, probeFileName);
                    fs.mkdirSync(path.dirname(probeAbsPath), { recursive: true });
                    fs.writeFileSync(probeAbsPath, probeCode, "utf-8");

                    const repoEnv = resolveRepoEnv(this.repoPath);
                    const ext = path.extname(probeFileName);
                    const probeCmd = focusedLanguage
                        ? buildProbeCommand(language, this.repoPath, String(parsed.targetFile))
                        : ext === ".py" || ext === ""
                            ? pythonScriptCommand(probeFileName, repoEnv.pythonBin)
                            : normalizeCommandWithVenv(parsed.probeCommand || `node ${probeFileName}`, repoEnv.pythonBin);
                    if (!probeCmd) {
                        log(`Round ${batchIdx + 1}: No probe command for ${language}. Continuing...`);
                        break;
                    }

                    log(`Executing probe command: ${probeCmd}`);
                    let failureTrace = "";

                    try {
                        execSync(probeCmd, {
                            cwd: this.repoPath,
                            encoding: "utf-8",
                            timeout: commandTimeoutMs(probeCmd, 30_000),
                            env: { ...repoEnv.env, CARGO_TERM_COLOR: "never" },
                            stdio: ["ignore", "pipe", "pipe"],
                        });
                        log(`Round ${batchIdx + 1}: Probe test passed (exit 0). Hypothesis discarded (Zero False Positives).`);
                        this.memory.recordProbeHistory(this.owner, this.repo, parsed.targetFile);
                        try { fs.unlinkSync(probeAbsPath); } catch (e) {}
                        break;
                    } catch (err: any) {
                        failureTrace = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").substring(0, 3000);
                    }

                    const isEnvironmentalError = isEnvironmentalProbeFailure(
                        focusedLanguage ? language : "python",
                        failureTrace,
                        probeFileName
                    );

                    if (isEnvironmentalError) {
                        const lastTraceLine = failureTrace.split("\n").filter((l: string) => l.trim()).slice(-2).join(" | ");
                        const shadowed = failureTrace.includes("partially initialized module") && failureTrace.includes(this.repoPath);
                        log(`Round ${batchIdx + 1}: Probe failed due to environment/import${shadowed ? " (project module shadowed the stdlib)" : ""}: ${lastTraceLine}`);
                        try { fs.unlinkSync(probeAbsPath); } catch (e) {}
                        if (attempt === 1) {
                            importFeedback = failureTrace;
                            log(`Round ${batchIdx + 1}: Asking for a corrected standalone probe.`);
                            continue;
                        }
                        break;
                    }

                    log(`🎯 PROBE FAILED AS HYPOTHESIZED! Real latent bug confirmed!\n${failureTrace.substring(0, 400)}`);
                    this.memory.recordProbeHistory(this.owner, this.repo, parsed.targetFile, {
                        title: parsed.title,
                        targetFile: parsed.targetFile
                    });

                    return {
                        title: parsed.title,
                        description: parsed.explanation,
                        archetype: parsed.archetype,
                        targetFile: parsed.targetFile,
                        probeFilePath: probeFileName,
                        probeCommand: probeCmd,
                        failureTrace,
                        sourceType: "hunted" as const,
                    };
                } catch (cycleErr: any) {
                    if (attempt === 1 && isJsonResponseError(String(cycleErr.message || ""))) {
                        importFeedback = `The previous response was not valid JSON (${cycleErr.message}). Put the probe source in probeCode as a JSON string with escaped quotes and backslashes. Output JSON only.`;
                        log(`Round ${batchIdx + 1}: Response was not valid JSON. Asking again.`);
                        continue;
                    }
                    log(`Round ${batchIdx + 1} error: ${cycleErr.message}`);
                    break;
                }
            }
        }

        log("Hunting cycles finished. No verifiable latent bug confirmed across audited batches.");
        return null;
    }
}
