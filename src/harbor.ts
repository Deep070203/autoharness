/**
 * Harbor integration interfaces.
 *
 * These TypeScript interfaces mirror Harbor's Python BaseAgent / BaseEnvironment
 * contract. Since Harbor orchestrates agents via Docker containers, the TS agent
 * runs as a process inside the container and communicates through files
 * (/task/instruction.md, /logs/trajectory.json).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Mirrors harbor.environments.base.BaseEnvironment.
 * In-container, this is backed by child_process.exec.
 */
export interface BaseEnvironment {
    exec(
        command: string,
        timeoutSec?: number,
        env?: Record<string, string>,
    ): Promise<ExecResult>;

    uploadFile(sourcePath: string, targetPath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent context (token / cost tracking)
// ---------------------------------------------------------------------------

export interface AgentContext {
    nInputTokens: number;
    nOutputTokens: number;
    nCacheTokens: number;
    costUsd?: number;
}

// ---------------------------------------------------------------------------
// Base agent adapter
// ---------------------------------------------------------------------------

export abstract class BaseAgent {
    public readonly logsDir: string;

    constructor(logsDir: string = "/logs/agent") {
        this.logsDir = logsDir;
        mkdirSync(this.logsDir, { recursive: true });
    }

    abstract name(): string;
    abstract version(): string | null;
    abstract setup(environment: BaseEnvironment): Promise<void>;
    abstract run(
        instruction: string,
        environment: BaseEnvironment,
        context: AgentContext,
    ): Promise<void>;

    /** Write a file into the logs directory. */
    protected writeLog(filename: string, content: string): void {
        writeFileSync(join(this.logsDir, filename), content, "utf-8");
    }

    /** Read a file from the logs directory. */
    protected readLog(filename: string): string {
        return readFileSync(join(this.logsDir, filename), "utf-8");
    }
}
