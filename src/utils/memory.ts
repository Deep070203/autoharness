import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";

const MODEL: LanguageModel = google("gemini-3.8-flash") as unknown as LanguageModel;

export interface BehavioralRule {
    id: string;
    rule: string;
    scope: "global" | string; // 'global' or 'owner/repo'
    source: string; // e.g. "arxiv:2607.13091", "human-review", "ci-failure"
    createdAt: string;
}

export interface ProbesHistory {
    testedSignatures: string[];
    confirmedBugs: { title: string; targetFile: string; confirmedAt: string }[];
}

export interface RepoEnvironment {
    detectedRunner?: string;
    baselinePassed?: boolean;
    baselineDurationMs?: number;
    lastTestedAt?: string;
}

export interface ProposalRecord {
    id: string;
    timestamp: string;
    status: "PENDING" | "APPROVED" | "REJECTED";
    rejectionNotes?: string;
    targetOwner: string;
    targetRepo: string;
    huntedBug?: {
        title: string;
        description: string;
        archetype: string;
        targetFile: string;
    };
    issueDraft?: {
        title: string;
        body: string;
        issueNumber?: number;
        issueUrl?: string;
    };
    prDraft?: {
        title: string;
        body: string;
        prUrl?: string;
    };
    codeFix?: {
        summary: string;
        modifiedFiles: string[];
        confidence: string;
    };
    diff: string;
    reproCommand?: string;
    failureTrace?: string;
}

interface RulesStorage {
    version: number;
    rules: BehavioralRule[];
}

const DEFAULT_GLOBAL_RULES: BehavioralRule[] = [
    {
        id: "rule_repro_first",
        rule: "Write and execute an isolated reproduction test demonstrating the bug before writing the fix. The test must fail first.",
        scope: "global",
        source: "breken_core",
        createdAt: "2026-10-27T00:00:00.000Z"
    },
    {
        id: "rule_surgical_diff",
        rule: "Keep patches strictly minimal and surgical. Never reformat, rename, or reorganize unrelated code.",
        scope: "global",
        source: "swe_agent_aci",
        createdAt: "2026-10-27T00:00:00.000Z"
    },
    {
        id: "rule_no_test_deletion",
        rule: "Never comment out, delete, or relax failing assertions in existing tests to force CI to pass.",
        scope: "global",
        source: "arxiv:2607.13091",
        createdAt: "2026-10-27T00:00:00.000Z"
    },
    {
        id: "rule_style_parity",
        rule: "Adhere to the repository's commit convention (e.g. conventional commits 'fix(scope): ...') and coding style.",
        scope: "global",
        source: "agentless",
        createdAt: "2026-10-27T00:00:00.000Z"
    },
    {
        id: "rule_zero_narration",
        rule: "Do not produce conversational narration. Execute terminal commands and file edits directly.",
        scope: "global",
        source: "swe_agent_aci",
        createdAt: "2026-10-27T00:00:00.000Z"
    }
];

export class BehavioralMemory {
    private baseDir: string;
    private globalStoragePath: string;

    constructor(storageDir?: string) {
        const defaultStorage = process.env.AUTOHARNESS_DATA_DIR || path.join(os.homedir(), ".autoharness");
        this.baseDir = path.resolve(storageDir || defaultStorage);
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
        this.migrateLegacyStorage();
        this.globalStoragePath = path.join(this.baseDir, "global_rules.json");
        this.ensureGlobalDefaults();
    }

    private migrateLegacyStorage() {
        const legacyDir = path.resolve(".autoharness");
        if (legacyDir !== this.baseDir && fs.existsSync(legacyDir)) {
            try {
                const copyRecursive = (src: string, dest: string) => {
                    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                    for (const item of fs.readdirSync(src)) {
                        const srcItem = path.join(src, item);
                        const destItem = path.join(dest, item);
                        if (fs.statSync(srcItem).isDirectory()) {
                            copyRecursive(srcItem, destItem);
                        } else if (!fs.existsSync(destItem)) {
                            fs.copyFileSync(srcItem, destItem);
                        }
                    }
                };
                copyRecursive(legacyDir, this.baseDir);
            } catch (e) {
                console.warn("[Memory] Migration from legacy storage warning:", e);
            }
        }
    }

