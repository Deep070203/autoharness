import { ToolLoopAgent, tool, stepCountIs, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { ReproductionResult } from "./reproduce.js";

// const MODEL: LanguageModel = google("gemini-2.5-pro") as unknown as LanguageModel;
// Note: Using claude-3-5-sonnet-latest as the model name since "claude-sonnet-4.6" is not a valid API identifier
const MODEL: LanguageModel = anthropic("claude-haiku-4-5-20251001") as unknown as LanguageModel;

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
function createCodeTools(repoPath: string) {
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
                    return `ok: patched ${args.filePath}`;
                } catch (e: any) { return `error: ${e.message}`; }
            },
        }),

        run_shell: tool({
            description: "Run a shell command in the repo dir. Timeout 60s. Use for tests, build, grep.",
            inputSchema: z.object({
                command: z.string().describe("Shell command"),
            }),
            execute: async (args) => {
                try {
                    const out = execSync(args.command, {
                        cwd: repoPath, timeout: 60_000, encoding: 'utf-8',
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
export async function runCodeFixAgent(
    reproResult: ReproductionResult,
    contributingMd: string | null,
    styleGuide: string,
): Promise<CodeFixResult> {
    console.log(`\n🔧 Code Fix Agent: Working on ${reproResult.repoPath}`);
    modifiedFilesSet.clear();

    const emptyResult: CodeFixResult = {
        success: false, modifiedFiles: [], summary: 'No fix produced.',
        testOutput: '', confidence: 'LOW',
    };

    const tools = createCodeTools(reproResult.repoPath);

    // ── System prompt: Claude Code-inspired, token-efficient ─────────
    const systemPrompt = `You are a code-fix agent operating on a cloned OSS repository.

=== SELF-AWARENESS ===
You are an LLM. You are bad at these things — catch yourself doing them:
- Reading code and saying "this looks correct" without running it.
- Claiming you found a bug without verifying via grep/tests.
- Making changes that sound good but don't compile or pass tests.
- Fabricating issues that don't exist to justify making changes.
If you catch yourself writing an explanation instead of a command, stop. Run the command.

=== TASK ===
You have been given the diff and analysis of a recently merged PR that fixed a bug.
1. Study the fix pattern.
2. Explore the codebase. Use list_directory + search_codebase to understand structure.
3. Find a SIMILAR unfixed instance of the same pattern — or a closely related issue in the same area.
4. Write a minimal, correct fix using patch_file (preferred) or write_file.
5. Verify: run tests, build, or at minimum grep to confirm your change is valid.

=== RULES ===
- Complete the fix fully — don't gold-plate, but don't leave it half-done.
- Don't add error handling for impossible scenarios. Only validate at boundaries.
- Don't introduce security vulnerabilities (injection, XSS, OWASP top 10).
- No comments in code unless strictly necessary. No planning documents.
- If you cannot find a real issue, say so. Do NOT fabricate changes.
- After fixing, review your own diff: strip unnecessary complexity.
- Batch independent read_file/search_codebase calls when possible.

=== VERIFICATION (mandatory) ===
After every edit you MUST do at least one of:
- Run the test suite (npm test, pytest, go test, etc.)
- Run the build/compile step
- Run a targeted command that exercises the changed code
"I read the code and it looks correct" is NOT verification. Run something.

=== OUTPUT ===
End with exactly:
SUMMARY: [1-2 sentences, what you fixed and why]
FILES_MODIFIED: [comma-separated paths]
CONFIDENCE: [LOW|MEDIUM|HIGH]
TEST_RESULT: [PASS|FAIL|NO_TESTS|SKIPPED]`;

    // ── User prompt: compressed context ──────────────────────────────
    const userPrompt = `### PR Analysis
${reproResult.analysis.substring(0, 3000)}

### PR Diff (first 6000 chars)
\`\`\`diff
${reproResult.diff.substring(0, 6000)}
\`\`\`

### Changed Files
${reproResult.affectedFiles.map(f => `- ${f.filename} (${f.status})`).join('\n')}

### Contributing Guidelines
${contributingMd?.substring(0, 1000) || 'None.'}

### Style Guide
${styleGuide.substring(0, 800)}

Start by listing the root directory, then search for patterns related to the fix.`;

    try {
        const agent = new ToolLoopAgent({
            model: MODEL,
            instructions: systemPrompt,
            tools,
            stopWhen: stepCountIs(20), // reduced from 25 — saves tokens
        });

        const result = await agent.generate({ prompt: userPrompt });
        const out = result.text || '';
        console.log(`\n[CodeFix] Agent output:\n${out}`);

        const summaryMatch = out.match(/SUMMARY:\s*(.*)/i);
        const confidenceMatch = out.match(/CONFIDENCE:\s*(LOW|MEDIUM|HIGH)/i);
        const testMatch = out.match(/TEST_RESULT:\s*(PASS|FAIL|NO_TESTS|SKIPPED)/i);

        const modifiedFiles = Array.from(modifiedFilesSet);
        const summary = summaryMatch?.[1]?.trim() || out.substring(0, 300);
        const confidence = confidenceMatch?.[1] || 'LOW';
        const testOutput = testMatch?.[1] || 'SKIPPED';

        if (modifiedFiles.length === 0) {
            console.log(`[CodeFix] No files modified.`);
            return { ...emptyResult, summary };
        }

        console.log(`[CodeFix] Modified ${modifiedFiles.length} files: ${modifiedFiles.join(', ')}`);
        return { success: true, modifiedFiles, summary, testOutput, confidence };

    } catch (e: any) {
        console.error(`[CodeFix] Failed: ${e.message}`);
        return emptyResult;
    }
}
