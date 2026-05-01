import { GitHubService } from "../src/utils/github.js";
import { runOuroborosInterview } from "../src/orchestrator/interview.js";
import { deduplicateCandidate } from "../src/orchestrator/deduplicate.js";
import { reproduceCandidateLocally, type ReproductionResult } from "../src/orchestrator/reproduce.js";
import { extractMergePatterns } from "../src/orchestrator/style.js";
import { runCodeFixAgent, type CodeFixResult } from "../src/orchestrator/codefix.js";
import { draftPullRequest, awaitHumanGates } from "../src/orchestrator/drafting.js";
import { submitPullRequest } from "../src/orchestrator/submit.js";

// ── Candidate type enriched with pull_number ─────────────────────────────
interface Candidate {
    number: number;
    pull_number: number;
    title: string;
    body: string;
    url: string;
    author: string;
    labels: string[];
}

// ── Stages 1 & 2: Sourcing & Filtering ──────────────────────────────────
async function runStage1And2(github: GitHubService, owner: string, repo: string): Promise<Candidate[]> {
    console.log(`\n--- Stage 1: Candidate Sourcing for ${owner}/${repo} ---`);

    try {
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

        // Enrich candidates with pull_number and metadata
        const candidates: Candidate[] = prs.map((pr: any) => ({
            number: pr.number,
            pull_number: pr.number, // For search results, number IS the pull number
            title: pr.title,
            body: pr.body || "",
            url: pr.html_url,
            author: pr.user?.login || 'unknown',
            labels: pr.labels?.map((l: any) => l.name) || [],
        }));

        console.log(`Initial Candidates: ${candidates.length}`);

        // Filter: keep only PRs that look like bug fixes
        const filtered = candidates.filter(c => {
            const text = (c.title + ' ' + c.body).toLowerCase();
            return text.includes('fix') || text.includes('bug') || text.includes('patch')
                || text.includes('resolve') || text.includes('hotfix');
        });

        console.log(`After fix/bug filter: ${filtered.length}`);
        return filtered;

    } catch (e: any) {
        console.error(`Failed during Stage 1/2:`, e.message);
        return [];
    }
}

// ── Main Pipeline ────────────────────────────────────────────────────────
async function main() {
    const github = new GitHubService();

    const targetOwner = "Deep070203";
    const targetRepo = "autoharness";

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  OSS Contributor Pipeline: ${targetOwner}/${targetRepo}`);
    console.log(`${'═'.repeat(60)}`);

    // ── Stages 1 & 2 ────────────────────────────────────────────────────
    const candidates = await runStage1And2(github, targetOwner, targetRepo);
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
        const isUnique = await deduplicateCandidate(candidate, github, targetOwner, targetRepo);
        if (isUnique) uniqueCandidates.push(candidate);
    }

    console.log(`\n--- Stage 4 Complete: ${uniqueCandidates.length} unique candidates ---`);
    if (uniqueCandidates.length === 0) { console.log("No unique candidates. Exiting."); return; }

    // ── Stage 5: Real Analysis (replaces mock reproduction) ─────────────
    let bestResult: ReproductionResult | null = null;
    let bestCandidate: Candidate | null = null;

    for (const candidate of uniqueCandidates) {
        const result = await reproduceCandidateLocally(candidate, github, targetOwner, targetRepo);
        if (result.viable) {
            bestResult = result;
            bestCandidate = candidate;
            break; // Take the first viable one
        } else {
            console.log(`[Pipeline] Candidate not viable at Stage 5: ${candidate.title}`);
        }
    }

    if (!bestResult || !bestCandidate) {
        console.log("No candidates survived Stage 5 analysis. Exiting.");
        return;
    }

    console.log(`\n--- Stage 5 Complete: Advancing '${bestCandidate.title}' ---`);

    // ── Stage 8: Merge-Pattern Matching ──────────────────────────────────
    const repoStyleGuide = await extractMergePatterns(github, targetOwner, targetRepo);
    console.log(`\n--- Stage 8 Complete ---`);

    // ── Code Fix Agent (the real work) ──────────────────────────────────
    const codeFix: CodeFixResult = await runCodeFixAgent(bestResult, contributingMd, repoStyleGuide);

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
