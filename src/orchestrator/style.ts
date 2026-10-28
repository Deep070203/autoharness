import { GitHubService } from "../utils/github.js";
import { generateText, LanguageModel } from "ai";
import { google } from "@ai-sdk/google";

const MODEL: LanguageModel = google("gemini-2.5-pro") as unknown as LanguageModel;

export interface RepoPolicyContract {
    requiresCLA: boolean;
    claUrl?: string;
    claInstructions?: string;
    requiresDCO: boolean;
    styleGuide: string;
    prTemplate?: string;
    issueTemplate?: string;
    detectedLinters?: string[];
    detectedFormatters?: string[];
}

/**
 * Stage 8: Repository Policy & Convention Analysis
 *
 * Harvests:
 * 1. Official PR Template (.github/pull_request_template.md)
 * 2. Official Issue Template (.github/ISSUE_TEMPLATE/)
 * 3. CONTRIBUTING.md policies: CLA requirements, DCO signoff, linters/formatters
 * 4. Merge patterns from recent PRs
 */
export async function extractRepoPolicy(
    github: GitHubService,
    owner: string,
    repo: string,
    contributingMd: string | null
): Promise<RepoPolicyContract> {
    console.log(`\n📚 Stage 8: Analyzing repository policy & conventions for: ${owner}/${repo}`);

    // 1. Harvest PR and Issue templates
    let prTemplate: string | undefined;
    let issueTemplate: string | undefined;

    try {
        const fetchedPrTemplate = await github.getPullRequestTemplate(owner, repo);
        if (fetchedPrTemplate && fetchedPrTemplate.trim().length > 10) {
            prTemplate = fetchedPrTemplate.trim();
            console.log(`[Policy] Harvested official PR template (${prTemplate.length} chars)`);
        }
    } catch (e) {}

    try {
        const templates = await github.getIssueTemplates(owner, repo);
        // Find bug template
        const bugTemplate = templates.find(t => 
            t.filename.toLowerCase().includes("bug") || 
            t.content.toLowerCase().includes("steps to reproduce") ||
            t.content.toLowerCase().includes("expected behavior")
        ) || templates[0];
        if (bugTemplate) {
            issueTemplate = bugTemplate.content.trim();
            console.log(`[Policy] Harvested official issue template: ${bugTemplate.filename}`);
        }
    } catch (e) {}

    // 2. Extract Merge Patterns
    const styleGuide = await extractMergePatterns(github, owner, repo);

    // 3. Analyze CONTRIBUTING.md for CLA, DCO, and linters
    let requiresCLA = false;
    let claUrl: string | undefined;
    let claInstructions: string | undefined;
    let requiresDCO = false;

    if (contributingMd && contributingMd.trim().length > 20) {
        const lower = contributingMd.toLowerCase();
        
        // Check for CLA
        if (lower.includes("contributor license agreement") || lower.includes("cla") || lower.includes("individual cla")) {
            // Check if it's an actual requirement to sign
            if (lower.includes("sign") || lower.includes("agreement") || lower.includes("required") || lower.includes("easycla")) {
                requiresCLA = true;
                // Extract URL (e.g. [website]: url or https://...)
                const urlMatch = contributingMd.match(/https?:\/\/[^\s\)]+cla[^\s\)]*/i) ||
                                 contributingMd.match(/https?:\/\/[^\s\)]+legal[^\s\)]*/i);
                if (urlMatch) {
                    claUrl = urlMatch[0].replace(/[\.,\)]+$/, "");
                }
                claInstructions = `${owner}/${repo} requires contributors to sign a Contributor License Agreement (CLA) before code contributions can be accepted.${claUrl ? ` Link: ${claUrl}` : ""}`;
                console.log(`[Policy] ⚠️ CLA Required: ${claInstructions}`);
            }
        }

        // Check for DCO / Signed-off-by
        if (lower.includes("signed-off-by") || lower.includes("developer certificate of origin") || lower.includes("dco")) {
            requiresDCO = true;
            console.log(`[Policy] 📝 DCO / git commit -s required`);
        }
    }

    return {
        requiresCLA,
        claUrl,
        claInstructions,
        requiresDCO,
        styleGuide,
        prTemplate,
        issueTemplate
    };
}

export async function extractMergePatterns(
    github: GitHubService,
    owner: string,
    repo: string
): Promise<string> {
    console.log(`[Pattern Match] Analyzing recent merged PRs for: ${owner}/${repo}`);

    try {
        const recentPRs = await github.getRecentMergedPRs(owner, repo, 10);

        if (recentPRs.length === 0) {
            return "No specific merge patterns detected. Follow standard conventional commits.";
        }

        // Compile a corpus of recent successful PR descriptions
        const corpus = recentPRs.map((pr: any) => `
PR Title: ${pr.title}
Author: ${pr.user?.login}
Body:
${pr.body || "No description provided."}
---`).join('\n');

        const prompt = `
You are an expert open-source cultural analyst. 
I have provided you with a corpus of the last 10 successfully merged Pull Requests from ${owner}/${repo}.

Extract:
- PR body structure & headers used
- Issue linking convention ('Fixes #123' vs 'Closes #123')
- Title conventional commit pattern

Output a concise 4-5 bullet point style guide for drafting PRs.

### PR Corpus:
${corpus.substring(0, 40000)}
`;

        const { text } = await generateText({
            model: MODEL,
            prompt,
            system: "You are a stylistic analysis engine. Be extremely concise.",
        });

        return text.trim();
    } catch (e: any) {
        return "Follow standard conventional commits and structured Markdown summaries.";
    }
}

