import { Octokit } from "@octokit/rest";
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

export function openBugIssueQuery(owner: string, repo: string, requireBugLabel: boolean): string {
    const qualifiers = [
        `repo:${owner}/${repo}`,
        "is:issue",
        "is:open",
        "-label:wontfix",
        "-label:duplicate",
        "-label:question",
    ];
    if (requireBugLabel) qualifiers.push("label:bug");
    return qualifiers.join(" ");
}

export function preferLabeledIssues<T extends { number: number; pull_request?: unknown }>(
    labeled: T[],
    general: T[],
    limit: number
): T[] {
    const seen = new Set<number>();
    const out: T[] = [];
    for (const item of [...labeled, ...general]) {
        if (item.pull_request) continue;
        if (seen.has(item.number)) continue;
        seen.add(item.number);
        out.push(item);
        if (out.length >= limit) break;
    }
    return out;
}

export class GitHubService {
    public octokit: Octokit;
    private unauthOctokit: Octokit;
    private git: SimpleGit;
    public baseDir: string;

    constructor(baseDir: string = "/Users/deepshah/Downloads/PRs") {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
            console.warn("[GitHub] GITHUB_TOKEN not found in environment variables. API calls will be unauthenticated.");
        }

        this.octokit = new Octokit({
            auth: token && token.trim().length > 10 ? token.trim() : undefined,
        });
        this.unauthOctokit = new Octokit();

