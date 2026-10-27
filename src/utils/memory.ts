import * as fs from "fs";
import * as path from "path";
import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";

const MODEL: LanguageModel = google("gemini-3.5-flash") as unknown as LanguageModel;

export interface BehavioralRule {
    id: string;
    rule: string;
    scope: "global" | string; // 'global' or 'owner/repo'
    source: string; // e.g. "arxiv:2607.13091", "human-review", "ci-failure"
    createdAt: string;
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
    private storagePath: string;
    private memory: RulesStorage;

    constructor(storageDir: string = ".autoharness") {
        const resolvedDir = path.resolve(storageDir);
        if (!fs.existsSync(resolvedDir)) {
            fs.mkdirSync(resolvedDir, { recursive: true });
        }
        this.storagePath = path.join(resolvedDir, "rules.json");
        this.memory = this.load();
    }

    private load(): RulesStorage {
        if (fs.existsSync(this.storagePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.storagePath, "utf-8"));
                if (data && Array.isArray(data.rules)) {
                    return data;
                }
            } catch (e) {
                console.warn(`[BehavioralMemory] Could not load rules from ${this.storagePath}, resetting.`);
            }
        }

        const initial: RulesStorage = {
            version: 1,
            rules: [...DEFAULT_GLOBAL_RULES]
        };
        this.save(initial);
        return initial;
    }

    private save(data: RulesStorage) {
        fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), "utf-8");
    }

    /**
     * Retrieve relevant behavioral rules formatted as prompt injection text.
     */
    public getFormattedRules(owner?: string, repo?: string): string {
        const repoKey = owner && repo ? `${owner}/${repo}`.toLowerCase() : null;
        const relevant = this.memory.rules.filter(r => 
            r.scope === "global" || (repoKey && r.scope.toLowerCase() === repoKey)
        );

        if (relevant.length === 0) return "";

        return relevant.map((r, i) => `${i + 1}. [${r.scope}] ${r.rule}`).join("\n");
    }

    /**
     * Adds an explicit rule into the memory store.
     */
    public addRule(ruleText: string, scope: string = "global", source: string = "human-review") {
        const trimmed = ruleText.trim();
        if (!trimmed) return;

        // Deduplication check
        const exists = this.memory.rules.some(r => r.rule.toLowerCase() === trimmed.toLowerCase());
        if (exists) return;

        const newRule: BehavioralRule = {
            id: `rule_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            rule: trimmed,
            scope: scope,
            source: source,
            createdAt: new Date().toISOString()
        };

        this.memory.rules.push(newRule);
        this.save(this.memory);
        console.log(`[BehavioralMemory] 🧠 Learned new rule (${scope}): "${trimmed}"`);
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
Extract 1 concrete, imperative, reusable behavioral rule that will prevent this specific mistake or enforce this standard in future agent runs.
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
                this.addRule(rule, `${owner}/${repo}`, wasApproved ? "human_approval_note" : "human_rejection_lesson");
            }
        } catch (e: any) {
            console.warn(`[BehavioralMemory] Failed to distill rule from feedback: ${e.message}`);
        }
    }
}
