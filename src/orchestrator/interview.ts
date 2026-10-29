import { generateText, LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { GitHubService } from "../utils/github.js";

const MODEL: LanguageModel = google("gemini-3.8-flash") as unknown as LanguageModel;

export interface ViabilityVerdict {
    keep: boolean;
    reason: string;
    /** The model request itself failed. Distinct from a deliberate DROP. */
    modelError?: boolean;
}

/**
 * Reads the last DECISION line. A bug report is not a patch, so a model that
 * mentions both words must be scored on the decision it actually ends with.
 */
export function parseViabilityDecision(text: string): { keep: boolean; reason: string } {
    const decisions = [...text.matchAll(/DECISION:\s*(KEEP|DROP)\b/gi)];
    if (decisions.length === 0) {
        const snippet = text.replace(/\s+/g, " ").trim().slice(0, 300);
        return {
            keep: false,
            reason: snippet
                ? `No DECISION line. Model said: ${snippet}`
                : "Viability model returned an empty response.",
        };
    }
    const last = decisions[decisions.length - 1];
    const keep = last[1].toUpperCase() === "KEEP";
    const reasonLine = text.match(/REASON:\s*(.+)/i);
    let reason = reasonLine?.[1]?.trim() ?? "";
    if (!reason) {
        const before = text.slice(0, last.index).replace(/\s+/g, " ").trim();
        reason = before.slice(-300) || (keep ? "Kept." : "Dropped.");
    }
    return { keep, reason: reason.slice(0, 500) };
}

/**
 * Handles the "Ouroboros Interview" step.
 * Decides whether an open issue is a concrete code defect an agent can patch.
 */
export async function runOuroborosInterview(
    candidate: any,
    contributingMd: string | null,
    github: GitHubService,
    owner: string,
    repo: string
): Promise<ViabilityVerdict> {
    console.log(`\n🤖 Running Ouroboros Viability Interview for: ${candidate.title}`);

    const labels = Array.isArray(candidate.labels) && candidate.labels.length > 0
        ? candidate.labels.join(", ")
        : "none";
    const body = (candidate.body || "No body provided.").slice(0, 7000);

    const prompt = `
You are an expert open-source maintainer deciding whether an autonomous coding agent should open a pull request for this GitHub issue.

This candidate is an open issue, not an existing patch. Do not drop it for lacking a diff.

KEEP when the report describes a concrete defect in the project's code:
- a crash, wrong result, data loss, security bug, or race with a described sequence
- enough detail that an engineer could find the named functions and write a focused test
A bug does not need an existing patch, a one-line repro command, or a running cluster.
Timing and concurrency bugs that name the functions involved are KEEP.

DROP when:
- it is a feature request, question, roadmap item, or design discussion
- it needs private credentials, a production account, or unpublished customer data and cannot be unit-tested
- there is no identifiable code behavior to change
- it is a duplicate or a wontfix

### Candidate issue:
Title: ${candidate.title}
URL: ${candidate.url}
Labels: ${labels}
Body:
${body}

### CONTRIBUTING.md snippet:
${contributingMd ? contributingMd.substring(0, 1200) : "No contributing guidelines found."}

### Task:
On its own line write: REASON: <one sentence>
End with exactly one of: DECISION: KEEP or DECISION: DROP
`;

    try {
        const { text } = await generateText({
            model: MODEL,
            prompt: prompt,
            system: "You gate an autonomous bug-fix agent. Keep concrete code defects. Drop noise. The candidate is an issue, not a pull request.",
        });

        console.log(`[Interview Result]:\n${text}`);
        return parseViabilityDecision(text);
    } catch (e: any) {
        console.error(`Ouroboros Interview failed: ${e.message}`);
        return { keep: false, reason: e.message || "model request failed", modelError: true };
    }
}