    private ensureGlobalDefaults() {
        if (!fs.existsSync(this.globalStoragePath)) {
            const initial: RulesStorage = {
                version: 1,
                rules: [...DEFAULT_GLOBAL_RULES]
            };
            fs.writeFileSync(this.globalStoragePath, JSON.stringify(initial, null, 2), "utf-8");
        }
    }

    private getRepoDir(owner: string, repo: string): string {
        const repoDir = path.join(this.baseDir, "repos", owner.toLowerCase(), repo.toLowerCase());
        if (!fs.existsSync(repoDir)) {
            fs.mkdirSync(repoDir, { recursive: true });
        }
        return repoDir;
    }

    private loadGlobalRules(): BehavioralRule[] {
        try {
            if (fs.existsSync(this.globalStoragePath)) {
                const data = JSON.parse(fs.readFileSync(this.globalStoragePath, "utf-8"));
                if (data && Array.isArray(data.rules)) return data.rules;
            }
        } catch (e) {}
        return [...DEFAULT_GLOBAL_RULES];
    }

    private loadRepoRules(owner: string, repo: string): BehavioralRule[] {
        const repoDir = this.getRepoDir(owner, repo);
        const rulesPath = path.join(repoDir, "memory.json");
        if (fs.existsSync(rulesPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
                if (data && Array.isArray(data.rules)) return data.rules;
            } catch (e) {}
        }
        return [];
    }

    private saveRepoRules(owner: string, repo: string, rules: BehavioralRule[]) {
        const repoDir = this.getRepoDir(owner, repo);
        const rulesPath = path.join(repoDir, "memory.json");
        fs.writeFileSync(rulesPath, JSON.stringify({ version: 1, rules }, null, 2), "utf-8");
    }

    /**
     * Retrieve relevant behavioral rules formatted as prompt injection text.
     * Strictly combines global baseline guardrails with repository-isolated rules.
     */
    public getFormattedRules(owner?: string, repo?: string): string {
        const globalRules = this.loadGlobalRules();
        let combined = [...globalRules];

        if (owner && repo) {
            const repoRules = this.loadRepoRules(owner, repo);
            combined = [...combined, ...repoRules];
        }

        if (combined.length === 0) return "";
        return combined.map((r, i) => `${i + 1}. [${r.scope}] ${r.rule}`).join("\n");
    }

    /**
     * Adds an explicit rule into the memory store.
     * If owner/repo are provided, writes strictly to that repository's memory.json.
     */
    public addRule(ruleText: string, scope: string = "global", source: string = "human-review", owner?: string, repo?: string) {
        const trimmed = ruleText.trim();
        if (!trimmed) return;

        if (owner && repo) {
            const current = this.loadRepoRules(owner, repo);
            const exists = current.some(r => r.rule.toLowerCase() === trimmed.toLowerCase());
            if (exists) return;

            const newRule: BehavioralRule = {
                id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                rule: trimmed,
                scope: `${owner}/${repo}`,
                source: source,
                createdAt: new Date().toISOString()
            };

            current.push(newRule);
            this.saveRepoRules(owner, repo, current);
            console.log(`[BehavioralMemory] 🧠 Learned repo-specific rule (${owner}/${repo}): "${trimmed}"`);
        } else {
            // Global scope
            const current = this.loadGlobalRules();
            const exists = current.some(r => r.rule.toLowerCase() === trimmed.toLowerCase());
            if (exists) return;

            const newRule: BehavioralRule = {
                id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                rule: trimmed,
                scope: "global",
                source: source,
                createdAt: new Date().toISOString()
            };

            current.push(newRule);
            fs.writeFileSync(this.globalStoragePath, JSON.stringify({ version: 1, rules: current }, null, 2), "utf-8");
            console.log(`[BehavioralMemory] 🧠 Learned global rule: "${trimmed}"`);
        }
    }

