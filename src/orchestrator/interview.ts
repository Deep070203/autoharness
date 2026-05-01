import { generateText, LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { IssueState, PipelineStage } from "./state.js";
import { GitHubService } from "../utils/github.js";

const MODEL: LanguageModel = google("gemini-2.5-pro") as unknown as LanguageModel;

/**
 * Handles the "Ouroboros Interview" step.
 * An LLM is asked to review the candidate PR/diff and the repo's CONTRIBUTING.md,
 * then decide whether the agent should pursue it as a branching candidate.
 */
export async function runOuroborosInterview(
    candidate: any,
    contributingMd: string | null,
    github: GitHubService,
    owner: string,
    repo: string
): Promise<boolean> {
    console.log(`\n🤖 Running Ouroboros Viability Interview for: ${candidate.title}`);

    // If available, we would pull the full diff string here using `github.octokit.pulls.get()`
    // For now, we use the body and title
    const prompt = `
You are an expert open-source maintainer acting as an initial viability filter.
Your goal is to decide if a given bug fix or patch is appropriate for an AI agent to build a variation of, or learn from.

We only want to pursue candidates that resolve clear, reproducible bugs or security issues.
We DO NOT want features, sprawling refactors, UI tweaks, or changes that conflict with project philosophy.

### Candidate PR:
Title: ${candidate.title}
URL: ${candidate.url}
Body:
${candidate.body || "No body provided."}

### CONTRIBUTING.md Snippet:
${contributingMd ? contributingMd.substring(0, 2000) : "No contributing guidelines found."}

### Task:
Evaluate this candidate. Does this represent a clear, intentional bug fix that is suitable for a secondary agent to reproduce locally and draft a similar fix for?
You must end your response with exactly "DECISION: KEEP" or "DECISION: DROP".
`;

    try {
        const { text } = await generateText({
            model: MODEL,
            prompt: prompt,
            system: "You are the Ouroboros gating agent. Be strict and protect the pipeline from noise.",
        });

        console.log(`[Interview Result]:\n${text}`);

        if (text.includes("DECISION: KEEP")) {
            return true;
        } else {
            return false;
        }

    } catch (e: any) {
        console.error(`Ouroboros Interview failed: ${e.message}`);
        return false; // Fail secure
    }
}
