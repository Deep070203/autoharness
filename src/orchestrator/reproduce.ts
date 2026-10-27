import { GitHubService } from "../utils/github.js";
import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import * as path from "path";
import * as fs from "fs";

const MODEL: LanguageModel = google("gemini-3.5-flash") as unknown as LanguageModel;

/**
 * Structured result from Stage 5 analysis.
 * Carries real data forward to the coding agent and drafting stages.
 */
export interface ReproductionResult {
    /** Whether this candidate is viable for a fix */
    viable: boolean;
    /** The raw unified diff of the merged PR */
    diff: string;
    /** LLM analysis of the bug pattern and fix approach */
    analysis: string;
    /** Files changed in the original PR */
    affectedFiles: { filename: string; status: string; additions: number; deletions: number; patch: string }[];
    /** Absolute path to the cloned repo on disk */
    repoPath: string;
    /** Name of the local directory (for git operations) */
    localDirName: string;
    /** The PR number that was analyzed */
    prNumber: number;
    /** Summary of what the original fix did */
    fixSummary: string;
    /** Optional shell command that reproduces the issue */
    reproCommand?: string;
    /** Output/trace of the initial reproduction failure (Breken proof) */
    initialFailingTrace?: string;
}

/**
 * Stage 5: Real Analysis & Local Preparation
 *
 * Instead of simulating reproduction, this stage:
 * 1. Forks & clones the repo (real)
 * 2. Fetches the actual PR diff from GitHub API (real)
 * 3. Uses an LLM to deeply analyze the fix pattern (real)
 * 4. Returns structured data for the coding agent
 */
export async function reproduceCandidateLocally(
    candidate: { number: number; title: string; body: string; url: string; pull_number: number },
    github: GitHubService,
    owner: string,
    repo: string
): Promise<ReproductionResult> {
    console.log(`\n🛠️  Stage 5: Real Analysis for: ${candidate.title}`);

    const emptyResult: ReproductionResult = {
        viable: false, diff: '', analysis: '', affectedFiles: [],
        repoPath: '', localDirName: '', prNumber: candidate.pull_number, fixSummary: '',
    };

    try {
        // ── 1. Fork & Clone ──────────────────────────────────────────────
        console.log(`[Analyze] Forking & cloning ${owner}/${repo}...`);
        let forkUrl = `https://github.com/${owner}/${repo}.git`;
        let localDirName = repo;

        if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== 'placeholder_needs_token') {
            try {
                const forkData = await github.forkRepository(owner, repo);
                forkUrl = forkData.clone_url;
                localDirName = forkData.name;
                console.log(`[Analyze] Fork ready: ${forkUrl}`);
            } catch (e: any) {
                console.log(`[Analyze] Fork exists or failed, using direct clone: ${e.message}`);
            }
        }

        await github.cloneRepository(forkUrl, localDirName);
        const repoPath = path.join(github.baseDir, localDirName);

        if (!fs.existsSync(repoPath)) {
            console.error(`[Analyze] Clone failed — directory not found: ${repoPath}`);
            return emptyResult;
        }
        console.log(`[Analyze] Repo available at ${repoPath}`);

        // ── 2. Fetch real PR diff & files ────────────────────────────────
        console.log(`[Analyze] Fetching diff for PR #${candidate.pull_number}...`);
        let diff: string;
        let prFiles: { filename: string; status: string; additions: number; deletions: number; patch: string }[];

        try {
            diff = await github.getPRDiff(owner, repo, candidate.pull_number);
            prFiles = (await github.getPRFiles(owner, repo, candidate.pull_number)).map(f => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                patch: f.patch,
            }));
            console.log(`[Analyze] Diff retrieved: ${diff.length} chars, ${prFiles.length} files changed`);
        } catch (e: any) {
            console.error(`[Analyze] Failed to fetch PR diff: ${e.message}`);
            return emptyResult;
        }

        if (!diff || diff.length < 20) {
            console.log(`[Analyze] Diff is empty or trivial. Skipping.`);
            return emptyResult;
        }

        // ── 3. LLM analysis of the fix pattern ──────────────────────────
        console.log(`[Analyze] Analyzing fix pattern with LLM...`);
        const analysisPrompt = `
You are a senior software engineer analyzing a merged Pull Request.

### PR Title: ${candidate.title}
### PR Description:
${candidate.body || 'No description.'}

### Unified Diff (truncated to 15000 chars):
\`\`\`diff
${diff.substring(0, 15000)}
\`\`\`

### Files Changed:
${prFiles.map(f => `- ${f.filename} (${f.status}, +${f.additions || '?'}/-${f.deletions || '?'})`).join('\n')}

Analyze this PR and answer:
1. **Bug Category**: What category of bug does this fix? (e.g., parsing error, null check, config mistake, typo, security, race condition, wrong API usage)
2. **Root Cause**: What was the root cause in 1-2 sentences?
3. **Fix Summary**: What exactly did the fix change, in 2-3 sentences?
4. **Applicable Pattern**: Could a similar fix pattern apply to other parts of this codebase? Where should we look? Be specific about file patterns or module areas.
5. **Viability**: Is this a clear, scoped bug fix suitable for an automated agent to replicate the pattern? Answer YES or NO.
6. **Risk Level**: LOW / MEDIUM / HIGH — would applying a similar pattern elsewhere risk breaking things?

End with exactly: VIABLE: YES or VIABLE: NO
`;

        try {
            const { text } = await generateText({
                model: MODEL,
                prompt: analysisPrompt,
                system: "You are a code analysis engine. Be precise, technical, and conservative. Only mark as VIABLE if the fix is clear, scoped, and safe to replicate.",
            });

            console.log(`[Analyze] LLM Analysis:\n${text}`);

            const viable = text.includes('VIABLE: YES');
            const fixSummaryMatch = text.match(/Fix Summary[:\s]*([\s\S]*?)(?=\n\d|\n\*\*|Applicable|$)/i);
            const fixSummary = fixSummaryMatch ? fixSummaryMatch[1].trim() : candidate.title;

            return {
                viable,
                diff,
                analysis: text,
                affectedFiles: prFiles,
                repoPath,
                localDirName,
                prNumber: candidate.pull_number,
                fixSummary,
            };

        } catch (e: any) {
            console.error(`[Analyze] LLM analysis failed: ${e.message}`);
            return emptyResult;
        }

    } catch (e: any) {
        console.error(`[Analyze] Critical error: ${e.message}`);
        return emptyResult;
    }
}

