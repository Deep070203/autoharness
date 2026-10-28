import type { BehavioralRule } from "../utils/memory.js";

/**
 * Shared Blackboard Context (TaskBlackboard)
 *
 * Implements a shared-memory Blackboard Architecture for the multi-agent harness.
 * All agents (Grounding, Hunter, Localizer, CodeFixer, Verifier, Drafter) read from
 * and contribute to this shared contract.
 */
export interface TaskBlackboard {
    /** Target repository metadata and environment specifics */
    repo: {
        owner: string;
        name: string;
        path: string;
        defaultBranch: string;
        detectedRunner?: string;
        baselinePassed?: boolean;
        baselineOutput?: string;
    };

    /** Scoped behavioral rules and conventions */
    memory: {
        rules: string[];
        formattedRules: string;
    };

    /** SWE Grounding: Recent git churn and commit history */
    grounding?: {
        recentCommits: { hash: string; message: string; diffStat: string }[];
        churnedFiles: string[];
    };

    /** Autonomous Bug Hunter findings */
    hunter?: {
        title: string;
        description: string;
        archetype: string;
        targetFile: string;
        probeFilePath: string;
        probeCommand: string;
        failureTrace: string;
    };

    /** Agentless Fault Localization results */
    localization?: {
        targetFiles: string[];
        likelyFunctions: string[];
        explanation: string;
        targetCodeSlices?: { file: string; content: string }[];
    };

    /** CodeFix Agent execution results */
    fix?: {
        modifiedFiles: string[];
        diff: string;
        summary: string;
        agentType: "agy_cli" | "integrated_tool_loop";
    };

    /** Verification & QA results */
    verification?: {
        passed: boolean;
        reproPassed: boolean;
        regressionPassed: boolean;
        reproOutput: string;
        regressionOutput: string;
        summary: string;
    };

    /** PR Draft and Submission */
    draft?: {
        title: string;
        body: string;
        branchName?: string;
        prUrl?: string;
    };
}
