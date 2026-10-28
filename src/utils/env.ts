import * as fs from "node:fs";
import * as path from "node:path";

export interface ResolvedRepoEnv {
    env: NodeJS.ProcessEnv;
    pythonBin?: string;
    venvDir?: string;
}

/**
 * Automatically inspects a repository to discover local virtual environments
 * (.venv, venv, .env), resolves src-layout PYTHONPATH, and builds a complete
 * execution environment so test runners and probes resolve all dependencies.
 */
export function resolveRepoEnv(repoPath: string): ResolvedRepoEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: "true",
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
    };

    // 1. Discover local virtual environment
    const venvCandidates = [
        path.join(repoPath, ".venv"),
        path.join(repoPath, "venv"),
        path.join(repoPath, ".env"),
        path.join(repoPath, "env"),
    ];

    let venvDir: string | undefined;
    let pythonBin: string | undefined;

    for (const candidate of venvCandidates) {
        const binPython = path.join(candidate, "bin", "python");
        const binPython3 = path.join(candidate, "bin", "python3");
        if (fs.existsSync(binPython)) {
            venvDir = candidate;
            pythonBin = binPython;
            break;
        } else if (fs.existsSync(binPython3)) {
            venvDir = candidate;
            pythonBin = binPython3;
            break;
        }
    }

    // 2. Build PATH prioritizing venv and standard package manager bins
    const pathSegments: string[] = [];

    if (venvDir) {
        pathSegments.push(path.join(venvDir, "bin"));
        env.VIRTUAL_ENV = venvDir;
    }

    const nodeModulesBin = path.join(repoPath, "node_modules", ".bin");
    if (fs.existsSync(nodeModulesBin)) {
        pathSegments.push(nodeModulesBin);
    }

    // Common system tool paths
    if (process.env.HOME) {
        pathSegments.push(
            path.join(process.env.HOME, ".local", "bin"),
            path.join(process.env.HOME, ".cargo", "bin")
        );
    }
    pathSegments.push(
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/Library/Frameworks/Python.framework/Versions/3.12/bin",
        process.env.PATH || ""
    );

    env.PATH = pathSegments.filter(Boolean).join(":");

    // 3. Build PYTHONPATH supporting both root and src-layout packages
    const pythonPaths: string[] = [repoPath, "."];
    const srcDir = path.join(repoPath, "src");

    if (fs.existsSync(srcDir)) {
        pythonPaths.unshift(srcDir, "src");
        try {
            const subEntries = fs.readdirSync(srcDir, { withFileTypes: true });
            for (const entry of subEntries) {
                if (entry.isDirectory()) {
                    pythonPaths.push(path.join(srcDir, entry.name));
                }
            }
        } catch (e) {}
    }

    const libDir = path.join(repoPath, "lib");
    if (fs.existsSync(libDir)) {
        pythonPaths.push(libDir);
    }

    if (process.env.PYTHONPATH) {
        pythonPaths.push(process.env.PYTHONPATH);
    }

    env.PYTHONPATH = pythonPaths.join(":");

    return {
        env,
        pythonBin,
        venvDir,
    };
}

/**
 * Normalizes a command so that any `python` or `python3` invocations directly target
 * the discovered virtualenv python if available, preventing system python fallback.
 */
export function normalizeCommandWithVenv(command: string, pythonBin?: string): string {
    if (!pythonBin) return command;

    if (command.startsWith("python ")) {
        return command.replace(/^python /, `"${pythonBin}" `);
    }
    if (command.startsWith("python3 ")) {
        return command.replace(/^python3 /, `"${pythonBin}" `);
    }
    if (command.startsWith("pytest ")) {
        const venvPytest = path.join(path.dirname(pythonBin), "pytest");
        if (fs.existsSync(venvPytest)) {
            return command.replace(/^pytest /, `"${venvPytest}" `);
        }
    }

    return command;
}