/**
 * Issue-based analysis (no diff available).
 * Clones the repo, reads the issue body, and uses LLM to analyze what needs fixing.
 */
export async function analyzeIssueLocally(
    issue: { number: number; title: string; body: string; url: string },
    github: GitHubService,
    owner: string,
    repo: string
): Promise<ReproductionResult> {
    console.log(`\n🛠️  Stage 5 (Issue Mode): Analyzing issue #${issue.number}: ${issue.title}`);

    const emptyResult: ReproductionResult = {
        viable: false, diff: '', analysis: '', affectedFiles: [],
        repoPath: '', localDirName: '', prNumber: issue.number, fixSummary: '',
    };

    try {
        // ── 1. Fork & Clone ──────────────────────────────────────────────
        console.log(`[Issue] Forking & cloning ${owner}/${repo}...`);
        let forkUrl = `https://github.com/${owner}/${repo}.git`;
        let localDirName = repo;

        if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== 'placeholder_needs_token') {
            try {
                const forkData = await github.forkRepository(owner, repo);
                forkUrl = forkData.clone_url;
                localDirName = forkData.name;
                console.log(`[Issue] Fork ready: ${forkUrl}`);
            } catch (e: any) {
                console.log(`[Issue] Fork exists or failed, using direct clone: ${e.message}`);
            }
        }

        await github.cloneRepository(forkUrl, localDirName);
        const repoPath = path.join(github.baseDir, localDirName);

        if (!fs.existsSync(repoPath)) {
            console.error(`[Issue] Clone failed — directory not found: ${repoPath}`);
            return emptyResult;
        }
        console.log(`[Issue] Repo available at ${repoPath}`);

        // ── 2. LLM analysis of the issue ────────────────────────────────
        console.log(`[Issue] Analyzing issue with LLM...`);
        const analysisPrompt = `
You are a senior software engineer analyzing an open GitHub issue.

### Issue #${issue.number}: ${issue.title}
### Issue Body:
${issue.body || 'No description.'}

### Repository: ${owner}/${repo}

Analyze this issue and answer:
1. **Bug Category**: What category of bug is this? (e.g., parsing error, null check, config mistake, typo, security, race condition, wrong API usage, missing feature)
2. **Root Cause Hypothesis**: What is likely the root cause based on the description?
3. **Fix Approach**: How should this be fixed? Be specific about which files/modules to look at.
4. **Viability**: Is this a clear, scoped issue suitable for an automated agent to fix? Answer YES or NO.
5. **Risk Level**: LOW / MEDIUM / HIGH

End with exactly: VIABLE: YES or VIABLE: NO
`;

        try {
            const { text } = await generateText({
                model: MODEL,
                prompt: analysisPrompt,
                system: "You are a code analysis engine. Be precise, technical, and conservative. Only mark as VIABLE if the issue is clear, scoped, and fixable.",
            });

            console.log(`[Issue] LLM Analysis:\n${text}`);

            const viable = text.includes('VIABLE: YES');
            const fixSummaryMatch = text.match(/Fix Approach[:\s]*([\s\S]*?)(?=\n\d|\n\*\*|Viability|$)/i);
            const fixSummary = fixSummaryMatch ? fixSummaryMatch[1].trim() : issue.title;

            return {
                viable,
                diff: `Issue #${issue.number}: ${issue.title}\n\n${issue.body || ''}`,
                analysis: text,
                affectedFiles: [],
                repoPath,
                localDirName,
                prNumber: issue.number,
                fixSummary,
            };

        } catch (e: any) {
            console.error(`[Issue] LLM analysis failed: ${e.message}`);
            return emptyResult;
        }

    } catch (e: any) {
        console.error(`[Issue] Critical error: ${e.message}`);
        return emptyResult;
    }
}

