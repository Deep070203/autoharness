import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { GitHubService } from "../utils/github.js";
import type { CodeFixResult } from "./codefix.js";
import * as readline from "readline";

const MODEL: LanguageModel = google("gemini-2.5-flash") as unknown as LanguageModel;

/**
 * Stages 9 & 10: Drafting the Issue/PR and Polishing.
 *
 * Now accepts real CodeFixResult data to generate an accurate PR description
 * based on actual code changes made by the coding agent.
 */
export async function draftPullRequest(
    candidate: any,
    styleGuide: string,
    codeFix: CodeFixResult,
    github: GitHubService,
    owner: string,
    repo: string
): Promise<{ title: string; body: string }> {
    console.log(`\n✏️  Stage 9 & 10: Drafting Pull Request for: ${candidate.title}`);

    const prompt = `
You are drafting a Pull Request for the ${owner}/${repo} repository.
An automated coding agent has made real code changes. You must write a PR title and body that ACCURATELY describes what was actually changed.

### Extracted Style Guide for this Repo:
${styleGuide}

### Original Issue / Candidate Context:
Title: ${candidate.title}
URL: ${candidate.url}

### Actual Code Changes Made by the Agent:
Summary: ${codeFix.summary}
Files Modified: ${codeFix.modifiedFiles.join(', ')}
Test Result: ${codeFix.testOutput}
Confidence: ${codeFix.confidence}

Draft the PR title and body.
- The title and body must describe what the agent ACTUALLY changed — do NOT invent changes that weren't made.
- Adhere strictly to the Style Guide provided.
- Be honest about the scope and nature of the fix.
- If the style guide requires specific headers, use them exactly.

OUTPUT FORMAT:
TITLE: [Your Drafted Title]
BODY:
[Your Drafted Body]
`;

    try {
        const { text } = await generateText({
            model: MODEL,
            prompt: prompt,
            system: "You are a professional software engineer drafting a PR. Write only the requested title and body. Be accurate — describe real changes, not hypothetical ones.",
        });

        const titleMatch = text.match(/TITLE:\s*(.*)/i);
        const bodyMatch = text.match(/BODY:\s*([\s\S]*)/i);

        const draft = {
            title: titleMatch ? titleMatch[1].trim() : `Fix: ${candidate.title}`,
            body: bodyMatch ? bodyMatch[1].trim() : `Automated fix related to: ${candidate.url}\n\n${codeFix.summary}`,
        };

        console.log(`[Draft] Success. Title: ${draft.title}`);
        return draft;

    } catch (e: any) {
        console.error(`[Draft] Generation failed: ${e.message}`);
        return {
            title: `Fix: ${candidate.title}`,
            body: `Automated fix.\n\n**Summary:** ${codeFix.summary}\n\n**Files:** ${codeFix.modifiedFiles.join(', ')}`,
        };
    }
}

/**
 * Stages 11 & 12: The Human Gates.
 *
 * Pipeline pauses and requests human interaction for Viability & CLA.
 * Now also shows the actual files changed for review.
 */
export async function awaitHumanGates(
    draft: { title: string; body: string },
    codeFix: CodeFixResult,
): Promise<boolean> {
    console.log(`\n🛑 Stage 11 & 12: HUMAN REVIEW GATE`);
    console.log(`──────────────────────────────────────────────────`);
    console.log(`TITLE: ${draft.title}`);
    console.log(`\nBODY:\n${draft.body}`);
    console.log(`\nFILES CHANGED: ${codeFix.modifiedFiles.join(', ')}`);
    console.log(`AGENT CONFIDENCE: ${codeFix.confidence}`);
    console.log(`TEST RESULT: ${codeFix.testOutput}`);
    console.log(`──────────────────────────────────────────────────`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question("[Human Gate] Do you approve this draft and authorize CLA signature? (yes/no): ", (answer) => {
            rl.close();
            if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
                console.log(`[Human Gate] Approved. Proceeding to submission...`);
                resolve(true);
            } else {
                console.log(`[Human Gate] Rejected by human operator.`);
                resolve(false);
            }
        });
    });
}
