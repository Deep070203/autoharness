import { parseArgs } from "node:util";
import { GitHubService } from "../src/utils/github.js";
import { BehavioralMemory } from "../src/utils/memory.js";
import { runOuroborosInterview } from "../src/orchestrator/interview.js";
import { deduplicateCandidate } from "../src/orchestrator/deduplicate.js";
import {
    reproduceCandidateLocally,
    analyzeIssueLocally,
    attemptReproductionProof,
    type ReproductionResult
} from "../src/orchestrator/reproduce.js";
import { runLocalization } from "../src/orchestrator/localize.js";
import { runVerification } from "../src/orchestrator/verify.js";
import { extractMergePatterns } from "../src/orchestrator/style.js";
import { runCodeFixAgent, type CodeFixResult } from "../src/orchestrator/codefix.js";
import { draftPullRequest, awaitHumanGates } from "../src/orchestrator/drafting.js";
import { submitPullRequest } from "../src/orchestrator/submit.js";

// ── Candidate type ───────────────────────────────────────────────────────
interface Candidate {
    number: number;
    pull_number: number;
    title: string;
    body: string;
    url: string;
    author: string;
    labels: string[];
    sourceType: "pr" | "issue";
}

// ── Stages 1 & 2: Sourcing & Filtering ──────────────────────────────────
async function runStage1And2(
    github: GitHubService,
    owner: string,
    repo: string,
    targetIssueNumber?: number
): Promise<Candidate[]> {
    console.log(`\n--- Stage 1: Candidate Sourcing for ${owner}/${repo} ---`);

    try {
        if (targetIssueNumber) {
            console.log(`Specific issue #${targetIssueNumber} requested. Fetching directly...`);
            try {
                const issue = await github.getIssue(owner, repo, targetIssueNumber);
                if (!issue.pull_request) {
                    console.log(`Successfully fetched issue #${targetIssueNumber}.`);
                    return [{
                        number: issue.number,
                        pull_number: issue.number,
                        title: issue.title,
                        body: issue.body || "",
                        url: issue.html_url,
                        author: issue.user?.login || "unknown",
                        labels: issue.labels?.map((l: any) => typeof l === "string" ? l : l.name) || [],
                        sourceType: "issue"
                    }];
                } else {
                    console.log(`Issue #${targetIssueNumber} is a pull request. Falling back to default selection.`);
                }
            } catch (e: any) {
                console.log(`Failed to fetch issue #${targetIssueNumber}: ${e.message}. Falling back...`);
            }
        }

        // ── Try merged PRs first ─────────────────────────────────────────
        const prs = await github.getRecentMergedPRs(owner, repo, 20);
        console.log(`Fetched ${prs.length} recently merged PRs.`);

        const contributing = await github.getContributingGuidelines(owner, repo);
        if (contributing) {
            console.log(`Fetched CONTRIBUTING.md (${contributing.length} chars).`);
        } else {
            console.log(`No CONTRIBUTING.md found.`);
        }

        // ── Fallback: source from open issues ────────────────────────────
        console.log(`\nSourcing from open issues...`);
        const issues = await github.getOpenBugIssues(owner, repo, 20);
        console.log(`Fetched ${issues.length} open issues.`);

        const issueCandidates: Candidate[] = issues.map((issue: any) => ({
            number: issue.number,
            pull_number: issue.number,
            title: issue.title,
            body: issue.body || "",
            url: issue.html_url,
            author: issue.user?.login || "unknown",
            labels: issue.labels?.map((l: any) => l.name) || [],
            sourceType: "issue" as const,
        }));

        const filteredIssues = issueCandidates.filter(c => {
            const text = (c.title + " " + c.body).toLowerCase();
            return text.includes("fix") || text.includes("bug") || text.includes("error")
                || text.includes("issue") || text.includes("broken") || text.includes("fail")
                || text.includes("wrong") || text.includes("missing") || text.includes("crash")
                || c.labels.some(l => l.toLowerCase().includes("bug"))
                || issueCandidates.length <= 5;
        });

        console.log(`Issue Candidates: ${issueCandidates.length} total, ${filteredIssues.length} after filter`);
        return filteredIssues;

    } catch (e: any) {
        console.error(`Failed during Stage 1/2:`, e.message);
        return [];
    }
}

