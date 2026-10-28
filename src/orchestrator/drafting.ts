import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { GitHubService } from "../utils/github.js";
import type { CodeFixResult } from "./codefix.js";
import type { VerificationResult } from "./verify.js";
import type { BehavioralMemory } from "../utils/memory.js";
import * as readline from "readline";

const MODEL: LanguageModel = google("gemini-3.8-flash") as unknown as LanguageModel;

export interface ProofContext {
    reproCommand?: string;
    failureTrace?: string;
    verification?: VerificationResult;
}

export interface IssueDraft {
    title: string;
    body: string;
    labels?: string[];
}

/**
 * Drafts a style-matched GitHub Issue for an autonomously hunted latent bug.
 * Samples recent issues from the target repository to match tone, headings, and structure.
 */
export async function draftIssueForHuntedBug(
    candidate: any,
    github: GitHubService,
    owner: string,
    repo: string,
    proof?: ProofContext,
    issueTemplate?: string
): Promise<IssueDraft> {
    console.log(`\n📋 Drafting Style-Matched GitHub Issue for: ${candidate.title}`);

    // Sample recent bug issues to learn conventions if no official template
    let sampleIssueConventions = "";
    if (!issueTemplate) {
        try {
            const samples = await github.getRecentBugIssues(owner, repo, 5);
            if (samples && samples.length > 0) {
                sampleIssueConventions = samples.map((s, idx) => {
                    const title = s.title;
                    const bodyExcerpt = (s.body || "").substring(0, 500);
                    return `### Issue Sample #${idx + 1}: "${title}"\n${bodyExcerpt}\n`;
                }).join("\n---\n");
            }
        } catch (e) {}
    }

    const templatePrompt = issueTemplate ? `
### Official Repository Bug Template (You MUST fill out this exact template structure):
\`\`\`markdown
${issueTemplate}
\`\`\`
Instructions:
1. Retain all section headers, checklists, and structure from the official template above.
2. Fill in the bug details, steps to reproduce, and environment accurately.
` : `
### Formatting Samples from Recent Accepted Bug Reports:
${sampleIssueConventions || "Standard GitHub bug report: Description, Steps to Reproduce, Expected Behavior, Actual Behavior, Environment."}
`;

    const prompt = `
You are drafting a professional, high-signal GitHub Bug Report Issue for ${owner}/${repo}.
You have discovered and confirmed an unhandled edge-case bug.

${templatePrompt}

### Discovered Bug Details:
Title: ${candidate.title}
Archetype: ${candidate.labels?.join(", ") || "latent-bug"}
Target Component / File: ${candidate.body}

### Reproduction Proof:
Reproduction Command: ${proof?.reproCommand || "N/A"}
Failure Stack Trace:
\`\`\`
${proof?.failureTrace ? proof.failureTrace.substring(0, 1500) : "N/A"}
\`\`\`

TASK:
Draft the GitHub Issue title and body.
1. Match the heading structure, tone, and conventions used in this repo's existing bug reports.
2. Clearly describe what triggers the problem with concrete steps or minimal code snippet.
3. Include the exact error trace observed.
4. Do NOT mention AutoHarness or AI agents — format it as a top-tier human engineer or open-source contributor submitting a clear, actionable bug report.

OUTPUT FORMAT:
TITLE: [Issue Title]
BODY:
[Issue Body Markdown]
`;

    try {
        const { text } = await generateText({
            model: MODEL,
            prompt,
            system: "You are an elite open-source contributor writing clear, high-signal bug reports."
        });

        const titleMatch = text.match(/TITLE:\s*(.*)/i);
        const bodyMatch = text.match(/BODY:\s*([\s\S]*)/i);

        const title = titleMatch ? titleMatch[1].trim() : candidate.title;
        const body = bodyMatch ? bodyMatch[1].trim() : `${candidate.body}\n\n### Reproduction\n\`\`\`\n${proof?.reproCommand}\n\`\`\`\n\n\`\`\`\n${proof?.failureTrace}\n\`\`\``;

        return {
            title,
            body,
            labels: ["bug"]
        };
    } catch (e: any) {
        return {
            title: candidate.title,
            body: `${candidate.body}\n\n### Reproduction\n\`\`\`\n${proof?.reproCommand}\n\`\`\`\n\n### Error Trace\n\`\`\`\n${proof?.failureTrace}\n\`\`\``,
            labels: ["bug"]
        };
    }
}


/**
 * Stages 9 & 10: Drafting the Pull Request (Breken Proof Format).
 * Formats a high-signal PR description with root-cause analysis, proof of reproduction,
 * surgical diff summary, and verification output.
 */
