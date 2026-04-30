export enum PipelineStage {
    SOURCING = "SOURCING",
    FILTERING = "FILTERING",
    INTERVIEW = "INTERVIEW",
    DEDUPLICATION = "DEDUPLICATION",
    REPRODUCTION = "REPRODUCTION",
    SCOPE_CHECK = "SCOPE_CHECK",
    PATTERN_MATCHING = "PATTERN_MATCHING",
    DRAFTING = "DRAFTING",
    HUMAN_REVIEW_GATE = "HUMAN_REVIEW_GATE",
    CLA_GATE = "CLA_GATE",
    FOLLOW_UP = "FOLLOW_UP",
    COMPLETED = "COMPLETED",
    DROPPED = "DROPPED"
}

export interface IssueState {
    targetOwner: string;
    targetRepo: string;
    candidateIdentifier: string; // E.g., the commit hash or PR number we are targeting
    currentStage: PipelineStage;
    forkUrl?: string;
    localBranchName?: string;
    draftPrNumber?: number;
    notes: string[];
}

export class StateManager {
    // This will interface with GitHub Issues to read/write state
    // For now, it will return stubs

    static parseIssueBody(body: string): IssueState | null {
        // Implementation will parse markdown checkboxes from issue body
        // E.g., looking for `[x] Stage 1 - Sourcing` 
        return null; // Stub
    }

    static generateIssueBody(state: IssueState): string {
        // Generates the markdown for the tracking issue
        return `# Pipeline Tracker: ${state.targetOwner}/${state.targetRepo}\n\nCurrent Stage: ${state.currentStage}`;
    }
}
