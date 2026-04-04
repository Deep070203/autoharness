import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DockerEnvironment } from './environment.js';

const execAsync = promisify(exec);

export class TrialOrchestrator {
    private containerId?: string;
    private env?: DockerEnvironment;
    private absTaskDir: string;
    private absOutputDir: string;

    constructor(private taskDirPath: string, private outputDirPath: string, private agentName: string) {
        this.absTaskDir = path.resolve(taskDirPath);
        this.absOutputDir = path.resolve(outputDirPath);
    }

    async setup(): Promise<DockerEnvironment> {
        console.log(`[Orchestrator] Starting Sandbox for ${this.taskDirPath}...`);

        // Spin up a new container using autoharness-base
        const { stdout } = await execAsync(
            `docker run -d --rm -v "${this.absTaskDir}:/workspace:ro" autoharness-base tail -f /dev/null`
        );
        this.containerId = stdout.trim();
        this.env = new DockerEnvironment(this.containerId);

        console.log(`[Orchestrator] Sandbox ID: ${this.containerId.slice(0, 12)}`);
        return this.env;
    }

    async runTask() {
        if (!this.env) throw new Error("Sandbox not initialized!");

        console.log(`[Orchestrator] Injecting instruction...`);
        const instruction = await fs.readFile(path.join(this.absTaskDir, 'instruction.md'), 'utf-8');
        await this.env.exec("mkdir -p /task /logs");

        // Push instruction securely via file copying
        const tmpInstr = path.join(this.absOutputDir, 'tmp_instruction.md');
        await fs.mkdir(this.absOutputDir, { recursive: true });
        await fs.writeFile(tmpInstr, instruction);
        await this.env.uploadFile(tmpInstr, '/task/instruction.md');

        // Collect global API keys from host to proxy properly
        const proxyEnv = {
            "GOOGLE_GENERATIVE_AI_API_KEY": process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
            "OPENAI_API_KEY": process.env.OPENAI_API_KEY || "",
            "ANTHROPIC_API_KEY": process.env.ANTHROPIC_API_KEY || "",
        };

        console.log(`[Orchestrator] Executing TypeScript agent loop inside Sandbox...`);

        const targetJS = this.agentName === 'AutoAgent' ? 'dist/agent.js' : `dist/${this.agentName}.js`;
        const res = await this.env.exec(`cd /app && node ${targetJS}`, 1200, proxyEnv);

        console.log(`[Orchestrator] Agent finished with exit code ${res.exitCode}`);

        // Extract agent logs and trajectory
        const agentLogDir = path.join(this.absOutputDir, 'agent');
        await this.env.downloadDir('/logs', agentLogDir);
        await fs.writeFile(path.join(agentLogDir, 'stdout.log'), res.stdout);
        await fs.writeFile(path.join(agentLogDir, 'stderr.log'), res.stderr);
    }

    async runVerification() {
        if (!this.env) return;
        console.log(`[Orchestrator] Running sandbox verification scripts...`);

        const verifierLogDir = path.join(this.absOutputDir, 'verifier');
        try {
            await this.env.exec("mkdir -p /verifier");
            await this.env.exec("cp -r /workspace/tests /tests");
            await this.env.exec("chmod +x /tests/test.sh");
            await this.env.exec("/tests/test.sh", 120);
            await this.env.downloadDir('/verifier', verifierLogDir);

            const reward = await fs.readFile(path.join(verifierLogDir, 'reward.txt'), 'utf-8');
            console.log(`[Orchestrator] Test Passed. Reward: ${reward.trim()}`);
        } catch (e: any) {
            console.log(`[Orchestrator] Verification failed to parse: ${e.message}`);
        }
    }

    async tearDown() {
        if (this.containerId) {
            console.log(`[Orchestrator] Tearing down Sandbox ${this.containerId.slice(0, 12)}...`);
            await execAsync(`docker rm -f ${this.containerId}`);
        }
    }
}
