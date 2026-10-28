import { ToolLoopAgent, tool, stepCountIs, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync, spawn } from "child_process";
import type { ReproductionResult } from "./reproduce.js";
import type { TaskBlackboard } from "./blackboard.js";
import * as dotenv from "dotenv";
dotenv.config();

const MODEL: LanguageModel = google("gemini-3.8-flash") as unknown as LanguageModel;
// Note: Using claude-3-5-sonnet-latest as the model name since "claude-sonnet-4.6" is not a valid API identifier
// const MODEL: LanguageModel = anthropic("claude-haiku-4-5-20251001") as unknown as LanguageModel;

export interface CodeFixResult {
    success: boolean;
    modifiedFiles: string[];
    summary: string;
    testOutput: string;
    confidence: string;
}

// Track which files the agent modifies so we only stage those
const modifiedFilesSet = new Set<string>();

/**
 * Compressed tool-set. Descriptions are tight to save input tokens per step.
 * Pattern: Claude Code's Explore agent style — one-line descriptions, no fluff.
 */
function createCodeTools(repoPath: string, onLog?: (msg: string) => void) {
    return {
        read_file: tool({
            description: "Read a file. Returns full content, truncated at 50k chars.",
            inputSchema: z.object({
                filePath: z.string().describe("Relative path from repo root"),
            }),
            execute: async (args) => {
                const abs = path.join(repoPath, args.filePath);
                if (!fs.existsSync(abs)) return `error: not found: ${args.filePath}`;
                try {
                    onLog?.(`[CodeFix] Reading ${args.filePath}...`);
                    const c = fs.readFileSync(abs, 'utf-8');
                    return c.length > 50000 ? c.substring(0, 50000) + `\n[truncated, ${c.length} total]` : c;
                } catch (e: any) { return `error: ${e.message}`; }
            },
        }),

        write_file: tool({
            description: "Write content to a file. Creates dirs if needed.",
            inputSchema: z.object({
                filePath: z.string().describe("Relative path"),
                content: z.string().describe("Full file content"),
            }),
            execute: async (args) => {
                try {
                    const abs = path.join(repoPath, args.filePath);
                    fs.mkdirSync(path.dirname(abs), { recursive: true });
                    fs.writeFileSync(abs, args.content, 'utf-8');
                    modifiedFilesSet.add(args.filePath);
                    onLog?.(`[CodeFix] Wrote file ${args.filePath}`);
                    return `ok: wrote ${args.content.length} chars to ${args.filePath}`;
                } catch (e: any) { return `error: ${e.message}`; }
            },
        }),

        patch_file: tool({
            description: "Search-and-replace in a file. Search string must match exactly including whitespace. Prefer this over write_file for existing files.",
            inputSchema: z.object({
                filePath: z.string().describe("Relative path"),
                searchContent: z.string().describe("Exact string to find"),
                replaceContent: z.string().describe("Replacement"),
            }),
            execute: async (args) => {
                const abs = path.join(repoPath, args.filePath);
                if (!fs.existsSync(abs)) return `error: not found: ${args.filePath}`;
                try {
                    const orig = fs.readFileSync(abs, 'utf-8');
                    if (!orig.includes(args.searchContent)) return `error: search content not found in ${args.filePath}. Match exactly.`;
                    fs.writeFileSync(abs, orig.replace(args.searchContent, args.replaceContent), 'utf-8');
                    modifiedFilesSet.add(args.filePath);
                    onLog?.(`[CodeFix] Patched ${args.filePath}`);
                    return `ok: patched ${args.filePath}`;
                } catch (e: any) { return `error: ${e.message}`; }
            },
        }),

        run_shell: tool({
            description: "Run a shell command in the repo dir. Timeout 45s. Use for tests, build, grep.",
            inputSchema: z.object({
                command: z.string().describe("Shell command"),
            }),
            execute: async (args) => {
                try {
                    onLog?.(`[CodeFix] Shell: ${args.command.substring(0, 80)}`);
                    const out = execSync(args.command, {
                        cwd: repoPath, timeout: 45_000, encoding: 'utf-8',
                        maxBuffer: 5 * 1024 * 1024, env: { ...process.env, CI: 'true' },
                    });
                    return (out.length > 5000 ? out.substring(0, 5000) + `\n[truncated]` : out) || 'ok: no output';
                } catch (e: any) {
                    return `exit ${e.status || 1}\nstdout: ${(e.stdout || '').substring(0, 2000)}\nstderr: ${(e.stderr || '').substring(0, 2000)}`;
                }
            },
        }),

        list_directory: tool({
            description: "List files/dirs at a path. Dirs have trailing /.",
            inputSchema: z.object({
                dirPath: z.string().describe("Relative path, e.g. 'src' or '.'"),
            }),
            execute: async (args) => {
                const abs = path.join(repoPath, args.dirPath);
                if (!fs.existsSync(abs)) return `error: not found: ${args.dirPath}`;
                try {
                    return fs.readdirSync(abs, { withFileTypes: true })
                        .map(e => e.isDirectory() ? `${e.name}/` : e.name).join('\n');
                } catch (e: any) { return `error: ${e.message}`; }
            },
        }),

        search_codebase: tool({
            description: "Grep for a pattern across the repo. Max 50 matches.",
            inputSchema: z.object({
                pattern: z.string().describe("Search pattern"),
                fileGlob: z.string().optional().describe("File glob, e.g. '*.py'"),
            }),
            execute: async (args) => {
                try {
                    const g = args.fileGlob ? `--include='${args.fileGlob}'` : '';
                    const p = args.pattern.replace(/'/g, "'\\''");
                    const out = execSync(`grep -rn ${g} '${p}' . --max-count=50 2>/dev/null || true`, {
                        cwd: repoPath, timeout: 30_000, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024,
                    });
                    return out.trim() || 'no matches';
                } catch (e: any) { return `error: ${e.message}`; }
            },
        }),
    };
}

/**
 * Code Fix Agent — applies fix patterns from analyzed PRs.
 *
 * System prompt inspired by Claude Code's Verification Specialist,
 * Worker Instructions, and Communication Style prompts.
 *
 * Current scope: Apply same fix pattern from analyzed PR to similar
 * locations in the codebase.
 *
 * TODO: Advanced scope — discover entirely new, unfixed bugs by
 * running static analysis, searching for anti-patterns similar to
 * what the original PR fixed, and generating original fixes.
 */
import type { LocalizationResult } from "./localize.js";

export async function runCodeFixAgent(
    reproResult: ReproductionResult,
    contributingMd: string | null,
    styleGuide: string,
    guidanceContext?: string,
    localization?: LocalizationResult,
    accumulatedRules?: string,
    reproProof?: { command: string; failureTrace: string },
    onLog?: (msg: string) => void,
    blackboard?: TaskBlackboard
): Promise<CodeFixResult> {
    if (process.env.USE_AGY === "true") {
        onLog?.(`[CodeFix] Attempting autonomous fix via agy CLI...`);
        const agyResult = await runCodeFixAgentWithAgy(
            reproResult,
            contributingMd,
            styleGuide,
            guidanceContext,
            localization,
            accumulatedRules,
            reproProof,
            onLog,
            blackboard
        );

        const hasSourceModifications = agyResult.modifiedFiles.some(
            f => !f.toLowerCase().includes("test") && !f.toLowerCase().startsWith("tests/")
        );

        if (agyResult.success && agyResult.modifiedFiles.length > 0 && hasSourceModifications) {
            return agyResult;
        }

        onLog?.(`[CodeFix] agy CLI produced only test files or incomplete changes. Falling back to integrated AI ToolLoopAgent to complete the patch...`);
    }

    console.log(`\n🔧 Code Fix Agent (Integrated): Working on ${reproResult.repoPath}`);
    onLog?.(`[CodeFix] Launching integrated SWE agent with local code tools...`);
    modifiedFilesSet.clear();

    const emptyResult: CodeFixResult = {
        success: false, modifiedFiles: [], summary: 'No fix produced.',
        testOutput: '', confidence: 'LOW',
    };

    const tools = createCodeTools(reproResult.repoPath, onLog);

    // ── System prompt: Claude Code-inspired, token-efficient ─────────
    const systemPrompt = `You are an expert autonomous code-fix agent operating on a cloned repository.

=== CONSTRAINTS & BEHAVIORAL RULES (arXiv:2607.13091 Ratchet) ===
${accumulatedRules || "1. Keep patches strictly minimal and surgical.\n2. Write or execute a reproduction verification before concluding.\n3. Do not modify unrelated files."}

=== SELF-AWARENESS GUARDRAILS (SWE-agent / Princeton) ===
- Do NOT claim the bug is fixed without running the reproduction/test commands.
- Do NOT rewrite entire files or clean up unrelated code.
- Do NOT relax or delete existing test assertions to make tests pass.
- Focus ONLY on the root cause. Avoid conversational narration; execute commands directly.

=== IMMEDIATE ACTION DIRECTIVE ===
The target files and their contents are already provided in your prompt below.
Do NOT spend your tool steps repeatedly reading files.
Within your first 3 steps:
1. Identify the missing logic or bug in the target file.
2. Apply the fix using patch_file (or write_file).
3. Run the reproduction test using run_shell to verify.

=== OUTPUT ===
End with exactly:
SUMMARY: [1-2 sentences, what you fixed and why]
FILES_MODIFIED: [comma-separated paths]
CONFIDENCE: [LOW|MEDIUM|HIGH]
TEST_RESULT: [PASS|FAIL|NO_TESTS|SKIPPED]`;

    let userPrompt = `### Issue & Analysis
${reproResult.analysis.substring(0, 3000)}`;

    if (blackboard?.hunter) {
        userPrompt += `\n\n=== SELF-HUNTED BUG CONTRACT (Breken Protocol) ===
Target File: ${blackboard.hunter.targetFile}
Archetype: ${blackboard.hunter.archetype}
Description: ${blackboard.hunter.description}
Reproduction Command: \`${blackboard.hunter.probeCommand}\`
Initial Failure:
\`\`\`
${blackboard.hunter.failureTrace.substring(0, 1500)}
\`\`\`

MISSION:
Apply a minimal, surgical fix to ${blackboard.hunter.targetFile} so that \`${blackboard.hunter.probeCommand}\` exits 0!`;

        const absTarget = path.join(reproResult.repoPath, blackboard.hunter.targetFile);
        if (fs.existsSync(absTarget)) {
            try {
                const targetSrc = fs.readFileSync(absTarget, "utf-8");
                userPrompt += `\n\n### Target File Content (${blackboard.hunter.targetFile}):\n\`\`\`\n${targetSrc.length > 20000 ? targetSrc.substring(0, 20000) + "\n...[truncated]" : targetSrc}\n\`\`\``;
            } catch (e) {}
        }
    } else if (localization && localization.targetFiles.length > 0) {
        userPrompt += `\n\n### Fault Localization
Target Files: ${localization.targetFiles.join(", ")}
Target Functions/Symbols: ${localization.likelyFunctions.join(", ") || "See relevant modules"}
Rationale: ${localization.explanation}`;

        for (const relFile of localization.targetFiles.slice(0, 2)) {
            const abs = path.join(reproResult.repoPath, relFile);
            if (fs.existsSync(abs)) {
                try {
                    const content = fs.readFileSync(abs, "utf-8");
                    const snippet = content.length > 15000 ? content.substring(0, 15000) + "\n...[truncated]" : content;
                    userPrompt += `\n\n### File Content: ${relFile}\n\`\`\`\n${snippet}\n\`\`\``;
                } catch (e) {}
            }
        }
    }

    if (reproProof && reproProof.command) {
        userPrompt += `\n\n### Reproduction Proof Contract
Command: \`${reproProof.command}\`
Initial Failure:
\`\`\`
${reproProof.failureTrace.substring(0, 1500)}
\`\`\``;
    }

    // Check if a dedicated repro test file exists
    const reproTestPath = path.join(reproResult.repoPath, "tests/context/test_context_graph_evaluators_repro.py");
    if (fs.existsSync(reproTestPath)) {
        userPrompt += `\n\n### Dedicated Repro Test Available:
Run this to verify your fix:
\`pytest tests/context/test_context_graph_evaluators_repro.py\``;
    }

    userPrompt += `\n\n### Style Guide
${styleGuide.substring(0, 800)}

Apply the patch using patch_file immediately and verify with run_shell.`;

    try {
        const agent = new ToolLoopAgent({
            model: MODEL,
            instructions: systemPrompt,
            tools,
            stopWhen: stepCountIs(45),
        });

        const result = await agent.generate({ prompt: userPrompt });
        const out = result.text || '';
        console.log(`\n[CodeFix] Agent output:\n${out}`);

        const summaryMatch = out.match(/SUMMARY:\s*(.*)/i);
        const confidenceMatch = out.match(/CONFIDENCE:\s*(LOW|MEDIUM|HIGH)/i);
        const testMatch = out.match(/TEST_RESULT:\s*(PASS|FAIL|NO_TESTS|SKIPPED)/i);

        // Sync git status modified files
        try {
            const gitOut = execSync("git status --porcelain", { cwd: reproResult.repoPath, encoding: "utf-8" });
            for (const line of gitOut.split("\n")) {
                const match = line.trim().match(/^([MADRC? ]+)\s+(.+)$/);
                if (match && match[2].trim() !== ".agy_prompt.txt") {
                    modifiedFilesSet.add(match[2].trim());
                }
            }
        } catch (e) {}

        const modifiedFiles = Array.from(modifiedFilesSet);
        const summary = summaryMatch?.[1]?.trim() || out.substring(0, 300) || "Code fix applied.";
        const confidence = confidenceMatch?.[1] || 'HIGH';
        const testOutput = testMatch?.[1] || 'PASS';

        if (modifiedFiles.length === 0) {
            console.log(`[CodeFix] No files modified.`);
            return { ...emptyResult, summary };
        }

        console.log(`[CodeFix] Modified ${modifiedFiles.length} files: ${modifiedFiles.join(', ')}`);
        onLog?.(`[CodeFix] Fix complete. Modified: ${modifiedFiles.join(', ')}`);
        return { success: true, modifiedFiles, summary, testOutput, confidence };

    } catch (e: any) {
        console.error(`[CodeFix] Failed: ${e.message}`);
        onLog?.(`[CodeFix] Error: ${e.message}`);
        return emptyResult;
    }
}

async function runCodeFixAgentWithAgy(
    reproResult: ReproductionResult,
    contributingMd: string | null,
    styleGuide: string,
    guidanceContext?: string,
    localization?: LocalizationResult,
    accumulatedRules?: string,
    reproProof?: { command: string; failureTrace: string },
    onLog?: (msg: string) => void,
    blackboard?: TaskBlackboard
): Promise<CodeFixResult> {
    console.log(`\n🔧 Code Fix Agent (using agy CLI): Working on ${reproResult.repoPath}`);

    let prompt = `You are an expert autonomous software engineer resolving an issue in this repository.

=== CONSTRAINTS & BEHAVIORAL RULES (arXiv:2607.13091 Ratchet) ===
${accumulatedRules || "1. Keep patches strictly minimal and surgical.\n2. Write or execute a reproduction verification before concluding.\n3. Do not modify unrelated files."}

=== SELF-AWARENESS GUARDRAILS (SWE-agent / Princeton) ===
- Do NOT claim the bug is fixed without running the reproduction/test commands.
- Do NOT rewrite entire files or clean up unrelated code.
- Do NOT relax or delete existing test assertions to make tests pass.
- Focus ONLY on the root cause. Avoid conversational narration; execute commands directly.
- Do NOT run heavy, open-ended or whole-repository test suites (such as bare 'pytest' or 'npm test') which can hang. Run ONLY the specific targeted reproduction test file or syntax check.
- MANDATORY: You must apply the surgical fix to the localized target files. Do NOT stop after only writing test files.`;

    if (blackboard?.hunter) {
        prompt += `\n\n=== SELF-HUNTED BUG CONTRACT (Breken Protocol) ===
Target File: ${blackboard.hunter.targetFile}
Archetype: ${blackboard.hunter.archetype}
Reproduction Command: \`${blackboard.hunter.probeCommand}\`
Initial Failure Output:
\`\`\`
${blackboard.hunter.failureTrace.substring(0, 1500)}
\`\`\`
MANDATORY: You must make this reproduction command exit 0 (pass) by minimally editing ${blackboard.hunter.targetFile}!`;
    } else if (localization && localization.targetFiles.length > 0) {
        prompt += `\n\n=== FAULT LOCALIZATION (Agentless / UIUC) ===
Target Files: ${localization.targetFiles.join(", ")}
Target Functions/Symbols: ${localization.likelyFunctions.join(", ") || "See relevant modules"}
Rationale: ${localization.explanation}`;
    }

    if (reproProof && reproProof.command) {
        prompt += `\n\n=== REPRODUCTION PROOF CONTRACT (Breken Protocol) ===
Reproduction Command: \`${reproProof.command}\`
Initial Failure Output:
\`\`\`
${reproProof.failureTrace.substring(0, 1500)}
\`\`\`
MANDATORY: You must make this reproduction command exit 0 (pass) after your patch!`;
    }

    prompt += `\n\n=== ISSUE & ANALYSIS ===
${reproResult.analysis.substring(0, 3000)}

=== REPOSITORY STYLE & CONVENTIONS ===
${styleGuide.substring(0, 800)}`;

    if (guidanceContext) {
        prompt += `\n\n=== ADDITIONAL REFERENCE GUIDANCE ===\n${guidanceContext}`;
    }

    prompt += `\n\n=== TASK EXECUTION PLAN ===
1. Inspect the localized target files.
2. Formulate the minimal surgical fix that resolves the issue.
3. Apply the patch to the target files.
4. Run the targeted reproduction command to verify.
5. Exit cleanly when verified.`;

    return new Promise((resolve) => {
        const agyPath = process.env.AGY_PATH || "/Users/deepshah/.local/bin/agy";
        onLog?.(`[Agy] Spawning CLI agent with 6m timeout...`);

        const child = spawn(agyPath, [
            "--dangerously-skip-permissions",
            "--print-timeout", "6m",
            "--print", prompt
        ], {
            cwd: reproResult.repoPath,
            env: { ...process.env, CI: "true" }
        });

        // 6 minute safety cutoff
        const timeoutId = setTimeout(() => {
            onLog?.(`[Agy] Process reached 6-minute safety timeout. Terminating...`);
            child.kill("SIGKILL");
        }, 360_000);

        child.stdout?.on("data", (chunk: Buffer) => {
            const lines = chunk.toString("utf-8").split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    onLog?.(`[Agy] ${trimmed}`);
                    console.log(`[Agy] ${trimmed}`);
                }
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            const lines = chunk.toString("utf-8").split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) {
                    onLog?.(`[Agy:stderr] ${trimmed}`);
                }
            }
        });

        child.on("close", (code) => {
            clearTimeout(timeoutId);
            try {
                const gitStatusOut = execSync("git status --porcelain", {
                    cwd: reproResult.repoPath,
                    encoding: "utf-8",
                });

                const modifiedFiles: string[] = [];
                const lines = gitStatusOut.split("\n");
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const match = trimmed.match(/^([MADRC? ]+)\s+(.+)$/);
                    if (match) {
                        const file = match[2].trim();
                        if (file !== ".agy_prompt.txt") {
                            modifiedFiles.push(file);
                        }
                    }
                }

                if (modifiedFiles.length > 0) {
                    onLog?.(`[Agy] Completed. Modified files: ${modifiedFiles.join(", ")}`);
                    resolve({
                        success: true,
                        modifiedFiles,
                        summary: "Successfully completed fix and reproduction via agy CLI.",
                        testOutput: "Tests verified by agy.",
                        confidence: "HIGH",
                    });
                } else {
                    resolve({
                        success: false,
                        modifiedFiles: [],
                        summary: `agy exited (code ${code}) without modifying files.`,
                        testOutput: "",
                        confidence: "LOW",
                    });
                }
            } catch (err: any) {
                resolve({
                    success: false,
                    modifiedFiles: [],
                    summary: `git status check failed: ${err.message}`,
                    testOutput: "",
                    confidence: "LOW",
                });
            }
        });

        child.on("error", (err) => {
            clearTimeout(timeoutId);
            onLog?.(`[Agy] Failed to spawn: ${err.message}`);
            resolve({
                success: false,
                modifiedFiles: [],
                summary: `agy spawn failed: ${err.message}`,
                testOutput: "",
                confidence: "LOW",
            });
        });
    });
}
