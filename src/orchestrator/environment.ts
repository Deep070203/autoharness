import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { BaseEnvironment, ExecResult } from '../harbor.js';

const execAsync = promisify(exec);

export class DockerEnvironment implements BaseEnvironment {
    constructor(private containerId: string) { }

    async exec(command: string, timeoutSec: number = 120, env?: Record<string, string>): Promise<ExecResult> {
        let envArgs = '';
        if (env) {
            envArgs = Object.entries(env)
                .map(([k, v]) => `-e ${k}='${v.replace(/'/g, "'\\''")}'`)
                .join(' ');
        }

        try {
            // sh -c cleanly wraps piped commands securely inside docker
            const dockerCmd = `docker exec ${envArgs} -w /workspace ${this.containerId} sh -c "${command.replace(/"/g, '\\"')}"`;
            const { stdout, stderr } = await execAsync(dockerCmd, { timeout: timeoutSec * 1000 });
            return { stdout, stderr, exitCode: 0 };
        } catch (error: any) {
            return {
                stdout: error.stdout?.toString() || '',
                stderr: error.stderr?.toString() || error.message || '',
                exitCode: error.code || 1
            };
        }
    }

    async uploadFile(sourcePath: string, targetPath: string): Promise<void> {
        await execAsync(`docker cp "${sourcePath}" ${this.containerId}:${targetPath}`);
    }

    async uploadDir(sourceDir: string, targetDir: string): Promise<void> {
        await execAsync(`docker exec ${this.containerId} mkdir -p ${targetDir}`);
        await execAsync(`docker cp "${sourceDir}/." ${this.containerId}:${targetDir}/`);
    }

    async downloadDir(sourceDir: string, targetDir: string): Promise<void> {
        // Create local target first, then cp from container
        await execAsync(`mkdir -p "${targetDir}"`);
        await execAsync(`docker cp ${this.containerId}:${sourceDir}/. "${targetDir}/"`);
    }
}
