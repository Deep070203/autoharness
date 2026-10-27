import { EventEmitter } from "node:events";
import { GitHubService } from "../utils/github.js";
import { BehavioralMemory } from "../utils/memory.js";
import { runOuroborosInterview } from "./interview.js";
import { deduplicateCandidate } from "./deduplicate.js";
import {
    reproduceCandidateLocally,
    analyzeIssueLocally,
    attemptReproductionProof,
    type ReproductionResult
} from "./reproduce.js";
import { runLocalization, type LocalizationResult } from "./localize.js";
import { runVerification, type VerificationResult } from "./verify.js";
import { extractMergePatterns } from "./style.js";
import { runCodeFixAgent, type CodeFixResult } from "./codefix.js";
import { draftPullRequest } from "./drafting.js";
import { submitPullRequest } from "./submit.js";
import { execSync } from "node:child_process";

export interface PipelineOptions {
    repo: string; // "owner/repo"
    issueNumber?: number;
    similarPrNumber?: number;
    similarIssueNumber?: number;
    waitForGate?: (gateData: {
        draft: { title: string; body: string };
        codeFix: CodeFixResult;
        diff: string;
        verification: VerificationResult;
        targetOwner: string;
        targetRepo: string;
    }) => Promise<{ approved: boolean; notes?: string }>;
}

export interface PipelineEvent {
    type:
        | "stage:start"
        | "stage:log"
        | "stage:complete"
        | "proof:established"
        | "localization:complete"
        | "codefix:complete"
        | "diff:ready"
        | "verification:complete"
        | "gate:waiting"
        | "gate:resolved"
        | "pr:submitted"
        | "pipeline:error"
        | "pipeline:done";
    stage?: string;
    data?: any;
    timestamp: string;
}

export class PipelineEngine extends EventEmitter {
    private isRunning: boolean = false;
    private memory: BehavioralMemory;
    private github: GitHubService;

    constructor() {
        super();
        this.memory = new BehavioralMemory();
        this.github = new GitHubService();
    }

    public getMemory(): BehavioralMemory {
        return this.memory;
    }

    public emitPipelineEvent(type: PipelineEvent["type"], stage?: string, data?: any) {
        const event: PipelineEvent = {
            type,
            stage,
            data,
            timestamp: new Date().toISOString()
        };
        this.emit("event", event);
    }

