import { GitHubService } from "../utils/github.js";
import { generateText, LanguageModel } from "ai";
import { google } from "@ai-sdk/google";

const MODEL: LanguageModel = google("gemini-2.5-pro") as unknown as LanguageModel;

/**
 * Handles Stage 8: Merge-Pattern Matching.
 * 
 * Instead of relying solely on CONTRIBUTING.md, this stage analyzes the 
 * "social shape" of the last 10 merged PRs in the repository to extract 
 * stylistic guidelines for drafting a new PR.
 */
export async function extractMergePatterns(
    github: GitHubService,
    owner: string,
    repo: string
): Promise<string> {
    console.log(`\n📚 Stage 8: Analyzing merge-patterns for: ${owner}/${repo}`);

    try {
        const recentPRs = await github.getRecentMergedPRs(owner, repo, 10);

        if (recentPRs.length === 0) {
            console.log(`[Pattern Match] No recent PRs found to learn from.`);
            return "No specific merge patterns detected. Follow standard professional open-source PR structures.";
        }

        console.log(`[Pattern Match] Found ${recentPRs.length} PRs. Analyzing stylistic shape...`);

        // Compile a corpus of recent successful PR descriptions
        const corpus = recentPRs.map((pr: any) => `
PR Title: ${pr.title}
Author: ${pr.user?.login}
Body:
${pr.body || "No description provided."}
---`).join('\n');

        const prompt = `
You are an expert open-source cultural analyst. 
I have provided you with a corpus of the last 10 successfully merged Pull Requests from the repository ${owner}/${repo}.

Your task is to analyze the "social shape" and structure of these accepted PRs.
Look for:
- How are PR bodies structured? (Do they use checklists? specific headers?)
- Do they link to issues in a specific format (e.g. 'Fixes #123')?
- How much context do they provide? Are they extremely terse, or very descriptive?
- Is there a specific conventional commit style used in the titles?

Output a concise, 4-5 bullet point style guide that an autonomous agent should follow when drafting a NEW pull request for this repository, to maximize the chances of it blending in and being accepted.

### PR Corpus:
${corpus.substring(0, 50000)} // truncate to avoid massive contexts if PRs are huge
`;

        const { text } = await generateText({
            model: MODEL,
            prompt: prompt,
            system: "You are a stylistic analysis engine. Be extremely concise and observant.",
        });

        console.log(`[Pattern Match] Extracted Style Guide:\n${text}`);
        return text;

    } catch (e: any) {
        console.error(`[Pattern Match] Failed to extract merge patterns: ${e.message}`);
        return "Follow standard professional open-source PR structures.";
    }
}
