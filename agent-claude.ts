/**
 * Single-file Harbor agent harness using Claude Agent SDK: --agent-import-path agent-claude:AutoAgent
 *
 * Top section: agent config (modify freely).
 * Bottom section: fixed adapter (Harbor integration + ATIF serialization).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKResultMessage, SDKAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import type { BaseEnvironment, AgentContext, ExecResult } from "./src/harbor.js";

// ============================================================================
//  EDITABLE HARNESS SECTION — the meta-agent modifies everything above the
//  "FIXED ADAPTER BOUNDARY" comment below.
// ============================================================================

const SYSTEM_PROMPT = `You are a highly capable task-completion agent. You solve tasks by reading instructions, analyzing the problem, writing and executing code, and producing the required output files.

## Approach
1. Read /task/instruction.md to understand what's required.
2. Explore the working environment — check what files, tools, and libraries are available.
3. Plan your approach, then execute step by step.
4. Write output files to the exact paths specified in the instructions.
5. Verify your output before finishing.

## Key rules
- Use python3 (not python) for running scripts.
- Use Bash to run shell commands, install packages, inspect files.
- For data analysis: pandas, numpy, openpyxl are available.
- For file manipulation: use standard Python or shell tools.
- Always verify output files exist and contain valid content before finishing.
- Read error messages carefully and fix issues iteratively.
- Never give up — try multiple approaches if one fails.`;

const AGENT_CWD = join(__dirname, ".agent");
const MODEL = "haiku";
const MAX_TURNS = 30;

function getOptions(toolsPreset: Record<string, any> = { type: 'preset', preset: 'claude_code' }): Options {
    return {
        systemPrompt: SYSTEM_PROMPT,
        cwd: AGENT_CWD,
        model: MODEL,
        maxTurns: MAX_TURNS,
        permissionMode: "bypassPermissions",
        thinking: { type: "enabled", budgetTokens: 10000 }
    };
}

// ============================================================================
//  FIXED ADAPTER BOUNDARY — Do not modify below this line.
//  Harbor integration + ATIF trajectory serialization.
// ============================================================================

/**
 * Local environment implementation for running inside Docker containers.
 * Executes commands via child_process and handles file operations locally.
 */
class LocalEnvironment implements BaseEnvironment {
    async exec(
        command: string,
        timeoutSec: number = 120,
        env?: Record<string, string>,
    ): Promise<ExecResult> {
        try {
            const stdout = execSync(command, {
                timeout: timeoutSec * 1000,
                encoding: "utf-8",
                env: { ...process.env, ...env },
                maxBuffer: 10 * 1024 * 1024, // 10 MB
            });
            return { stdout: stdout ?? "", stderr: "", exitCode: 0 };
        } catch (err: unknown) {
            const execErr = err as {
                stdout?: string;
                stderr?: string;
                status?: number;
            };
            return {
                stdout: execErr.stdout ?? "",
                stderr: execErr.stderr ?? "",
                exitCode: execErr.status ?? 1,
            };
        }
    }

    async uploadFile(sourcePath: string, targetPath: string): Promise<void> {
        const dir = targetPath.substring(0, targetPath.lastIndexOf("/"));
        if (dir) mkdirSync(dir, { recursive: true });
        copyFileSync(sourcePath, targetPath);
    }
}

function trajectoryToAtif(messages: SDKMessage[], resultMsg: SDKResultMessage | null): any {
    const steps: any[] = [];
    let stepId = 0;
    const now = new Date().toISOString();
    const pending: Record<string, any> = {};

    function addStep(source: string, message: string, extra: any = {}) {
        stepId++;
        steps.push({
            step_id: stepId,
            timestamp: now,
            source,
            message,
            ...extra
        });
    }

    // A simplified conversion since TypeScript sdk types for blocks might be complex
    for (const msg of messages) {
        if (msg.type === "user") {
            const m = msg as unknown as any; // Cast as SDKUserMessage
            // Handle tool results or content
            let contentStr = typeof m.message === 'string' ? m.message : JSON.stringify(m.message);
            addStep("user", contentStr);
        } else if (msg.type === "assistant") {
            const m = msg as unknown as any; // Cast as SDKAssistantMessage
            let contentStr = typeof m.message === 'string' ? m.message : JSON.stringify(m.message);
            addStep("agent", contentStr, { model_name: MODEL });
        }
    }

    let fm: any = null;
    if (resultMsg && resultMsg.type === 'result' && resultMsg.subtype === 'success') {
        const u = resultMsg.usage || {};
        fm = {
            total_prompt_tokens: u.input_tokens || 0,
            total_completion_tokens: u.output_tokens || 0,
            total_cached_tokens: u.cache_read_input_tokens || 0,
            total_cost_usd: resultMsg.total_cost_usd || 0,
            total_steps: steps.length,
            extra: {
                duration_ms: resultMsg.duration_ms,
                num_turns: resultMsg.num_turns
            }
        };
    }

    return {
        schema_version: "ATIF-v1.6",
        session_id: resultMsg ? (resultMsg as any).session_id || "unknown" : "unknown",
        agent: { name: "autoagent", version: "0.1.0", model_name: MODEL },
        steps: steps.length ? steps : [addStep("user", "(empty)")],
        final_metrics: fm
    };
}