    /**
     * Records a tested probe signature to avoid redundant re-testing.
     */
    public recordProbeHistory(owner: string, repo: string, signature: string, confirmedBug?: { title: string; targetFile: string }) {
        const repoDir = this.getRepoDir(owner, repo);
        const historyPath = path.join(repoDir, "probes_history.json");
        let history: ProbesHistory = { testedSignatures: [], confirmedBugs: [] };
        if (fs.existsSync(historyPath)) {
            try {
                history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
            } catch (e) {}
        }

        if (!history.testedSignatures.includes(signature)) {
            history.testedSignatures.push(signature);
        }
        if (confirmedBug) {
            history.confirmedBugs.push({
                ...confirmedBug,
                confirmedAt: new Date().toISOString()
            });
        }
        fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
    }

    /**
     * Checks if a probe hypothesis signature was already tested on this repository.
     */
    public isProbeAlreadyTested(owner: string, repo: string, signature: string): boolean {
        const repoDir = this.getRepoDir(owner, repo);
        const historyPath = path.join(repoDir, "probes_history.json");
        if (fs.existsSync(historyPath)) {
            try {
                const history: ProbesHistory = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
                return history.testedSignatures?.includes(signature) || false;
            } catch (e) {}
        }
        return false;
    }

    /**
     * Saves detected repository environment (test runner, baseline health).
     */
    public saveRepoEnvironment(owner: string, repo: string, envData: RepoEnvironment) {
        const repoDir = this.getRepoDir(owner, repo);
        const envPath = path.join(repoDir, "environment.json");
        fs.writeFileSync(envPath, JSON.stringify(envData, null, 2), "utf-8");
    }

    /**
     * Retrieves detected repository environment if cached.
     */
    public getRepoEnvironment(owner: string, repo: string): RepoEnvironment | null {
        const repoDir = this.getRepoDir(owner, repo);
        const envPath = path.join(repoDir, "environment.json");
        if (fs.existsSync(envPath)) {
            try {
                return JSON.parse(fs.readFileSync(envPath, "utf-8"));
            } catch (e) {}
        }
        return null;
    }

    /**
     * Synthesizes and captures behavioral feedback from a human gate review (arXiv:2607.13091 closed loop).
     */
    public async distillReviewFeedback(feedback: string, owner: string, repo: string, wasApproved: boolean) {
        if (!feedback || feedback.trim().length < 5) return;

        const prompt = `
You are an expert meta-prompter implementing arXiv:2607.13091 (Accumulated Behavioral Rules for AI Coding Agents).
A human reviewer just evaluated an automated pull request for the repository ${owner}/${repo}.
Result: ${wasApproved ? "APPROVED WITH FEEDBACK" : "REJECTED"}
Reviewer comment / reason:
"""
${feedback}
"""

TASK:
Extract 1 concrete, imperative, reusable behavioral rule that will prevent this specific mistake or enforce this standard in future agent runs for ${owner}/${repo}.
Format: A single concise sentence (e.g., "Always ensure null checks on input before indexing into array" or "When editing Go handlers, never mutate grouped attrs").
If no generalizable rule can be extracted, output "NONE".
`;

        try {
            const { text } = await generateText({
                model: MODEL,
                prompt,
                system: "You distill human feedback into durable, actionable behavioral rules for AI coding agents."
            });

            const rule = text.trim().replace(/^Rule:\s*/i, "").replace(/^"/, "").replace(/"$/, "");
            if (rule && rule !== "NONE" && rule.length > 10) {
                this.addRule(rule, `${owner}/${repo}`, wasApproved ? "human_approval_note" : "human_rejection_lesson", owner, repo);
            }
        } catch (e: any) {
            console.warn(`[BehavioralMemory] Failed to distill rule from feedback: ${e.message}`);
        }
    }

    // ── Proposal & Patch Vault ───────────────────────────────────────────