/**
 * Breken Proof Protocol: Attempts to generate or run a minimal reproduction command
 * that proves the bug exists by failing (exit !== 0) before any fix is attempted.
 */
export async function attemptReproductionProof(
    issue: { number: number; title: string; body: string },
    repoPath: string
): Promise<{ command: string; failureTrace: string } | undefined> {
    console.log(`\n🧪 [Proof Protocol] Formulating reproduction test case for issue #${issue.number}...`);

    const prompt = `
You are an expert QA Engineer implementing the Breken Autonomous Proof Protocol.
Given a bug report, formulate a minimal shell command or one-line test command that reproduces the failure.
If the issue mentions a specific command, test file, or flags, use them.
If it involves running an existing test or script, specify it.

Issue Title: ${issue.title}
Issue Description:
${issue.body ? issue.body.substring(0, 2000) : "No description"}

OUTPUT:
If a reproduction command is possible, output exactly:
REPRO_COMMAND: <bash command to run inside repo directory>

If reproducing requires extensive manual setup or cannot be executed in 1 command, output:
REPRO_COMMAND: NONE
`;

    try {
        const { text } = await generateText({
            model: MODEL,
            prompt,
            system: "You generate concrete reproduction commands. Output only REPRO_COMMAND: ...",
        });

        const match = text.match(/REPRO_COMMAND:\s*(.*)/i);
        if (!match || match[1].trim() === "NONE" || match[1].trim().length < 3) {
            console.log(`[Proof Protocol] No direct automated command extracted.`);
            return undefined;
        }

        const command = match[1].trim().replace(/^`/, "").replace(/`$/, "");
        console.log(`[Proof Protocol] Executing candidate repro: ${command}`);

        const { execSync } = require("child_process");
        try {
            execSync(command, {
                cwd: repoPath,
                encoding: "utf-8",
                timeout: 45_000,
                env: { ...process.env, CI: "true" }
            });
            console.log(`[Proof Protocol] Repro command passed unexpectedly (exit 0). Proof not confirmed.`);
            return undefined;
        } catch (err: any) {
            const failureTrace = (err.stdout || err.stderr || err.message).substring(0, 2000);
            console.log(`[Proof Protocol] 🎯 Confirmed failing reproduction (exit ${err.status || 1})!`);
            return {
                command,
                failureTrace
            };
        }
    } catch (e: any) {
        console.warn(`[Proof Protocol] Could not establish automated repro: ${e.message}`);
        return undefined;
    }
}

