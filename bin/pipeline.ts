import { parseArgs } from "node:util";
import { GitHubService } from "../src/utils/github.js";
import { runOuroborosInterview } from "../src/orchestrator/interview.js";
import { deduplicateCandidate } from "../src/orchestrator/deduplicate.js";
import { reproduceCandidateLocally, analyzeIssueLocally, type ReproductionResult } from "../src/orchestrator/reproduce.js";
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
    sourceType: 'pr' | 'issue';
}

// ── Stages 1 & 2: Sourcing & Filtering ──────────────────────────────────
async function runStage1And2(github: GitHubService, owner: string, repo: string, targetIssueNumber?: number): Promise<Candidate[]> {
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
                        author: issue.user?.login || 'unknown',
                        labels: issue.labels?.map((l: any) => typeof l === 'string' ? l : l.name) || [],
                        sourceType: 'issue'
                    }];
                } else {
                    console.log(`Issue #${targetIssueNumber} is a pull request. Falling back to default selection.`);
                }
            } catch (e: any) {
                console.log(`Failed to fetch issue #${targetIssueNumber} (might not exist): ${e.message}. Falling back to default selection...`);
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

        // ── Stage 2: Filtering ───────────────────────────────────────────
        console.log(`\n--- Stage 2: Filtering ---`);

        // Build candidates from merged PRs
        const prCandidates: Candidate[] = []

        // Filter: keep only PRs that look like bug fixes
        console.log(`PR Candidates: ${prCandidates.length}`);
        // return prCandidates;

        // ── Fallback: source from open issues ────────────────────────────
        console.log(`\nNo merged PR candidates. Falling back to open issues...`);
        const issues = await github.getOpenBugIssues(owner, repo, 20);
        console.log(`Fetched ${issues.length} open issues.`);

        const issueCandidates: Candidate[] = issues.map((issue: any) => ({
            number: issue.number,
            pull_number: issue.number, // reused field — means "issue number" in issue mode
            title: issue.title,
            body: issue.body || "",
            url: issue.html_url,
            author: issue.user?.login || 'unknown',
            labels: issue.labels?.map((l: any) => l.name) || [],
            sourceType: 'issue' as const,
        }));

        // For issues, be more permissive — any open issue is a candidate
        const filteredIssues = issueCandidates.filter(c => {
            const text = (c.title + ' ' + c.body).toLowerCase();
            return text.includes('fix') || text.includes('bug') || text.includes('error')
                || text.includes('issue') || text.includes('broken') || text.includes('fail')
                || text.includes('wrong') || text.includes('missing') || text.includes('crash')
                || c.labels.some(l => l.toLowerCase().includes('bug'))
                || issueCandidates.length <= 5; // if few issues, take them all
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
            issue: { type: 'string', short: 'i' },
            "similar-pr": { type: 'string', short: 'p' },
            "similar-issue": { type: 'string', short: 's' }
        },
        allowPositionals: true
    });

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

    const targetOwner = "prowler-cloud";
    const targetRepo = "prowler";

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  OSS Contributor Pipeline: ${targetOwner}/${targetRepo}`);
    console.log(`${'═'.repeat(60)}`);

    // ── Stages 1 & 2 ────────────────────────────────────────────────────
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

    // ── Stage 5: Analysis (PR mode or Issue mode) ────────────────────────
    let bestResult: ReproductionResult | null = null;
    let bestCandidate: Candidate | null = null;

    for (const candidate of uniqueCandidates) {
        let result: ReproductionResult;

        if (candidate.sourceType === 'issue') {
            // Issue mode: no diff, analyze the issue body directly
            result = await analyzeIssueLocally(candidate, github, targetOwner, targetRepo);
        } else {
            // PR mode: fetch diff and analyze the fix pattern
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

    // ── Fetch Guidance Context (if similar PR or Issue number is specified) ──
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

    // ── Code Fix Agent (the real work) ──────────────────────────────────
    const codeFix: CodeFixResult = await runCodeFixAgent(bestResult, contributingMd, repoStyleGuide, guidanceContext);

    if (!codeFix.success) {
        console.log(`\n⚠️  Code Fix Agent did not produce a fix. Exiting.`);
        console.log(`   Reason: ${codeFix.summary}`);
        return;
    }

    console.log(`\n--- Code Fix Complete: ${codeFix.modifiedFiles.length} files changed ---`);

    // ── Stage 9 & 10: Drafting (using real code changes) ────────────────
    const draft = await draftPullRequest(bestCandidate, repoStyleGuide, codeFix, github, targetOwner, targetRepo);

    // ── Stage 11 & 12: Human Review Gate ────────────────────────────────
    const isApproved = await awaitHumanGates(draft, codeFix);
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