// ── Main Pipeline ────────────────────────────────────────────────────────
async function main() {
    const { values } = parseArgs({
        options: {
            repo: { type: "string", short: "r", default: "semantica-agi/semantica" },
            issue: { type: "string", short: "i" },
            "similar-pr": { type: "string", short: "p" },
            "similar-issue": { type: "string", short: "s" },
            help: { type: "boolean", short: "h" }
        },
        allowPositionals: true
    });

    if (values.help) {
        console.log(`
AutoHarness — Autonomous Issue Resolver & Coding Agent
Usage:
  npx tsx bin/pipeline.ts [options]

Options:
  -r, --repo <owner/repo>       Target repository (default: semantica-agi/semantica)
  -i, --issue <number>          Specific GitHub issue number to reproduce and fix
  -p, --similar-pr <number>     Reference PR number for style and fix guidance
  -s, --similar-issue <number>  Reference issue number for extra guidance
  -h, --help                    Show this help message
        `);
        process.exit(0);
    }

    const repoInput = values.repo || "semantica-agi/semantica";
    const [targetOwner, targetRepo] = repoInput.split("/");

    if (!targetOwner || !targetRepo) {
        console.error(`Invalid repository format: "${repoInput}". Expected format: owner/repo (e.g. posthog/posthog-js)`);
        process.exit(1);
    }

    const targetIssueNumber = values.issue ? parseInt(values.issue, 10) : undefined;
    if (targetIssueNumber && isNaN(targetIssueNumber)) {
        console.error(`Invalid issue number provided: ${values.issue}`);
        process.exit(1);
    }

    const similarPrNumber = values["similar-pr"] ? parseInt(values["similar-pr"], 10) : undefined;
    if (similarPrNumber && isNaN(similarPrNumber)) {
        console.error(`Invalid similar PR number provided: ${values["similar-pr"]}`);
        process.exit(1);
    }

    const similarIssueNumber = values["similar-issue"] ? parseInt(values["similar-issue"], 10) : undefined;
    if (similarIssueNumber && isNaN(similarIssueNumber)) {
        console.error(`Invalid similar issue number provided: ${values["similar-issue"]}`);
        process.exit(1);
    }

    const github = new GitHubService();
    const memory = new BehavioralMemory();

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Autonomous Issue Resolver & Coding Agent`);
    console.log(`  Target: ${targetOwner}/${targetRepo}`);
    console.log(`  Closed-Loop Behavioral Memory: Active (arXiv:2607.13091)`);
    console.log(`${"═".repeat(60)}`);

    // ── Stages 1 & 2: Sourcing ──────────────────────────────────────────
    const candidates = await runStage1And2(github, targetOwner, targetRepo, targetIssueNumber);
    if (candidates.length === 0) {
        console.log("No candidates found. Exiting.");
        return;
    }

    // ── Stage 3: Ouroboros Viability Interview ───────────────────────────
    const contributingMd = await github.getContributingGuidelines(targetOwner, targetRepo);
    const viableCandidates: Candidate[] = [];

    for (const candidate of candidates.slice(0, 3)) {
        const isViable = await runOuroborosInterview(candidate, contributingMd, github, targetOwner, targetRepo);
        if (isViable) viableCandidates.push(candidate);
    }

    console.log(`\n--- Stage 3 Complete: ${viableCandidates.length} viable candidates ---`);
    if (viableCandidates.length === 0) { console.log("No viable candidates. Exiting."); return; }

    // ── Stage 4: Deduplication ───────────────────────────────────────────
    const uniqueCandidates: Candidate[] = [];
    for (const candidate of viableCandidates) {
        const isUnique = targetIssueNumber === candidate.number
            ? true
            : await deduplicateCandidate(candidate, github, targetOwner, targetRepo);
        if (isUnique) uniqueCandidates.push(candidate);
    }

    console.log(`\n--- Stage 4 Complete: ${uniqueCandidates.length} unique candidates ---`);
    if (uniqueCandidates.length === 0) { console.log("No unique candidates. Exiting."); return; }

    // ── Stage 5: Analysis & Workspace Preparation ────────────────────────
    let bestResult: ReproductionResult | null = null;
    let bestCandidate: Candidate | null = null;

    for (const candidate of uniqueCandidates) {
        let result: ReproductionResult;

        if (candidate.sourceType === "issue") {
            result = await analyzeIssueLocally(candidate, github, targetOwner, targetRepo);
        } else {
            result = await reproduceCandidateLocally(candidate, github, targetOwner, targetRepo);
        }

        if (result.viable) {
            bestResult = result;
            bestCandidate = candidate;
            break;
        } else {
            console.log(`[Pipeline] Candidate not viable at Stage 5: ${candidate.title}`);
        }
    }

    if (!bestResult || !bestCandidate) {
        console.log("No candidates survived Stage 5 analysis. Exiting.");
        return;
    }

    console.log(`\n--- Stage 5 Complete: Advancing '${bestCandidate.title}' (source: ${bestCandidate.sourceType}) ---`);

    // ── Breken Proof Protocol: Formulate & Verify Failing Repro ─────────
    let reproProof: { command: string; failureTrace: string } | undefined;
    if (bestCandidate.sourceType === "issue") {
        reproProof = await attemptReproductionProof(bestCandidate, bestResult.repoPath);
        if (reproProof) {
            console.log(`\n🔬 [Proof Protocol] Verified initial reproduction failure: \`${reproProof.command}\``);
        }
    }

    // ── Agentless Fault Localization (File & Symbol Boundary) ───────────
    const localization = await runLocalization(
        bestResult.repoPath,
        bestCandidate.title,
        bestCandidate.body,
        reproProof?.failureTrace || bestResult.analysis
    );

    // ── Fetch Guidance Context (Optional Similar Reference PR/Issue) ────
    let guidanceContext = "";
    if (similarPrNumber) {
        console.log(`Fetching guidance context from similar PR #${similarPrNumber}...`);
        try {
            const prDetails = await github.getPRDetails(targetOwner, targetRepo, similarPrNumber);
            const prDiff = await github.getPRDiff(targetOwner, targetRepo, similarPrNumber);
            guidanceContext += `\n### Similar Reference PR #${similarPrNumber}\n`;
            guidanceContext += `Title: ${prDetails.title}\n`;
            guidanceContext += `Description:\n${prDetails.body}\n`;
            guidanceContext += `\nUnified Diff:\n\`\`\`diff\n${prDiff.substring(0, 8000)}\n\`\`\`\n`;
        } catch (e: any) {
            console.error(`Failed to fetch similar PR #${similarPrNumber}: ${e.message}`);
        }
    }

    if (similarIssueNumber) {
        console.log(`Fetching guidance context from similar Issue #${similarIssueNumber}...`);
        try {
            const issueDetails = await github.getIssue(targetOwner, targetRepo, similarIssueNumber);
            guidanceContext += `\n### Similar Reference Issue #${similarIssueNumber}\n`;
            guidanceContext += `Title: ${issueDetails.title}\n`;
            guidanceContext += `Description:\n${issueDetails.body || "No description."}\n`;
        } catch (e: any) {
            console.error(`Failed to fetch similar Issue #${similarIssueNumber}: ${e.message}`);
        }
    }

    // ── Stage 8: Merge-Pattern Matching ──────────────────────────────────
    const repoStyleGuide = await extractMergePatterns(github, targetOwner, targetRepo);
    console.log(`\n--- Stage 8 Complete ---`);

    // ── Code Fix Agent (using agy CLI with empirical prompts) ────────────
    const accumulatedRules = memory.getFormattedRules(targetOwner, targetRepo);
    const codeFix: CodeFixResult = await runCodeFixAgent(
        bestResult,
        contributingMd,
        repoStyleGuide,
        guidanceContext,
        localization,
        accumulatedRules,
        reproProof
    );

    if (!codeFix.success) {
        console.log(`\n⚠️  Code Fix Agent did not produce a fix. Exiting.`);
        console.log(`   Reason: ${codeFix.summary}`);
        return;
    }

    console.log(`\n--- Code Fix Complete: ${codeFix.modifiedFiles.length} files changed ---`);

    // ── Verifier & QA Agent (SWE-bench / Breken Proof Contract) ─────────
    const verification = await runVerification(bestResult.repoPath, reproProof?.command);
    console.log(`[Verification Outcome]: ${verification.summary}`);

    // ── Stage 9 & 10: Drafting Proof-Backed PR ──────────────────────────
    const draft = await draftPullRequest(
        bestCandidate,
        repoStyleGuide,
        codeFix,
        github,
        targetOwner,
        targetRepo,
        {
            reproCommand: reproProof?.command,
            failureTrace: reproProof?.failureTrace,
            verification
        }
    );

    // ── Stage 11 & 12: Human Review Gate (Closed-Loop Ratchet) ──────────
    const isApproved = await awaitHumanGates(draft, codeFix, targetOwner, targetRepo, memory);
    if (!isApproved) {
        console.log(`Pipeline halted by human operator.`);
        return;
    }

    // ── Stage 13: Submission ────────────────────────────────────────────
    const prUrl = await submitPullRequest(
        github,
        targetOwner,
        targetRepo,
        draft,
        bestResult.localDirName,
        codeFix.modifiedFiles,
    );

    if (prUrl) {
        console.log(`\n🎉 Pipeline completed successfully!`);
        console.log(`   PR: ${prUrl}`);
    } else {
        console.log(`\n❌ Pipeline failed at submission.`);
    }
}

main().catch(console.error);
