/**
 * Single-file Harbor agent harness: --agent-import-path agent:AutoAgent
 *
 * LLM-agnostic via Vercel AI SDK. Change MODEL to switch providers:
 *   "openai/gpt-5"  |  "anthropic/claude-opus-4-1"  |  "google/gemini-2.5-pro"
 *
 * The MODEL string is passed directly to the Vercel AI SDK which resolves
 * it to the correct provider automatically (via @ai-sdk/* packages).
 *
 * Top section: editable harness (meta-agent modifies this).
 * Bottom section: fixed adapter (Harbor integration + ATIF serialization).
 */

import { ToolLoopAgent, tool, stepCountIs } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { initStagehand, createBrowserTools, closeStagehand } from "./src/tools/browser.js";
import { loadMCPConfig, connectMCPServers, mergeMCPTools, closeMCPServers, type MCPClientHandle } from "./src/tools/mcp.js";
import { createTerminalTools } from "./src/tools/terminal.js";
import { createComputerTools } from "./src/tools/computer.js";
import { toTOON, truncateAXI } from "./src/utils/toon.js";
import { execSync } from "node:child_process";

import type { BaseEnvironment, AgentContext, ExecResult } from "./src/harbor.js";
import { type AgentRunResult, toAtif } from "./src/atif.js";

// ============================================================================
//  EDITABLE HARNESS SECTION — the meta-agent modifies everything above the
//  "FIXED ADAPTER BOUNDARY" comment below.
// ============================================================================

const SYSTEM_PROMPT = "You are an agent that executes tasks";

/**
 * Model identifier in "provider/model-name" format.
 * Vercel AI SDK resolves this to the correct provider package automatically.
 * Requires the corresponding @ai-sdk/<provider> package to be installed.
 *
 * Examples:
 *   "openai/gpt-5"
 *   "anthropic/claude-opus-4-1"
 *   "google/gemini-2.5-pro"
 */
import { google } from "@ai-sdk/google";
const MODEL: LanguageModel = google("gemini-2.5-flash") as unknown as LanguageModel;
const MODEL_NAME = "google/gemini-2.5-flash";
const MAX_TURNS = 30;

/**
 * Create tools for the agent. Add new tools here.
 */
function createTools(environment: BaseEnvironment) {
    return {
        run_shell: tool({
            description:
                "Run a shell command in the task environment. Returns stdout and stderr.",
            inputSchema: z.object({
                command: z.string().describe("The shell command to execute"),
            }),
            execute: async (args) => {
                try {
                    const result = await environment.exec(args.command, 120);
                    let out = "";
                    if (result.stdout) out += truncateAXI(result.stdout, 2000);
                    if (result.stderr) {
                        out += out
                            ? `\nerror: ${truncateAXI(result.stderr, 1000)}`
                            : `error: ${truncateAXI(result.stderr, 1000)}`;
                    }
                    const final = out || "status: success (no output)";
                    return final + "\nhelp[1]: Run `run_shell` with `ls` to check the filesystem if unsure.";
                } catch (err: any) {
                    return `error: ${err.message || err}`;
                }
            },
        }),
    };
}

/**
 * Build the agent. Modify to add more tools, sub-agents, or change config.
 */
async function createAgent(environment: BaseEnvironment) {
    const baseTools = createTools(environment);

    // Browser tools (Stagehand) — gracefully unavailable if Chromium is missing
    let browserTools: Record<string, any> = {};
    try {
        const stagehand = await initStagehand();
        browserTools = createBrowserTools(stagehand);
        console.log(`[Agent] Browser tools enabled: ${Object.keys(browserTools).join(", ")}`);
    } catch (e: any) {
        console.warn(`[Agent] Browser tools unavailable: ${e.message}`);
    }

    // MCP tools (Dynamic discovery)
    let mcpTools: Record<string, any> = {};
    let mcpHandles: MCPClientHandle[] = [];
    try {
        const configs = loadMCPConfig();
        if (configs.length > 0) {
            mcpHandles = await connectMCPServers(configs);
            mcpTools = mergeMCPTools(mcpHandles);
            console.log(`[Agent] MCP tools enabled: ${Object.keys(mcpTools).join(", ")}`);
        }
    } catch (e: any) {
        console.warn(`[Agent] MCP tools unavailable: ${e.message}`);
    }

    // Computer-use tools (Gracefully unavailable if DISPLAY is not set/ready)
    let computerTools: Record<string, any> = {};
    try {
        computerTools = createComputerTools();
        console.log(`[Agent] Computer tools enabled: ${Object.keys(computerTools).join(", ")}`);
    } catch (e: any) {
        console.warn(`[Agent] Computer tools unavailable: ${e.message}`);
    }

    // Terminal tools (Persistent sessions)
    const terminalTools = createTerminalTools();

    return {
        agent: new ToolLoopAgent({
            model: MODEL,
            instructions: SYSTEM_PROMPT,
            tools: { ...baseTools, ...browserTools, ...terminalTools, ...computerTools, ...mcpTools },
            stopWhen: stepCountIs(MAX_TURNS),
        }),
        mcpHandles,
    };
}