async function runInContainer(): Promise<void> {
    const instruction = readFileSync("/task/instruction.md", "utf-8").trim();
    const opts = getOptions();

    const messages: SDKMessage[] = [];
    let resultMsg: SDKResultMessage | null = null;

    const q = query({ prompt: instruction, options: opts });

    for await (const msg of q) {
        messages.push(msg);
        if (msg.type === "result") {
            resultMsg = msg as SDKResultMessage;
        }
    }

    const atif = trajectoryToAtif(messages, resultMsg);
    const trajDir = "/logs/agent";
    mkdirSync(trajDir, { recursive: true });
    writeFileSync(
        join(trajDir, "trajectory.json"),
        JSON.stringify(atif, null, 2),
        "utf-8"
    );

    if (resultMsg && resultMsg.type === 'result' && resultMsg.subtype === 'success') {
        console.log(`cost_usd=${resultMsg.total_cost_usd.toFixed(4)} turns=${resultMsg.num_turns} duration_ms=${resultMsg.duration_ms}`);
    } else {
        console.log(`Query failed or stopped without success.`);
    }
}

export class AutoAgent {
    static readonly SUPPORTS_ATIF = true;
    private readonly _logsDir: string;
    private readonly _extraEnv: Record<string, string>;

    constructor(
        logsDir: string = "/logs/agent",
        extraEnv?: Record<string, string>,
    ) {
        this._logsDir = logsDir;
        this._extraEnv = extraEnv ? { ...extraEnv } : {};
        mkdirSync(this._logsDir, { recursive: true });
    }

    static agentName(): string {
        return "autoharness";
    }

    version(): string {
        return "0.1.0";
    }

    async setup(_environment: BaseEnvironment): Promise<void> {
    }

    async run(
        instruction: string,
        environment: BaseEnvironment,
        context: AgentContext,
    ): Promise<void> {
        await environment.exec("mkdir -p /task");

        const instrPath = join(this._logsDir, "instruction.md");
        writeFileSync(instrPath, instruction, "utf-8");
        await environment.uploadFile(instrPath, "/task/instruction.md");

        const env = { IS_SANDBOX: "1", ...process.env, ...this._extraEnv };

        const result = await environment.exec(
            "cd /app && npx tsx agent-claude.ts",
            600,
            env
        );

        if (result.stdout) {
            writeFileSync(join(this._logsDir, "agent_stdout.txt"), result.stdout);
        }
        if (result.stderr) {
            writeFileSync(join(this._logsDir, "agent_stderr.txt"), result.stderr);
        }

        const trajPath = join(this._logsDir, "trajectory.json");
        if (existsSync(trajPath)) {
            try {
                const traj = JSON.parse(readFileSync(trajPath, "utf-8"));
                const fm = traj.final_metrics || {};
                context.costUsd = fm.total_cost_usd;
                context.nInputTokens = fm.total_prompt_tokens || 0;
                context.nOutputTokens = fm.total_completion_tokens || 0;
                context.nCacheTokens = fm.total_cached_tokens || 0;
            } catch {
            }
        }
    }
}

const isMainModule =
    typeof process !== "undefined" &&
    process.argv[1] &&
    (process.argv[1].endsWith("agent-claude.ts") ||
        process.argv[1].endsWith("agent-claude.js"));

if (isMainModule) {
    runInContainer().catch((err) => {
        console.error("Agent failed:", err);
        process.exit(1);
    });
}
