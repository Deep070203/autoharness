import * as fs from "node:fs";
import * as path from "node:path";

export interface ResolvedRepoEnv {
    env: NodeJS.ProcessEnv;
    pythonBin?: string;
    venvDir?: string;
}

const SKIP_DIR_NAMES = new Set([
    "node_modules",
    "dist",
    "build",
    "site-packages",
    "__pycache__",
    "tests",
    "test",
    "testing",
    "docs",
    "doc",
    "examples",
    "example",
    "benchmarks",
    "ui",
    "ui-v2",
    "site",
    "htmlcov",
    "vendor",
    "third_party",
    "venv",
    "env",
]);

function isSkippedDir(name: string): boolean {
    return name.startsWith(".") || SKIP_DIR_NAMES.has(name);
}

export function isPythonPackageDir(dir: string): boolean {
    return fs.existsSync(path.join(dir, "__init__.py"));
}

function directoryContainsPackage(dir: string): boolean {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return false;
    }
    return entries.some((entry) => {
        if (!entry.isDirectory() || isSkippedDir(entry.name)) return false;
        return isPythonPackageDir(path.join(dir, entry.name));
    });
}

/**
 * Directories that belong on PYTHONPATH.
 *
 * A directory qualifies only when one of its *children* is an importable package.
 * The package directory itself is never added. Adding `src/prefect` made
 * `prefect/types` shadow the stdlib `types` module (and then `functools`)
 * during every Prefect probe.
 */
export function discoverPythonPackageRoots(repoPath: string): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();

    const walk = (dir: string, depth: number) => {
        const resolved = path.resolve(dir);
        if (seen.has(resolved)) return;
        seen.add(resolved);

        if (directoryContainsPackage(resolved)) {
            roots.push(resolved);
        }
        if (depth >= 4) return;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(resolved, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || isSkippedDir(entry.name)) continue;
            const child = path.join(resolved, entry.name);
            // Descend only through non-packages. Entering `src/prefect` would
            // let `types/`, `logging/`, etc. become top-level modules.
            if (isPythonPackageDir(child)) continue;
            walk(child, depth + 1);
        }
    };

    walk(repoPath, 0);
    return roots;
}

export function listTopLevelPackages(repoPath: string): string[] {
    const names: string[] = [];
    for (const root of discoverPythonPackageRoots(repoPath)) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || isSkippedDir(entry.name)) continue;
            if (!isPythonPackageDir(path.join(root, entry.name))) continue;
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
                names.push(entry.name);
            }
        }
    }
    return [...new Set(names)];
}

/** Package a smoke import should load. Prefers the name of the repository. */
export function primaryPackageName(repoPath: string, repoName?: string): string | undefined {
    const names = listTopLevelPackages(repoPath);
    if (names.length === 0) return undefined;
    const wanted = (repoName || path.basename(repoPath)).replace(/-/g, "_");
    return names.find((name) => name === wanted) || names[0];
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
        // Don't prepend the script directory to sys.path. A probe at
        // tests/test_hunted_probe.py must not shadow stdlib modules.
        PYTHONSAFEPATH: "1",
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

    env.PATH = pathSegments.filter(Boolean).join(path.delimiter);

    // 3. PYTHONPATH is only package roots (the parent of an importable package).
    const pythonPaths = discoverPythonPackageRoots(repoPath);
    if (process.env.PYTHONPATH) {
        pythonPaths.push(process.env.PYTHONPATH);
    }
    if (pythonPaths.length > 0) {
        env.PYTHONPATH = pythonPaths.join(path.delimiter);
    }

    return {
        env,
        pythonBin,
        venvDir,
    };
}

/**
 * Normalizes a command so that any `python` or `python3` invocations directly target
 * the discovered virtualenv python if available, preventing system python fallback.
 * Inserts `-P` so the script directory cannot shadow the standard library.
 */
export function normalizeCommandWithVenv(command: string, pythonBin?: string): string {
    const trimmed = command.trim();

    if (/^pytest(?:\s|$)/.test(trimmed)) {
        if (!pythonBin) return trimmed;
        const venvPytest = path.join(path.dirname(pythonBin), "pytest");
        if (fs.existsSync(venvPytest)) {
            return trimmed.replace(/^pytest\b/, `"${venvPytest}"`);
        }
        return trimmed;
    }

    const pythonMatch = trimmed.match(/^(python3?)(?:\s+([\s\S]*))?$/);
    if (!pythonMatch) return trimmed;

    const bin = pythonBin ? `"${pythonBin}"` : "python3";
    const rest = (pythonMatch[2] || "").trim();
    if (!rest) return bin;
    const isolated = rest === "-P" || rest.startsWith("-P ") ? rest : `-P ${rest}`;
    return `${bin} ${isolated}`;
}

/** Run a Python file as a script, isolated from its own directory. */
export function pythonScriptCommand(scriptPath: string, pythonBin?: string): string {
    const bin = pythonBin ? `"${pythonBin}"` : "python3";
    return `${bin} -P ${scriptPath}`;
}

export function pythonImportCheckCommand(packageName: string, pythonBin?: string): string | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(packageName)) return undefined;
    const bin = pythonBin ? `"${pythonBin}"` : "python3";
    return `${bin} -P -c "import ${packageName}"`;
}