/**
 * Run the agent on a task and return (result, durationMs).
 */
async function runTask(
    environment: BaseEnvironment,
    instruction: string,
): Promise<{ result: AgentRunResult; durationMs: number }> {
    // Feature 2: Start desktop if needed
    try {
        await environment.exec("bash scripts/start-desktop.sh", 15);
    } catch (e) {
        // Silently continue if desktop fails to start
    }

    const { agent, mcpHandles } = await createAgent(environment);
    const t0 = Date.now();

    // Feature 4: AXI - Ambient Context
    const ambientContext = `
## Ambient Context
cwd: ${process.cwd().replace(process.env.HOME || "", "~")}
bin: autoharness (agent-engineer)
tools: ${Object.keys((agent as any).tools).join(", ")}
`;

    const result = await agent.generate({ prompt: ambientContext + "\nTASK: " + instruction });
    const durationMs = Date.now() - t0;

    // Clean up resources after each task
    await closeStagehand();
    await closeMCPServers(mcpHandles);

    return { result: result as unknown as AgentRunResult, durationMs };
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

/**
 * Container entrypoint — reads instruction, runs agent, writes ATIF trajectory.
 */
async function runInContainer(): Promise<void> {
    const instruction = readFileSync("/task/instruction.md", "utf-8").trim();
    const environment = new LocalEnvironment();

    const { result, durationMs } = await runTask(environment, instruction);

    // Serialize ATIF trajectory
    const atif = toAtif(result, MODEL_NAME, durationMs);
    const trajDir = "/logs/agent";
    mkdirSync(trajDir, { recursive: true });
    writeFileSync(
        join(trajDir, "trajectory.json"),
        JSON.stringify(atif, null, 2),
        "utf-8",
    );

    // Print summary
    const fm = atif.final_metrics;
    console.log(
        `turns=${fm.extra.num_turns} duration_ms=${durationMs} ` +
        `input=${fm.total_prompt_tokens} output=${fm.total_completion_tokens}`,
    );
}

// ---------------------------------------------------------------------------
// AutoAgent class — Harbor BaseAgent adapter.
// In Harbor's Python runner, this class is instantiated and its run() method
// is called. In the TypeScript port, when running inside a container, we
// use runInContainer() directly as the entrypoint.
// ---------------------------------------------------------------------------

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
        // No-op: override in subclasses if needed
    }

    async run(
        instruction: string,
        environment: BaseEnvironment,
        context: AgentContext,
    ): Promise<void> {
        // Ensure task directory exists
        await environment.exec("mkdir -p /task");

        // Write instruction
        const instrPath = join(this._logsDir, "instruction.md");
        writeFileSync(instrPath, instruction, "utf-8");
        await environment.uploadFile(instrPath, "/task/instruction.md");

        // Run the agent
        const { result, durationMs } = await runTask(environment, instruction);

        // Serialize trajectory
        const atif = toAtif(result, MODEL_NAME, durationMs);
        const trajPath = join(this._logsDir, "trajectory.json");
        writeFileSync(trajPath, JSON.stringify(atif, null, 2), "utf-8");

        // Update context with token usage
        try {
            const fm = atif.final_metrics;
            context.nInputTokens = fm.total_prompt_tokens;
            context.nOutputTokens = fm.total_completion_tokens;
            context.nCacheTokens = fm.total_cached_tokens;
        } catch {
            // Ignore context update errors
        }

        // Print summary
        console.log(
            `turns=${result.steps.length} duration_ms=${durationMs} ` +
            `input=${result.usage.promptTokens} output=${result.usage.completionTokens}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Container entrypoint
// ---------------------------------------------------------------------------

const isMainModule =
    typeof process !== "undefined" &&
    process.argv[1] &&
    (process.argv[1].endsWith("agent.ts") ||
        process.argv[1].endsWith("agent.js"));

if (isMainModule) {
    runInContainer().catch((err) => {
        console.error("Agent failed:", err);
        process.exit(1);
    });
}