    public getProposalsDir(owner: string, repo: string): string {
        const dir = path.join(this.getRepoDir(owner, repo), "proposals");
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    public saveProposal(
        owner: string,
        repo: string,
        proposal: Omit<ProposalRecord, "id" | "timestamp">,
        probeCode?: string
    ): string {
        const id = `prop_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const timestamp = new Date().toISOString();
        const record: ProposalRecord = {
            ...proposal,
            id,
            timestamp,
        };

        const propDir = path.join(this.getProposalsDir(owner, repo), id);
        fs.mkdirSync(propDir, { recursive: true });

        fs.writeFileSync(path.join(propDir, "metadata.json"), JSON.stringify(record, null, 2), "utf-8");
        if (proposal.diff) {
            fs.writeFileSync(path.join(propDir, "patch.diff"), proposal.diff, "utf-8");
        }
        if (probeCode) {
            fs.writeFileSync(path.join(propDir, "probe_test.py"), probeCode, "utf-8");
        }

        // Maintain index in proposals.json
        const indexFile = path.join(this.getRepoDir(owner, repo), "proposals.json");
        let proposals: ProposalRecord[] = [];
        try {
            if (fs.existsSync(indexFile)) {
                proposals = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
            }
        } catch (e) {}

        proposals.unshift(record);
        // Retention limit: keep last 30 proposals
        if (proposals.length > 30) {
            const pruned = proposals.splice(30);
            for (const old of pruned) {
                try {
                    fs.rmSync(path.join(this.getProposalsDir(owner, repo), old.id), { recursive: true, force: true });
                } catch (e) {}
            }
        }

        fs.writeFileSync(indexFile, JSON.stringify(proposals, null, 2), "utf-8");
        return id;
    }

    public updateProposalStatus(
        owner: string,
        repo: string,
        id: string,
        status: "APPROVED" | "REJECTED",
        rejectionNotes?: string,
        issueData?: { issueNumber: number; issueUrl: string },
        prUrl?: string
    ) {
        const propDir = path.join(this.getProposalsDir(owner, repo), id);
        const metaPath = path.join(propDir, "metadata.json");
        if (fs.existsSync(metaPath)) {
            try {
                const record: ProposalRecord = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
                record.status = status;
                if (rejectionNotes) record.rejectionNotes = rejectionNotes;
                if (issueData) {
                    record.issueDraft = {
                        ...(record.issueDraft || { title: "", body: "" }),
                        issueNumber: issueData.issueNumber,
                        issueUrl: issueData.issueUrl,
                    };
                }
                if (prUrl) {
                    record.prDraft = {
                        ...(record.prDraft || { title: "", body: "" }),
                        prUrl,
                    };
                }
                fs.writeFileSync(metaPath, JSON.stringify(record, null, 2), "utf-8");
            } catch (e) {}
        }

        // Also update proposals.json index
        const indexFile = path.join(this.getRepoDir(owner, repo), "proposals.json");
        try {
            if (fs.existsSync(indexFile)) {
                const proposals: ProposalRecord[] = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
                const target = proposals.find((p) => p.id === id);
                if (target) {
                    target.status = status;
                    if (rejectionNotes) target.rejectionNotes = rejectionNotes;
                    if (issueData) {
                        target.issueDraft = {
                            ...(target.issueDraft || { title: "", body: "" }),
                            issueNumber: issueData.issueNumber,
                            issueUrl: issueData.issueUrl,
                        };
                    }
                    if (prUrl) {
                        target.prDraft = {
                            ...(target.prDraft || { title: "", body: "" }),
                            prUrl,
                        };
                    }
                    fs.writeFileSync(indexFile, JSON.stringify(proposals, null, 2), "utf-8");
                }
            }
        } catch (e) {}
    }

    public getProposals(owner: string, repo: string): ProposalRecord[] {
        const indexFile = path.join(this.getRepoDir(owner, repo), "proposals.json");
        try {
            if (fs.existsSync(indexFile)) {
                return JSON.parse(fs.readFileSync(indexFile, "utf-8"));
            }
        } catch (e) {}
        return [];
    }

    public getProposal(owner: string, repo: string, id: string): { record: ProposalRecord; diff: string; probeCode?: string } | null {
        const propDir = path.join(this.getProposalsDir(owner, repo), id);
        const metaPath = path.join(propDir, "metadata.json");
        if (!fs.existsSync(metaPath)) return null;
        try {
            const record: ProposalRecord = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            let diff = "";
            let probeCode: string | undefined;
            const diffPath = path.join(propDir, "patch.diff");
            if (fs.existsSync(diffPath)) {
                diff = fs.readFileSync(diffPath, "utf-8");
            }
            const probePath = path.join(propDir, "probe_test.py");
            if (fs.existsSync(probePath)) {
                probeCode = fs.readFileSync(probePath, "utf-8");
            }
            return { record, diff, probeCode };
        } catch (e) {
            return null;
        }
    }
}

