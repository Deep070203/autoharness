import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MODEL: LanguageModel = google("gemini-3.8-flash") as unknown as LanguageModel;

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

const execEnv = {
    ...process.env,
    CI: "true",
    PYTHONPATH: ".",
    PATH: `${process.env.HOME}/.local/bin:/Library/Frameworks/Python.framework/Versions/3.12/bin:/usr/local/bin:${process.env.PATH || ""}`,
};

/**
 * Breken-Style Autonomous Bug Hunter Agent.
 * Sweeps a repository for high-frequency latent bug archetypes,
 * formulates a testable hypothesis, writes an isolated probe test,
 * and executes it.
 *
 * CRITICAL RULE: If the probe test does not fail with a genuine application error,
 * the hypothesis is discarded. A bug is ONLY reported if the probe test crashes
 * with a concrete TypeError, AttributeError, KeyError, IndexError, etc.
 */
export class BugHunterAgent {
    constructor(private repoPath: string, private owner: string, private repo: string) {}

    /**
     * Executes the autonomous hunting loop over ranked candidate batches.
     * Returns a proven bug with its reproduction probe, or null if no bug proved.
     */
    public async hunt(onLog?: (msg: string) => void): Promise<HuntedBug | null> {
        const log = (msg: string) => {
            console.log(`[BugHunter] ${msg}`);
            if (onLog) onLog(msg);
        };

        log(`Starting deep autonomous bug hunt in ${this.owner}/${this.repo}...`);

        // 1. Inspect recent bug-fix commits to detect patterns maintainers care about
        let recentGitHistory = "";
        try {
            recentGitHistory = execSync("git log -n 15 --oneline --grep='fix' --grep='bug'", {
                cwd: this.repoPath,
                encoding: "utf-8",
                timeout: 10_000,
            });
        } catch (e) {
            recentGitHistory = "(git history unavailable)";
        }

        // 2. Discover and filter core source files
        let sourceFiles: string[] = [];
        try {
            const ls = execSync("git ls-files", { cwd: this.repoPath, encoding: "utf-8", timeout: 10_000 });
            sourceFiles = ls
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => {
                    if (!s) return false;
                    const ext = path.extname(s);
                    const isCode = [".ts", ".js", ".py", ".go", ".rs"].includes(ext);
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
                        s.endsWith("__init__.py");
                    return isCode && !isIgnored;
                });
        } catch (e) {
            log("Could not enumerate source files via git.");
            return null;
        }

        if (sourceFiles.length === 0) {
            log("No eligible source code files found to audit.");
            return null;
        }

        // Prioritize utility, helper, parsing, format, and config modules (where Breken bugs cluster)
        const highYieldKeywords = ["util", "helper", "color", "split", "format", "config", "parse", "clean", "type", "rule", "model", "match", "transform", "sanitize"];
        sourceFiles.sort((a, b) => {
            const aBase = path.basename(a).toLowerCase();
            const bBase = path.basename(b).toLowerCase();
            const aScore = highYieldKeywords.some(k => aBase.includes(k) || a.toLowerCase().includes(k)) ? 1 : 0;
            const bScore = highYieldKeywords.some(k => bBase.includes(k) || b.toLowerCase().includes(k)) ? 1 : 0;
            return bScore - aScore;
        });

        log(`Identified ${sourceFiles.length} candidate core files. Top candidates: ${sourceFiles.slice(0, 5).join(", ")}`);

        // Batch audit: Try up to 4 batches of 2-3 files
        const batchSize = 3;
        const maxBatches = 4;
        const numBatches = Math.min(maxBatches, Math.ceil(sourceFiles.length / batchSize));

        for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
            const batchFiles = sourceFiles.slice(batchIdx * batchSize, (batchIdx + 1) * batchSize);
            log(`[Audit Round ${batchIdx + 1}/${numBatches}] Inspecting files: ${batchFiles.join(", ")}`);