        this.baseDir = path.resolve(baseDir);
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }

        const options: Partial<SimpleGitOptions> = {
            baseDir: this.baseDir,
            binary: "git",
            maxConcurrentProcesses: 6,
            trimmed: false,
        };
        // @ts-ignore Let it fall back if typical esm import fails
        this.git = typeof simpleGit === "function" ? simpleGit(options) : (simpleGit as any).default(options);
    }

    /**
     * Executes an Octokit API call with automatic fallback to unauthenticated client if token is expired/invalid (401).
     */
    private async callApi<T>(fn: (client: Octokit) => Promise<T>): Promise<T> {
        try {
            return await fn(this.octokit);
        } catch (err: any) {
            if (err?.status === 401 || err?.message?.includes("Bad credentials")) {
                console.warn("[GitHub] Token rejected (401 Bad credentials). Falling back to unauthenticated public API call...");
                return await fn(this.unauthOctokit);
            }
            throw err;
        }
    }

    /**
     * Gets the last N merged PRs for a repository
     */
    async getRecentMergedPRs(owner: string, repo: string, limit: number = 20) {
        return this.callApi(async (client) => {
            const response = await client.search.issuesAndPullRequests({
                q: `repo:${owner}/${repo} is:pr is:merged`,
                sort: "updated",
                order: "desc",
                per_page: limit,
            });
            return response.data.items;
        });
    }

    /**
     * Gets open issues that look like bug reports.
     * Labeled bugs come first. Recently updated issues of any kind are only
     * used to fill the list, so a comment on a question cannot crowd out bugs.
     */
    async getOpenBugIssues(owner: string, repo: string, limit: number = 20) {
        return this.callApi(async (client) => {
            const search = async (q: string) => {
                const response = await client.search.issuesAndPullRequests({
                    q,
                    sort: "updated",
                    order: "desc",
                    per_page: limit,
                });
                return response.data.items;
            };

            let labeled: Awaited<ReturnType<typeof search>> = [];
            let labeledError: unknown;
            try {
                labeled = await search(openBugIssueQuery(owner, repo, true));
            } catch (err) {
                labeledError = err;
            }

            if (labeled.length >= limit) {
                return preferLabeledIssues(labeled, [], limit);
            }

            try {
                const general = await search(openBugIssueQuery(owner, repo, false));
                return preferLabeledIssues(labeled, general, limit);
            } catch (err) {
                if (labeled.length > 0) {
                    return preferLabeledIssues(labeled, [], limit);
                }
                throw labeledError || err;
            }
        });
    }

    /**
     * Gets recent bug issues (open or closed) to analyze issue style conventions
     */
    async getRecentBugIssues(owner: string, repo: string, limit: number = 10) {
        return this.callApi(async (client) => {
            try {
                const response = await client.search.issuesAndPullRequests({
                    q: `repo:${owner}/${repo} is:issue`,
                    sort: "created",
                    order: "desc",
                    per_page: limit,
                });
                return response.data.items.filter((item: any) => !item.pull_request);
            } catch (e) {
                return [];
            }
        });
    }

    /**
     * Gets a specific issue by its number
     */
    async getIssue(owner: string, repo: string, issueNumber: number) {
        return this.callApi(async (client) => {
            const response = await client.issues.get({
                owner,
                repo,
                issue_number: issueNumber,
            });
            return response.data;
        });
    }

    /**
     * Creates a new issue in the target repository
     */
    async createIssue(owner: string, repo: string, title: string, body: string, labels: string[] = ["bug"]): Promise<{ number: number; html_url: string }> {
        return this.callApi(async (client) => {
            const response = await client.issues.create({
                owner,
                repo,
                title,
                body,
                labels,
            });
            return {
                number: response.data.number,
                html_url: response.data.html_url,
            };
        });
    }

    /**
     * Forks a repository and returns the fork details
     */
    async forkRepository(owner: string, repo: string) {
        return this.callApi(async (client) => {
            const response = await client.repos.createFork({
                owner,
                repo,
            });
            return response.data;
        });
    }

    /**
     * Clones a repository locally
     */
    async cloneRepository(repoUrl: string, localFolderName: string) {
        const targetDir = path.join(this.baseDir, localFolderName);
        if (fs.existsSync(targetDir)) {
            console.log(`Repository already exists at ${targetDir}`);
            // @ts-ignore
            return typeof simpleGit === "function" ? simpleGit(targetDir) : (simpleGit as any).default(targetDir);
        }
        await this.git.clone(repoUrl, localFolderName);
        // @ts-ignore
        return typeof simpleGit === "function" ? simpleGit(targetDir) : (simpleGit as any).default(targetDir);
    }

    /**
     * Gets the unified diff of a specific pull request
     */
    async getPRDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
        return this.callApi(async (client) => {
            const response = await client.pulls.get({
                owner,
                repo,
                pull_number: pullNumber,
                mediaType: {
                    format: "diff",
                },
            });
            return response.data as unknown as string;
        });
    }

    /**
     * Gets the list of files changed in a PR
     */
    async getPRFiles(owner: string, repo: string, pullNumber: number) {
        return this.callApi(async (client) => {
            const response = await client.pulls.listFiles({
                owner,
                repo,
                pull_number: pullNumber,
            });
            return response.data;
        });
    }

    /**
     * Gets the full details of a pull request
     */
    async getPRDetails(owner: string, repo: string, pullNumber: number) {
        return this.callApi(async (client) => {
            const response = await client.pulls.get({
                owner,
                repo,
                pull_number: pullNumber,
            });
            return response.data;
        });
    }

    /**
     * Gets the default branch of a repository
     */
    async getDefaultBranch(owner: string, repo: string): Promise<string> {
        return this.callApi(async (client) => {
            const response = await client.repos.get({
                owner,
                repo,
            });
            return response.data.default_branch;
        });
    }

    /**
     * Fetches raw content of a specific file in the repository if it exists
     */
    async getFileContent(owner: string, repo: string, filePath: string): Promise<string | null> {
        return this.callApi(async (client) => {
            try {
                const response = await client.repos.getContent({
                    owner,
                    repo,
                    path: filePath,
                    mediaType: {
                        format: "raw",
                    },
                });
                return response.data as unknown as string;
            } catch (e) {
                return null;
            }
        });
    }

    /**
     * Fetches the repo's CONTRIBUTING guidelines across common locations
     */
    async getContributingGuidelines(owner: string, repo: string): Promise<string | null> {
        const candidatePaths = [
            "CONTRIBUTING.md",
            ".github/CONTRIBUTING.md",
            "docs/CONTRIBUTING.md",
            ".github/contributing.md",
            "contributing.md"
        ];
        for (const p of candidatePaths) {
            const content = await this.getFileContent(owner, repo, p);
            if (content) return content;
        }
        return null;
    }

    /**
     * Fetches the official PR template if present
     */
    async getPullRequestTemplate(owner: string, repo: string): Promise<string | null> {
        const candidatePaths = [
            ".github/PULL_REQUEST_TEMPLATE.md",
            ".github/pull_request_template.md",
            "PULL_REQUEST_TEMPLATE.md",
            "pull_request_template.md",
            ".github/PULL_REQUEST_TEMPLATE/pull_request_template.md"
        ];
        for (const p of candidatePaths) {
            const content = await this.getFileContent(owner, repo, p);
            if (content) return content;
        }
        return null;
    }

    /**
     * Fetches official issue template (preferring bug reports) if present
     */
    async getIssueTemplates(owner: string, repo: string): Promise<{ filename: string; content: string }[]> {
        return this.callApi(async (client) => {
            try {
                const response = await client.repos.getContent({
                    owner,
                    repo,
                    path: ".github/ISSUE_TEMPLATE",
                });
                if (Array.isArray(response.data)) {
                    const templates: { filename: string; content: string }[] = [];
                    for (const item of response.data) {
                        if (item.type === "file" && (item.name.endsWith(".md") || item.name.endsWith(".yml") || item.name.endsWith(".yaml"))) {
                            const content = await this.getFileContent(owner, repo, item.path);
                            if (content) {
                                templates.push({ filename: item.name, content });
                            }
                        }
                    }
                    return templates;
                }
            } catch (e) {}
            return [];
        });
    }
}