export async function draftPullRequest(
    candidate: any,
    styleGuide: string,
    codeFix: CodeFixResult,
    github: GitHubService,
    owner: string,
    repo: string,
    proof?: ProofContext,
    prTemplate?: string
): Promise<{ title: string; body: string }> {
    console.log(`\n✏️  Stage 9 & 10: Drafting Proof-Backed Pull Request for: ${candidate.title}`);

    const templatePrompt = prTemplate ? `
### Official Repository PR Template (You MUST fill out this exact template):
\`\`\`markdown
${prTemplate}
\`\`\`
Instructions:
1. Retain all section headers, checklists, and structure from the official template above.
2. Mark checklist items [x] as appropriate for verified bug fixes with regression tests.
` : `
Requirements:
1. Title should follow conventional commits if the repo uses them (e.g. \`fix(scope): concise description\`).
2. Body should be structured cleanly:
   - ## Summary (concise explanation of bug and fix)
   - ## Root Cause
   - ## Proof & Verification (mention the failing test/reproduction and confirmation of pass)
   - ## Affected Files
`;

    const prompt = `
You are drafting a high-signal, maintainer-friendly Pull Request for ${owner}/${repo} (following the Breken AI OSS standard).
An automated coding agent has made surgical code changes and verified them against reproduction tests.

### Repository Conventions:
${styleGuide}

### Candidate / Issue Context:
Title: ${candidate.title}
URL: ${candidate.url}

### Actual Code Changes Made by Agent:
Summary: ${codeFix.summary}
Files Modified: ${codeFix.modifiedFiles.join(", ")}
Test Result: ${codeFix.testOutput}

### Reproduction & Verification Proof:
Reproduction Command: ${proof?.reproCommand || "N/A"}
Initial Failure Observed:
${proof?.failureTrace ? proof.failureTrace.substring(0, 1000) : "N/A"}
Verification Status:
${proof?.verification ? proof.verification.summary : "Verified locally"}

${templatePrompt}
3. Do NOT invent hypothetical changes. Be surgical, precise, and maintainer-friendly.

OUTPUT FORMAT:
TITLE: [Your Drafted Title]
BODY:
[Your Drafted Body]
`;

    try {
        const { text } = await generateText({
            model: MODEL,
            prompt,
            system: "You are an expert OSS contributor drafting a maintainer-grade pull request. Focus on concrete evidence and surgical accuracy.",
        });

        const titleMatch = text.match(/TITLE:\s*(.*)/i);
        const bodyMatch = text.match(/BODY:\s*([\s\S]*)/i);

        const draft = {
            title: titleMatch ? titleMatch[1].trim() : `fix: ${candidate.title}`,
            body: bodyMatch ? bodyMatch[1].trim() : `Automated fix related to: ${candidate.url}\n\n${codeFix.summary}`,
        };

        console.log(`[Draft] Success. Title: ${draft.title}`);
        return draft;

    } catch (e: any) {
        console.error(`[Draft] Generation failed: ${e.message}`);
        return {
            title: `fix: ${candidate.title}`,
            body: `Automated fix for #${candidate.number}.\n\n**Summary:** ${codeFix.summary}\n\n**Files:** ${codeFix.modifiedFiles.join(", ")}`,
        };
    }
}

/**
 * Stages 11 & 12: The Human Gate with Closed-Loop Behavioral Ratchet (arXiv:2607.13091).
 * If approved or rejected, captures feedback to update persistent behavioral memory.
 */
export async function awaitHumanGates(
    draft: { title: string; body: string },
    codeFix: CodeFixResult,
    owner: string,
    repo: string,
    memory?: BehavioralMemory
): Promise<boolean> {
    console.log(`\n🛑 Stage 11 & 12: HUMAN REVIEW GATE`);
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`TITLE: ${draft.title}`);
    console.log(`\nBODY:\n${draft.body}`);
    console.log(`\nFILES CHANGED: ${codeFix.modifiedFiles.join(", ")}`);
    console.log(`AGENT CONFIDENCE: ${codeFix.confidence}`);
    console.log(`TEST RESULT: ${codeFix.testOutput}`);
    console.log(`────────────────────────────────────────────────────────────`);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const askQuestion = (query: string): Promise<string> =>
        new Promise((resolve) => rl.question(query, resolve));

    try {
        const answer = await askQuestion("[Human Gate] Do you approve this draft and authorize PR submission? (yes/no): ");
        const approved = answer.trim().toLowerCase() === "yes" || answer.trim().toLowerCase() === "y";

        if (approved) {
            console.log(`[Human Gate] Approved! Proceeding to submission...`);
            const notes = await askQuestion("[Human Gate] Optional approval note / rule to remember for next time (press Enter to skip): ");
            if (notes.trim() && memory) {
                await memory.distillReviewFeedback(notes.trim(), owner, repo, true);
            }
            rl.close();
            return true;
        } else {
            console.log(`[Human Gate] Rejected by human operator.`);
            const feedback = await askQuestion("[Human Gate] What was wrong? (Feeds behavioral memory ratchet): ");
            if (feedback.trim() && memory) {
                await memory.distillReviewFeedback(feedback.trim(), owner, repo, false);
            }
            rl.close();
            return false;
        }
    } catch (e) {
        rl.close();
        return false;
    }
}