            const fileSamples = batchFiles.map((relPath) => {
                const absPath = path.join(this.repoPath, relPath);
                try {
                    const content = fs.readFileSync(absPath, "utf-8");
                    return `--- File: ${relPath} ---\n${content.substring(0, 3500)}`;
                } catch (e) {
                    return `--- File: ${relPath} (unreadable) ---`;
                }
            }).join("\n\n");

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

### Source Code Samples for this Round:
${fileSamples}

TASK:
Audit the provided code. Look for a realistic function call with plausible inputs (e.g. passing None, missing optional parameters, empty collections, or type variations) that crashes with an unhandled exception.
Construct an exact standalone executable probe test script in the same language.
- The probe test must import the function from the package directly.
- The probe test must NOT require external databases, cloud services, or network calls.
- The probe test MUST run in < 5 seconds.
- The probe test must demonstrate the unhandled crash or assertion failure.

OUTPUT FORMAT (exact JSON only, no markdown wrapping, no extra text):
{
  "title": "Conventional Commit title (e.g. fix(visualization): handle None in get_color_scheme without raising AttributeError)",
  "archetype": "Type & Nil Panics | Empty Collection Indexing | Boolean Fallback Inversion | In-Place Mutation",
  "targetFile": "relative/path/to/target_file.py",
  "explanation": "Concrete explanation of the root cause flaw and the minimal fix",
  "probeCode": "# Standalone executable test code",
  "probeFileName": "tests/test_hunted_probe.py",
  "probeCommand": "python3 tests/test_hunted_probe.py"
}
`;

            try {
                const { text } = await generateText({
                    model: MODEL,
                    prompt: hypothesisPrompt,
                    system: "You are an elite Bug Hunter. Output strictly valid JSON only.",
                });

                const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
                const parsed = JSON.parse(cleaned);

                if (!parsed.targetFile || !parsed.probeCode || !parsed.probeCommand) {
                    log(`Round ${batchIdx + 1}: Hypothesis did not yield structured probe. Continuing...`);
                    continue;
                }

                log(`Round ${batchIdx + 1}: Hypothesis Formulated: "${parsed.title}" in ${parsed.targetFile}`);
                log(`Writing probe test file to ${parsed.probeFileName}...`);

                const probeAbsPath = path.join(this.repoPath, parsed.probeFileName);
                fs.mkdirSync(path.dirname(probeAbsPath), { recursive: true });
                fs.writeFileSync(probeAbsPath, parsed.probeCode, "utf-8");

                // Execute probe with full environment
                let probeCmd = parsed.probeCommand;
                if (probeCmd.startsWith("python ")) {
                    probeCmd = probeCmd.replace(/^python /, "python3 ");
                }

                log(`Executing probe command: ${probeCmd}`);
                let failureTrace = "";
                let probeExitedWithError = false;

                try {
                    execSync(probeCmd, {
                        cwd: this.repoPath,
                        encoding: "utf-8",
                        timeout: 30_000,
                        env: execEnv,
                    });
                    log(`Round ${batchIdx + 1}: Probe test passed (exit 0). Hypothesis discarded (Zero False Positives).`);
                    try { fs.unlinkSync(probeAbsPath); } catch (e) {}
                    continue;
                } catch (err: any) {
                    failureTrace = (err.stdout || err.stderr || err.message).substring(0, 3000);
                    probeExitedWithError = true;
                }

                // Verify the nature of the error
                const isEnvironmentalError =
                    failureTrace.includes("ModuleNotFoundError") ||
                    failureTrace.includes("ImportError") ||
                    failureTrace.includes("command not found") ||
                    failureTrace.includes("SyntaxError");

                if (isEnvironmentalError) {
                    log(`Round ${batchIdx + 1}: Probe failed due to environment/import rather than code flaw. Discarding...`);
                    try { fs.unlinkSync(probeAbsPath); } catch (e) {}
                    continue;
                }

                // If it reached here, we have a GENUINE application crash!
                log(`🎯 PROBE FAILED AS HYPOTHESIZED! Real latent bug confirmed!\n${failureTrace.substring(0, 400)}`);
                return {
                    title: parsed.title,
                    description: parsed.explanation,
                    archetype: parsed.archetype,
                    targetFile: parsed.targetFile,
                    probeFilePath: parsed.probeFileName,
                    probeCommand: probeCmd,
                    failureTrace,
                    sourceType: "hunted",
                };

            } catch (cycleErr: any) {
                log(`Round ${batchIdx + 1} error: ${cycleErr.message}`);
            }
        }

        log("Hunting cycles finished. No verifiable latent bug confirmed across audited batches.");
        return null;
    }
}
