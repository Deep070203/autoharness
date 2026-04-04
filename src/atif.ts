/**
 * ATIF (Agent Trajectory Interchange Format) v1.6 serializer.
 *
 * Converts Vercel AI SDK run results into the ATIF trajectory schema
 * expected by Harbor at /logs/trajectory.json.
 */

// ---------------------------------------------------------------------------
// ATIF types
// ---------------------------------------------------------------------------

export interface AtifToolCall {
    tool_call_id: string;
    function_name: string;
    arguments: Record<string, unknown>;
}

export interface AtifObservation {
    results: Array<{
        source_call_id: string;
        content: string;
    }>;
}

export interface AtifStep {
    step_id: number;
    timestamp: string;
    source: "agent" | "user";
    message: string;
    model_name?: string;
    reasoning_content?: string;
    tool_calls?: AtifToolCall[];
    observation?: AtifObservation;
}

export interface AtifMetrics {
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_cached_tokens: number;
    total_cost_usd: number | null;
    total_steps: number;
    extra: {
        duration_ms: number;
        num_turns: number;
    };
}

export interface AtifTrajectory {
    schema_version: string;
    session_id: string;
    agent: {
        name: string;
        version: string;
        model_name: string;
    };
    steps: AtifStep[];
    final_metrics: AtifMetrics;
}

// ---------------------------------------------------------------------------
// Step builder helper
// ---------------------------------------------------------------------------

function createStepBuilder() {
    let stepId = 0;
    const now = new Date().toISOString();

    return function makeStep(
        source: "agent" | "user",
        message: string,
        extra?: Partial<
            Pick<AtifStep, "model_name" | "reasoning_content" | "tool_calls" | "observation">
        >,
    ): AtifStep {
        stepId += 1;
        const step: AtifStep = {
            step_id: stepId,
            timestamp: now,
            source,
            message,
        };
        if (extra) {
            if (extra.model_name != null) step.model_name = extra.model_name;
            if (extra.reasoning_content != null) step.reasoning_content = extra.reasoning_content;
            if (extra.tool_calls != null) step.tool_calls = extra.tool_calls;
            if (extra.observation != null) step.observation = extra.observation;
        }
        return step;
    };
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

/**
 * Vercel AI SDK result shape (subset we rely on).
 * The full type from `ai` is `GenerateTextResult`, but we keep this
 * interface minimal so the adapter section doesn't import SDK internals.
 */
export interface AgentRunResult {
    /** Final text output from the agent. */
    text: string;

    /** Steps the agent took (tool calls, text generation, etc.). */
    steps: Array<{
        /** Text content generated in this step (may be empty). */
        text?: string;

        /** Tool calls made in this step. */
        toolCalls?: Array<{
            toolCallId: string;
            toolName: string;
            args: Record<string, unknown>;
        }>;

        /** Tool results received in this step. */
        toolResults?: Array<{
            toolCallId: string;
            toolName: string;
            result: unknown;
        }>;

        /** Token usage for this step. */
        usage?: {
            promptTokens: number;
            completionTokens: number;
        };

        /** Reasoning/thinking content if model supports it. */
        reasoning?: string;
    }>;

    /** Total token usage across all steps. */
    usage: {
        promptTokens: number;
        completionTokens: number;
    };

    /** Response ID (if available). */
    responseId?: string;
}

/**
 * Convert a Vercel AI SDK agent run result to an ATIF trajectory dict.
 */
export function toAtif(
    result: AgentRunResult,
    model: string,
    durationMs: number,
): AtifTrajectory {
    const makeStep = createStepBuilder();
    const steps: AtifStep[] = [];

    for (const step of result.steps) {
        // Reasoning / thinking content
        if (step.reasoning) {
            steps.push(
                makeStep("agent", "(thinking)", {
                    reasoning_content: step.reasoning,
                    model_name: model,
                }),
            );
        }

        // Text output
        if (step.text) {
            steps.push(
                makeStep("agent", step.text, { model_name: model }),
            );
        }

        // Tool calls + results
        if (step.toolCalls && step.toolCalls.length > 0) {
            for (const tc of step.toolCalls) {
                // Find matching result
                const tr = step.toolResults?.find((r) => r.toolCallId === tc.toolCallId);
                const outputStr = tr ? String(tr.result) : "";

                steps.push(
                    makeStep("agent", `Tool: ${tc.toolName}`, {
                        model_name: model,
                        tool_calls: [
                            {
                                tool_call_id: tc.toolCallId,
                                function_name: tc.toolName,
                                arguments: tc.args,
                            },
                        ],
                        observation: tr
                            ? {
                                results: [
                                    {
                                        source_call_id: tc.toolCallId,
                                        content: outputStr,
                                    },
                                ],
                            }
                            : undefined,
                    }),
                );
            }
        }
    }

    // Ensure at least one step
    if (steps.length === 0) {
        steps.push(makeStep("user", "(empty)"));
    }

    // Aggregate usage
    const totalPromptTokens = result.usage.promptTokens;
    const totalCompletionTokens = result.usage.completionTokens;

    return {
        schema_version: "ATIF-v1.6",
        session_id: result.responseId ?? "unknown",
        agent: {
            name: "autoharness",
            version: "0.1.0",
            model_name: model,
        },
        steps,
        final_metrics: {
            total_prompt_tokens: totalPromptTokens,
            total_completion_tokens: totalCompletionTokens,
            total_cached_tokens: 0,
            total_cost_usd: null,
            total_steps: steps.length,
            extra: {
                duration_ms: durationMs,
                num_turns: result.steps.length,
            },
        },
    };
}
