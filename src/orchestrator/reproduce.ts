import { GitHubService } from "../utils/github.js";
import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import * as path from "path";
import * as fs from "fs";

const MODEL: LanguageModel = google("gemini-2.5-flash") as unknown as LanguageModel;

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
        const repoPath = path.resolve(`./workspace/repos/${localDirName}`);

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
