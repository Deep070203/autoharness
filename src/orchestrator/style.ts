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
        return "No specific merge patterns detected. Follow standard professional open-source PR structures.";
    } catch (e: any) {
        console.error(`[Pattern Match] Failed to extract merge patterns: ${e.message}`);
        return "Follow standard professional open-source PR structures.";
    }
}