    public async execute(options: PipelineOptions): Promise<{ success: boolean; prUrl?: string; error?: string }> {
        if (this.isRunning) {
            throw new Error("Pipeline is already executing.");
        }

        this.isRunning = true;
        const [targetOwner, targetRepo] = options.repo.split("/");

        if (!targetOwner || !targetRepo) {
            this.isRunning = false;
            throw new Error(`Invalid repository format: ${options.repo}. Expected "owner/repo"`);
        }

        this.emitPipelineEvent("stage:start", "SCOUT", { repo: options.repo, issue: options.issueNumber });

        try {
            // ── Stage 1 & 2: Sourcing ──────────────────────────────────────
            this.emitPipelineEvent("stage:log", "SCOUT", `Connecting to GitHub repository ${targetOwner}/${targetRepo}...`);
            let candidate: any = null;

            if (options.issueNumber) {
                this.emitPipelineEvent("stage:log", "SCOUT", `Fetching issue #${options.issueNumber}...`);
                const issue = await this.github.getIssue(targetOwner, targetRepo, options.issueNumber);
                candidate = {
                    number: issue.number,
                    pull_number: issue.number,
                    title: issue.title,
                    body: issue.body || "",
                    url: issue.html_url,
                    author: issue.user?.login || "unknown",
                    labels: issue.labels?.map((l: any) => typeof l === "string" ? l : l.name) || [],
                    sourceType: "issue"
                };
            } else {
                this.emitPipelineEvent("stage:log", "SCOUT", `Autonomous Hunter: scanning recent open bug issues...`);
                const openIssues = await this.github.getOpenBugIssues(targetOwner, targetRepo, 10);
                if (openIssues.length === 0) {
                    throw new Error(`No open bug issues found for ${targetOwner}/${targetRepo}`);
                }
                const first = openIssues[0];
                candidate = {
                    number: first.number,
                    pull_number: first.number,
                    title: first.title,
                    body: first.body || "",
                    url: first.html_url,
                    author: first.user?.login || "unknown",
                    labels: first.labels?.map((l: any) => typeof l === "string" ? l : l.name) || [],
                    sourceType: "issue"
                };
            }

            this.emitPipelineEvent("stage:complete", "SCOUT", { candidate });

            // ── Stage 3: Viability Interview ──────────────────────────────
            this.emitPipelineEvent("stage:start", "INTERVIEW", { title: candidate.title });
            this.emitPipelineEvent("stage:log", "INTERVIEW", `Running Ouroboros viability interview...`);
            const contributingMd = await this.github.getContributingGuidelines(targetOwner, targetRepo);
            const isViable = await runOuroborosInterview(candidate, contributingMd, this.github, targetOwner, targetRepo);

            if (!isViable && !options.issueNumber) {
                throw new Error(`Candidate #${candidate.number} was dropped by viability filter.`);
            }
            this.emitPipelineEvent("stage:complete", "INTERVIEW", { viable: true });

            // ── Stage 4: Deduplication ────────────────────────────────────
            this.emitPipelineEvent("stage:start", "DEDUPLICATE", { title: candidate.title });
            if (!options.issueNumber) {
                const isUnique = await deduplicateCandidate(candidate, this.github, targetOwner, targetRepo);
                if (!isUnique) {
                    throw new Error(`Candidate #${candidate.number} dropped as duplicate.`);
                }
            }
            this.emitPipelineEvent("stage:complete", "DEDUPLICATE", { unique: true });

            // ── Stage 5: Workspace Setup & Issue Analysis ─────────────────
            this.emitPipelineEvent("stage:start", "ANALYSIS", { repo: options.repo });
            this.emitPipelineEvent("stage:log", "ANALYSIS", `Cloning repository and analyzing root causes...`);
            const reproResult = await analyzeIssueLocally(candidate, this.github, targetOwner, targetRepo);
            if (!reproResult.viable) {
                throw new Error(`Issue analysis concluded not viable for automated patch.`);
            }
            this.emitPipelineEvent("stage:complete", "ANALYSIS", { analysis: reproResult.analysis });

            // ── Stage 6: Breken Proof Protocol (Reproduce First) ──────────
            this.emitPipelineEvent("stage:start", "REPRODUCE", { repoPath: reproResult.repoPath });
            this.emitPipelineEvent("stage:log", "REPRODUCE", `Attempting to formulate and execute failing reproduction command...`);
            const reproProof = await attemptReproductionProof(candidate, reproResult.repoPath);

            if (reproProof) {
                this.emitPipelineEvent("proof:established", "REPRODUCE", reproProof);
                this.emitPipelineEvent("stage:complete", "REPRODUCE", { proved: true, command: reproProof.command });
            } else {
                this.emitPipelineEvent("stage:log", "REPRODUCE", `Could not automatically trigger isolated failure; proceeding with contextual localization.`);
                this.emitPipelineEvent("stage:complete", "REPRODUCE", { proved: false });
            }

            // ── Stage 7: Agentless Fault Localization ──────────────────────
            this.emitPipelineEvent("stage:start", "LOCALIZE", { repoPath: reproResult.repoPath });
            this.emitPipelineEvent("stage:log", "LOCALIZE", `Pinpointing suspect files and function boundaries...`);
            const localization = await runLocalization(
                reproResult.repoPath,
                candidate.title,
                candidate.body,
                reproProof?.failureTrace || reproResult.analysis
            );
            this.emitPipelineEvent("localization:complete", "LOCALIZE", localization);
            this.emitPipelineEvent("stage:complete", "LOCALIZE", localization);

            // ── Stage 8: Style & Convention Extraction ───────────────────
            this.emitPipelineEvent("stage:start", "STYLE", { repo: options.repo });
            this.emitPipelineEvent("stage:log", "STYLE", `Extracting merge patterns from recent PRs...`);
            const repoStyleGuide = await extractMergePatterns(this.github, targetOwner, targetRepo);
            this.emitPipelineEvent("stage:complete", "STYLE", { styleGuide: repoStyleGuide });

            // ── Stage 9: Surgical Fixer (agy CLI) ─────────────────────────
            this.emitPipelineEvent("stage:start", "CODEFIX", { targets: localization.targetFiles });
            this.emitPipelineEvent("stage:log", "CODEFIX", `Invoking agy CLI with empirical SWE-bench & arXiv:2607.13091 prompt constraints...`);

            const accumulatedRules = this.memory.getFormattedRules(targetOwner, targetRepo);
            const codeFix = await runCodeFixAgent(
                reproResult,
                contributingMd,
                repoStyleGuide,
                "",
                localization,
                accumulatedRules,
                reproProof
            );

            if (!codeFix.success || codeFix.modifiedFiles.length === 0) {
                throw new Error(`CodeFix agent finished without producing verified changes: ${codeFix.summary}`);
            }

            // Extract git diff
            let gitDiff = "";
            try {
                gitDiff = execSync("git diff", { cwd: reproResult.repoPath, encoding: "utf-8" });
            } catch (e) {
                gitDiff = "(could not retrieve git diff)";
            }

            this.emitPipelineEvent("codefix:complete", "CODEFIX", { codeFix, diff: gitDiff });
            this.emitPipelineEvent("diff:ready", "CODEFIX", { diff: gitDiff, modifiedFiles: codeFix.modifiedFiles });
            this.emitPipelineEvent("stage:complete", "CODEFIX", { modifiedFiles: codeFix.modifiedFiles });

            // ── Stage 10: Verification & QA ───────────────────────────────
            this.emitPipelineEvent("stage:start", "VERIFY", { reproCommand: reproProof?.command });
            this.emitPipelineEvent("stage:log", "VERIFY", `Testing reproduction command and regression suite...`);
            const verification = await runVerification(reproResult.repoPath, reproProof?.command);
            this.emitPipelineEvent("verification:complete", "VERIFY", verification);
            this.emitPipelineEvent("stage:complete", "VERIFY", verification);

            // ── Stage 11: PR Drafting ─────────────────────────────────────
            this.emitPipelineEvent("stage:start", "DRAFTING", { candidate: candidate.title });
            const draft = await draftPullRequest(
                candidate,
                repoStyleGuide,
                codeFix,
                this.github,
                targetOwner,
                targetRepo,
                {
                    reproCommand: reproProof?.command,
                    failureTrace: reproProof?.failureTrace,
                    verification
                }
            );
            this.emitPipelineEvent("stage:complete", "DRAFTING", draft);

            // ── Stage 12: Human Review Gate (Closed-Loop Ratchet) ─────────
            this.emitPipelineEvent("stage:start", "GATE", { draft, diff: gitDiff });
            let gateApproved = false;
            let gateNotes: string | undefined;

            if (options.waitForGate) {
                this.emitPipelineEvent("gate:waiting", "GATE", { draft, diff: gitDiff, codeFix, verification });
                const gateResponse = await options.waitForGate({
                    draft,
                    codeFix,
                    diff: gitDiff,
                    verification,
                    targetOwner,
                    targetRepo
                });
                gateApproved = gateResponse.approved;
                gateNotes = gateResponse.notes;
            } else {
                // Default auto-approve if no gate handler registered
                gateApproved = true;
            }

            this.emitPipelineEvent("gate:resolved", "GATE", { approved: gateApproved, notes: gateNotes });

            if (gateNotes && gateNotes.trim().length > 5) {
                await this.memory.distillReviewFeedback(gateNotes, targetOwner, targetRepo, gateApproved);
            }

            if (!gateApproved) {
                this.emitPipelineEvent("stage:complete", "GATE", { status: "REJECTED" });
                this.isRunning = false;
                return { success: false, error: "Halted by human reviewer at approval gate." };
            }

            this.emitPipelineEvent("stage:complete", "GATE", { status: "APPROVED" });

            // ── Stage 13: Submission ──────────────────────────────────────
            this.emitPipelineEvent("stage:start", "SUBMIT", { draftTitle: draft.title });
            this.emitPipelineEvent("stage:log", "SUBMIT", `Pushing branch to fork and opening PR on GitHub...`);

            const prUrl = await submitPullRequest(
                this.github,
                targetOwner,
                targetRepo,
                draft,
                reproResult.localDirName,
                codeFix.modifiedFiles
            );

            if (prUrl) {
                this.emitPipelineEvent("pr:submitted", "SUBMIT", { prUrl, title: draft.title });
                this.emitPipelineEvent("stage:complete", "SUBMIT", { prUrl });
                this.emitPipelineEvent("pipeline:done", undefined, { success: true, prUrl });
                this.isRunning = false;
                return { success: true, prUrl };
            } else {
                throw new Error("GitHub submission failed during PR creation.");
            }

        } catch (err: any) {
            this.emitPipelineEvent("pipeline:error", undefined, { message: err.message });
            this.emitPipelineEvent("pipeline:done", undefined, { success: false, error: err.message });
            this.isRunning = false;
            return { success: false, error: err.message };
        }
    }
}
