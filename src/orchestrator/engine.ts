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
import { extractMergePatterns, extractRepoPolicy, type RepoPolicyContract } from "./style.js";
import { runCodeFixAgent, type CodeFixResult } from "./codefix.js";
import { draftPullRequest, draftIssueForHuntedBug, type IssueDraft } from "./drafting.js";
import { submitPullRequest, type SubmissionResult } from "./submit.js";
import { BugHunterAgent } from "./hunter.js";
import type { TaskBlackboard } from "./blackboard.js";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface PipelineOptions {
    repo: string; // "owner/repo"
    issueNumber?: number;
    similarPrNumber?: number;
    similarIssueNumber?: number;
    waitForGate?: (gateData: {
        draft: { title: string; body: string };
        issueDraft?: IssueDraft;
        codeFix: CodeFixResult;
        diff: string;
        verification: VerificationResult;
        targetOwner: string;
        targetRepo: string;
        proposalId?: string;
        claNotice?: { required: boolean; url?: string; message: string };
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
            let candidate: any = null;
            let reproResult: ReproductionResult | null = null;
            let reproProof: { command: string; failureTrace: string } | undefined;
            let blackboard: TaskBlackboard | undefined;

            if (options.issueNumber) {
                // ── Mode 1: Targeted Issue Resolution ─────────────────────
                this.emitPipelineEvent("stage:log", "SCOUT", `Fetching issue #${options.issueNumber} from GitHub...`);
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

                this.emitPipelineEvent("stage:complete", "SCOUT", { candidate });

                // Viability interview. An explicit issue number is a request to try it.
                this.emitPipelineEvent("stage:start", "INTERVIEW", { title: candidate.title });
                const contributingMd = await this.github.getContributingGuidelines(targetOwner, targetRepo);
                const verdict = await runOuroborosInterview(candidate, contributingMd, this.github, targetOwner, targetRepo);
                const interviewNote = verdict.modelError
                    ? `Interview model error (${verdict.reason}). Continuing because an issue number was requested.`
                    : verdict.keep
                        ? `Viability filter kept this issue. ${verdict.reason}`
                        : `Viability filter would drop this issue (${verdict.reason}). Continuing because an issue number was requested.`;
                this.emitPipelineEvent("stage:log", "INTERVIEW", interviewNote);
                this.emitPipelineEvent("stage:complete", "INTERVIEW", { viable: verdict.keep, reason: verdict.reason });

                // Setup local workspace & analysis
                this.emitPipelineEvent("stage:start", "ANALYSIS", { repo: options.repo });
                reproResult = await analyzeIssueLocally(candidate, this.github, targetOwner, targetRepo);
                if (!reproResult.viable) {
                    throw new Error(`Issue analysis concluded not viable for automated patch.`);
                }
                this.emitPipelineEvent("stage:complete", "ANALYSIS", { analysis: reproResult.analysis });

                // Attempt Breken reproduction proof
                this.emitPipelineEvent("stage:start", "REPRODUCE", { repoPath: reproResult.repoPath });
                reproProof = await attemptReproductionProof(candidate, reproResult.repoPath);
                if (reproProof) {
                    this.emitPipelineEvent("proof:established", "REPRODUCE", reproProof);
                    this.emitPipelineEvent("stage:complete", "REPRODUCE", { proved: true, command: reproProof.command });
                } else {
                    this.emitPipelineEvent("stage:log", "REPRODUCE", `No direct automated reproduction command extracted; proceeding with contextual analysis.`);
                    this.emitPipelineEvent("stage:complete", "REPRODUCE", { proved: false });
                }

            } else {
                // ── Mode 2: True Autonomous Bug Hunter Mode (Zero-Issue) ──
                this.emitPipelineEvent("stage:start", "HUNTER", { repo: options.repo });
                this.emitPipelineEvent("stage:log", "HUNTER", `Cloning ${targetOwner}/${targetRepo} to prepare deep code audit...`);

                let forkUrl = `https://github.com/${targetOwner}/${targetRepo}.git`;
                let localDirName = targetRepo;
                if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN !== "placeholder_needs_token") {
                    try {
                        const forkData = await this.github.forkRepository(targetOwner, targetRepo);
                        forkUrl = forkData.clone_url;
                        localDirName = forkData.name;
                    } catch (e: any) {}
                }

                await this.github.cloneRepository(forkUrl, localDirName);
                const repoPath = path.join(this.github.baseDir, localDirName);

                this.emitPipelineEvent("stage:log", "HUNTER", `Auditing codebase against Breken bug archetypes (type panics, mutation, protocol drops, unhandled fallbacks)...`);
                const hunter = new BugHunterAgent(repoPath, targetOwner, targetRepo, this.memory);
                const huntedBug = await hunter.hunt((msg) => this.emitPipelineEvent("stage:log", "HUNTER", msg));

                if (huntedBug) {
                    this.emitPipelineEvent("stage:complete", "HUNTER", { bug: huntedBug });
                    candidate = {
                        number: 0,
                        pull_number: 0,
                        title: huntedBug.title,
                        body: `${huntedBug.description}\n\n**Archetype:** ${huntedBug.archetype}\n**Target File:** ${huntedBug.targetFile}`,
                        url: `https://github.com/${targetOwner}/${targetRepo}`,
                        author: "AutoHarness-Hunter",
                        labels: ["latent-bug", huntedBug.archetype],
                        sourceType: "hunted"
                    };

                    reproProof = {
                        command: huntedBug.probeCommand,
                        failureTrace: huntedBug.failureTrace
                    };

                    reproResult = {
                        viable: true,
                        diff: "",
                        analysis: huntedBug.description,
                        affectedFiles: [{ filename: huntedBug.targetFile, status: "modified", additions: 0, deletions: 0, patch: "" }],
                        repoPath,
                        localDirName,
                        prNumber: 0,
                        fixSummary: huntedBug.title,
                        reproCommand: huntedBug.probeCommand,
                        initialFailingTrace: huntedBug.failureTrace
                    };

                    blackboard = {
                        repo: {
                            owner: targetOwner,
                            name: targetRepo,
                            path: repoPath,
                            defaultBranch: "main"
                        },
                        memory: {
                            rules: [],
                            formattedRules: this.memory.getFormattedRules(targetOwner, targetRepo)
                        },
                        hunter: {
                            title: huntedBug.title,
                            description: huntedBug.description,
                            archetype: huntedBug.archetype,
                            targetFile: huntedBug.targetFile,
                            probeFilePath: huntedBug.probeFilePath,
                            probeCommand: huntedBug.probeCommand,
                            failureTrace: huntedBug.failureTrace
                        }
                    };

                    this.emitPipelineEvent("proof:established", "REPRODUCE", reproProof);
                    this.emitPipelineEvent("stage:complete", "SCOUT", { candidate });
                } else {
                    // Fallback to open issues if hunter didn't prove a latent bug
                    this.emitPipelineEvent("stage:log", "HUNTER", `No verifiable bug in the audited code. The notes above say why each probe was discarded. Looking at open GitHub issues next.`);
                    const openIssues = await this.github.getOpenBugIssues(targetOwner, targetRepo, 10);
                    if (openIssues.length === 0) {
                        throw new Error(`Hunter found no latent bugs and repository has no open bug reports.`);
                    }

                    this.emitPipelineEvent("stage:complete", "SCOUT", { fallback: true, openIssues: openIssues.length });

                    // Review several bug reports. One DROP used to abort the whole run.
                    this.emitPipelineEvent("stage:start", "INTERVIEW", { candidates: openIssues.length });
                    const contributingMd = await this.github.getContributingGuidelines(targetOwner, targetRepo);
                    const maxReviews = Math.min(openIssues.length, 5);
                    let lastDrop = "";
                    candidate = null;
                    for (let i = 0; i < maxReviews; i++) {
                        const issue = openIssues[i];
                        const next = {
                            number: issue.number,
                            pull_number: issue.number,
                            title: issue.title,
                            body: issue.body || "",
                            url: issue.html_url,
                            author: issue.user?.login || "unknown",
                            labels: issue.labels?.map((l: any) => typeof l === "string" ? l : l.name) || [],
                            sourceType: "issue"
                        };
                        this.emitPipelineEvent("stage:log", "INTERVIEW", `Reviewing issue #${next.number}: ${next.title}`);
                        const verdict = await runOuroborosInterview(next, contributingMd, this.github, targetOwner, targetRepo);
                        if (verdict.modelError) {
                            throw new Error(`Viability interview failed: ${verdict.reason}`);
                        }
                        if (verdict.keep) {
                            candidate = next;
                            this.emitPipelineEvent("stage:log", "INTERVIEW", `Keeping #${next.number}. ${verdict.reason}`);
                            this.emitPipelineEvent("stage:complete", "INTERVIEW", { viable: true, issue: next.number, reason: verdict.reason });
                            break;
                        }
                        lastDrop = `#${next.number}: ${verdict.reason}`;
                        this.emitPipelineEvent("stage:log", "INTERVIEW", `Dropped #${next.number}. ${verdict.reason}`);
                    }
                    if (!candidate) {
                        this.emitPipelineEvent("stage:complete", "INTERVIEW", { viable: false, reason: lastDrop });
                        throw new Error(`No open issue survived the viability filter after ${maxReviews} review(s). Last drop ${lastDrop}`);
                    }

                    this.emitPipelineEvent("stage:start", "ANALYSIS", { repo: options.repo });
                    reproResult = await analyzeIssueLocally(candidate, this.github, targetOwner, targetRepo);
                    this.emitPipelineEvent("stage:complete", "ANALYSIS", { analysis: reproResult.analysis });

                    this.emitPipelineEvent("stage:start", "REPRODUCE", { repoPath: reproResult.repoPath });
                    reproProof = await attemptReproductionProof(candidate, reproResult.repoPath);
                    if (reproProof) {
                        this.emitPipelineEvent("proof:established", "REPRODUCE", reproProof);
                    }
                    this.emitPipelineEvent("stage:complete", "REPRODUCE", { proved: Boolean(reproProof) });
                }
            }

            if (!reproResult) {
                throw new Error("Failed to initialize repository workspace.");
            }

            // ── Stage 7: Agentless Fault Localization ──────────────────────
            this.emitPipelineEvent("stage:start", "LOCALIZE", { repoPath: reproResult.repoPath });
            let localization: LocalizationResult;
            if (candidate.sourceType === "hunted") {
                this.emitPipelineEvent("stage:log", "LOCALIZE", `Target boundary verified by BugHunter: ${reproResult.affectedFiles[0].filename}`);
                localization = {
                    targetFiles: [reproResult.affectedFiles[0].filename],
                    likelyFunctions: [],
                    explanation: candidate.body
                };
            } else {
                this.emitPipelineEvent("stage:log", "LOCALIZE", `Pinpointing suspect files and function boundaries...`);
                localization = await runLocalization(
                    reproResult.repoPath,
                    candidate.title,
                    candidate.body,
                    reproProof?.failureTrace || reproResult.analysis
                );
            }
            this.emitPipelineEvent("localization:complete", "LOCALIZE", localization);
            this.emitPipelineEvent("stage:complete", "LOCALIZE", localization);
            if (!blackboard) {
                blackboard = {
                    repo: {
                        owner: targetOwner,
                        name: targetRepo,
                        path: reproResult.repoPath,
                        defaultBranch: "main"
                    },
                    memory: {
                        rules: [],
                        formattedRules: this.memory.getFormattedRules(targetOwner, targetRepo)
                    }
                };
            }
            blackboard.localization = localization;

            // ── Stage 8: Repository Policy & Convention Extraction ───────
            this.emitPipelineEvent("stage:start", "STYLE", { repo: options.repo });
            this.emitPipelineEvent("stage:log", "STYLE", `Analyzing CONTRIBUTING.md, templates, and CLA/DCO policies...`);
            const contributingMd = await this.github.getContributingGuidelines(targetOwner, targetRepo);
            const repoPolicy = await extractRepoPolicy(this.github, targetOwner, targetRepo, contributingMd);
            const repoStyleGuide = repoPolicy.styleGuide;
            this.emitPipelineEvent("stage:complete", "STYLE", { styleGuide: repoStyleGuide, policy: repoPolicy });

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
                reproProof,
                (msg) => this.emitPipelineEvent("stage:log", "CODEFIX", msg),
                blackboard
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

            // ── Stage 11: Issue & PR Drafting ─────────────────────────────
            this.emitPipelineEvent("stage:start", "DRAFTING", { candidate: candidate.title });

            let issueDraft: IssueDraft | undefined;
            if (candidate.sourceType === "hunted") {
                this.emitPipelineEvent("stage:log", "DRAFTING", `Drafting style-matched GitHub issue for discovered bug...`);
                issueDraft = await draftIssueForHuntedBug(
                    candidate,
                    this.github,
                    targetOwner,
                    targetRepo,
                    {
                        reproCommand: reproProof?.command,
                        failureTrace: reproProof?.failureTrace,
                        verification
                    },
                    repoPolicy.issueTemplate
                );
                if (blackboard) {
                    blackboard.issueDraft = issueDraft;
                }
            }

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
                },
                repoPolicy.prTemplate
            );
            this.emitPipelineEvent("stage:complete", "DRAFTING", { draft, issueDraft });

            // ── Stage 11.5: Proposal & Patch Vault Archival ──────────────
            let probeCodeContent: string | undefined;
            if (candidate.sourceType === "hunted") {
                try {
                    const probePath = blackboard?.hunter?.probeFilePath || path.join(reproResult.repoPath, "tests/test_hunted_probe.py");
                    if (fs.existsSync(probePath)) {
                        probeCodeContent = fs.readFileSync(probePath, "utf-8");
                    }
                } catch (e) {}
            }

            const proposalId = this.memory.saveProposal(
                targetOwner,
                targetRepo,
                {
                    status: "PENDING",
                    targetOwner,
                    targetRepo,
                    huntedBug: candidate.sourceType === "hunted" ? {
                        title: candidate.title,
                        description: candidate.body,
                        archetype: candidate.labels?.[1] || "latent-bug",
                        targetFile: reproResult.affectedFiles?.[0]?.filename || ""
                    } : undefined,
                    issueDraft,
                    prDraft: draft,
                    codeFix: {
                        summary: codeFix.summary,
                        modifiedFiles: codeFix.modifiedFiles,
                        confidence: codeFix.confidence
                    },
                    diff: gitDiff,
                    reproCommand: reproProof?.command,
                    failureTrace: reproProof?.failureTrace
                },
                probeCodeContent
            );

            // ── Stage 12: Human Review Gate (Closed-Loop Ratchet) ─────────
            const claNotice = repoPolicy.requiresCLA ? {
                required: true,
                url: repoPolicy.claUrl,
                message: repoPolicy.claInstructions || `⚠️ This repository requires contributors to sign a Contributor License Agreement (CLA) before PRs can be merged.${repoPolicy.claUrl ? ` Sign here: ${repoPolicy.claUrl}` : ''}`
            } : undefined;

            this.emitPipelineEvent("stage:start", "GATE", { draft, issueDraft, diff: gitDiff, proposalId, claNotice });
            if (claNotice) {
                this.emitPipelineEvent("stage:log", "GATE", `⚠️ ACTION REQUIRED: This repository requires contributors to sign a Contributor License Agreement (CLA) before contributions can be merged.`);
                if (claNotice.url) {
                    this.emitPipelineEvent("stage:log", "GATE", `👉 Please fill out and sign the CLA here: ${claNotice.url}`);
                }
            }
            let gateApproved = false;
            let gateNotes: string | undefined;

            if (options.waitForGate) {
                this.emitPipelineEvent("gate:waiting", "GATE", {
                    draft,
                    issueDraft,
                    diff: gitDiff,
                    codeFix,
                    verification,
                    proposalId,
                    claNotice
                });
                const gateResponse = await options.waitForGate({
                    draft,
                    issueDraft,
                    codeFix,
                    diff: gitDiff,
                    verification,
                    targetOwner,
                    targetRepo,
                    proposalId,
                    claNotice
                });
                gateApproved = gateResponse.approved;
                gateNotes = gateResponse.notes;
            } else {
                gateApproved = true;
            }

            this.emitPipelineEvent("gate:resolved", "GATE", { approved: gateApproved, notes: gateNotes });

            if (gateNotes && gateNotes.trim().length > 5) {
                await this.memory.distillReviewFeedback(gateNotes, targetOwner, targetRepo, gateApproved);
            }

            if (!gateApproved) {
                // Update proposal in vault as REJECTED with notes
                this.memory.updateProposalStatus(targetOwner, targetRepo, proposalId, "REJECTED", gateNotes);

                // Clean working tree to leave workspace pristine
                try {
                    execSync("git checkout . && git clean -fd", { cwd: reproResult.repoPath, encoding: "utf-8" });
                } catch (e) {}

                this.emitPipelineEvent("stage:complete", "GATE", { status: "REJECTED", proposalId });
                this.isRunning = false;
                return { success: false, error: "Halted by human reviewer at approval gate. Proposal archived in vault." };
            }

            this.emitPipelineEvent("stage:complete", "GATE", { status: "APPROVED", proposalId });

            // ── Stage 13: Two-Phase Submission (Issue + PR) ───────────────
            this.emitPipelineEvent("stage:start", "SUBMIT", { draftTitle: draft.title, issueTitle: issueDraft?.title });
            this.emitPipelineEvent("stage:log", "SUBMIT", `Executing two-phase submission on GitHub${repoPolicy.requiresDCO ? " (with DCO signoff)" : ""}...`);

            const submission = await submitPullRequest(
                this.github,
                targetOwner,
                targetRepo,
                draft,
                reproResult.localDirName,
                codeFix.modifiedFiles,
                undefined,
                issueDraft,
                repoPolicy.requiresDCO
            );

            if (submission && submission.prUrl) {
                // Update proposal in vault as APPROVED with PR & Issue links
                this.memory.updateProposalStatus(
                    targetOwner,
                    targetRepo,
                    proposalId,
                    "APPROVED",
                    gateNotes,
                    submission.issueNumber ? { issueNumber: submission.issueNumber, issueUrl: submission.issueUrl! } : undefined,
                    submission.prUrl
                );

                this.emitPipelineEvent("pr:submitted", "SUBMIT", {
                    prUrl: submission.prUrl,
                    issueUrl: submission.issueUrl,
                    issueNumber: submission.issueNumber,
                    title: draft.title
                });
                this.emitPipelineEvent("stage:complete", "SUBMIT", {
                    prUrl: submission.prUrl,
                    issueUrl: submission.issueUrl
                });
                this.emitPipelineEvent("pipeline:done", undefined, {
                    success: true,
                    prUrl: submission.prUrl,
                    issueUrl: submission.issueUrl
                });
                this.isRunning = false;
                return { success: true, prUrl: submission.prUrl };
            } else {
                throw new Error("GitHub submission failed during PR or Issue creation.");
            }

        } catch (err: any) {
            this.emitPipelineEvent("pipeline:error", undefined, { message: err.message });
            this.emitPipelineEvent("pipeline:done", undefined, { success: false, error: err.message });
            this.isRunning = false;
            return { success: false, error: err.message };
        }
    }
}
