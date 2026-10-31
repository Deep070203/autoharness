import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A Breken fix stays inside one package (posthog-js `packages/react`,
 * etl `crates/etl-destinations`, realtime one extension). A monorepo
 * or a tree that cannot be listed is audited the same way: the package
 * recent commits actually changed, not the whole repository and not an
 * unrelated open issue.
 */
export const DEFAULT_LARGE_TREE = 2500;

const MANIFESTS = new Set([
    "package.json",
    "go.mod",
    "mix.exs",
    "pyproject.toml",
    "setup.py",
    "Cargo.toml",
]);

export interface HuntScope {
    /** Repo-relative package directory. "." is the whole repository. */
    root: string;
    files: string[];
    reason: string;
}

export function listTrackedFiles(repoPath: string, pathspec?: string): string[] | undefined {
    try {
        const args = ["ls-files", "-z"];
        if (pathspec) args.push("--", pathspec);
        const out = execFileSync("git", args, {
            cwd: repoPath,
            timeout: 60_000,
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return out.toString("utf-8").split("\0").map((line) => line.trim()).filter(Boolean);
    } catch {
        return undefined;
    }
}

export function selectHuntScope(
    repoPath: string,
    churnedFiles: string[],
    largeAt = DEFAULT_LARGE_TREE
): HuntScope {
    const churn = churnedFiles.map((file) => file.split(path.sep).join("/")).filter(Boolean);
    const all = listTrackedFiles(repoPath);
    const known = all ?? churn.filter((file) => fs.existsSync(path.join(repoPath, file)));
    const packages = packageDirs(repoPath, known);
    const monorepo = isMonorepo(packages);
    const large = !all || all.length >= largeAt;

    if (all && all.length > 0 && !large && !monorepo) {
        return {
            root: ".",
            files: all,
            reason: `Auditing the repository directly (${all.length} tracked files).`,
        };
    }

    const nested = packages.filter((dir) => dir !== ".");
    const chosen = pickPackage(churn, nested.length > 0 ? nested : packages) ?? directoryCluster(churn);
    const scoped = chosen
        ? listTrackedFiles(repoPath, chosen) ?? known.filter((file) => file === chosen || file.startsWith(`${chosen}/`))
        : known;
    const root = chosen || ".";

    let reason: string;
    if (!all) {
        reason = `Could not list the whole tree. Auditing ${root} from recent commits. Open issues are not a substitute.`;
    } else if (all.length >= largeAt) {
        reason = `Repository has ${all.length} tracked files. Auditing ${root} only, the package recent commits changed.`;
    } else {
        reason = `Monorepo. Auditing ${root} only, the package recent commits changed.`;
    }

    return { root, files: scoped, reason };
}

function isMonorepo(packages: string[]): boolean {
    const nested = packages.filter((dir) => dir !== ".");
    if (nested.length >= 2) return true;
    return nested.length === 1 && packages.includes(".");
}

function packageDirs(repoPath: string, files: string[]): string[] {
    const dirs = new Set<string>();
    for (const file of files) {
        const normalized = file.split(path.sep).join("/");
        if (normalized.includes("/node_modules/") || normalized.includes("/vendor/") || normalized.includes("/dist/")) {
            continue;
        }
        const base = path.posix.basename(normalized);
        if (!MANIFESTS.has(base)) continue;
        if (base === "Cargo.toml") {
            let text = "";
            try {
                text = fs.readFileSync(path.join(repoPath, normalized), "utf-8");
            } catch {
                continue;
            }
            if (!/^\[package\]\s*$/m.test(text)) continue;
        }
        const dir = path.posix.dirname(normalized);
        dirs.add(dir === "" ? "." : dir);
    }
    return [...dirs];
}

function pickPackage(churn: string[], packages: string[]): string | undefined {
    if (packages.length === 0) return undefined;
    const score = new Map<string, number>();
    for (const pkg of packages) score.set(pkg, 0);
    for (const file of churn) {
        if (ignoredChurn(file)) continue;
        const pkg = nearestPackage(file, packages);
        if (pkg) score.set(pkg, (score.get(pkg) || 0) + 1);
    }
    let best: string | undefined;
    let bestScore = -1;
    for (const [pkg, count] of score) {
        if (count > bestScore || (count === bestScore && best !== undefined && pkg.length > best.length)) {
            best = pkg;
            bestScore = count;
        }
    }
    if (best && bestScore > 0) return best;
    return [...packages].sort((a, b) => a.length - b.length)[0];
}

function nearestPackage(file: string, packages: string[]): string | undefined {
    let best: string | undefined;
    for (const pkg of packages) {
        if (pkg !== "." && file !== pkg && !file.startsWith(`${pkg}/`)) continue;
        if (!best || pkg.length > best.length) best = pkg;
    }
    return best;
}

function directoryCluster(churn: string[]): string | undefined {
    const counts = new Map<string, number>();
    for (const file of churn) {
        if (ignoredChurn(file)) continue;
        const parts = file.split("/");
        if (parts.length < 2) continue;
        const prefix = parts.slice(0, Math.min(3, parts.length - 1)).join("/");
        counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
    let best: string | undefined;
    let count = 0;
    for (const [prefix, n] of counts) {
        if (n > count) {
            best = prefix;
            count = n;
        }
    }
    return best;
}

/**
 * Files that still exist. A deleted scratch test is not part of the commit.
 * Git status is the list; paths the agent noted and then removed are dropped.
 */
export function changesOnDisk(repoPath: string, noted: Iterable<string>): string[] {
    const existing = new Set<string>();
    let sawStatus = false;
    try {
        const gitOut = execSync("git status --porcelain -uall", {
            cwd: repoPath,
            encoding: "utf-8",
            maxBuffer: 8 * 1024 * 1024,
        });
        sawStatus = true;
        for (const line of gitOut.split("\n")) {
            if (!line.trim()) continue;
            const status = line.slice(0, 2);
            let file = line.slice(3).trim();
            const renamed = file.split(" -> ");
            if (renamed.length === 2) file = renamed[1].trim().replace(/^"|"$/g, "");
            if (file.startsWith("\"") && file.endsWith("\"")) file = file.slice(1, -1);
            if (!file || file === ".agy_prompt.txt") continue;
            if (status.includes("D")) continue;
            if (fs.existsSync(path.join(repoPath, file))) existing.add(file);
        }
    } catch {
        sawStatus = false;
    }
    if (!sawStatus) {
        for (const file of noted) {
            if (file && file !== ".agy_prompt.txt" && fs.existsSync(path.join(repoPath, file))) existing.add(file);
        }
    }
    return [...existing];
}

function ignoredChurn(file: string): boolean {
    const normalized = file.toLowerCase();
    return normalized.includes("/test")
        || normalized.includes("test/")
        || normalized.endsWith(".md")
        || normalized.startsWith("docs/");
}
