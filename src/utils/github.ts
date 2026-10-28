import { Octokit } from "@octokit/rest";
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

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
     * Gets open issues that look like bug reports
     */
    async getOpenBugIssues(owner: string, repo: string, limit: number = 20) {
        return this.callApi(async (client) => {
            const response = await client.search.issuesAndPullRequests({
                q: `repo:${owner}/${repo} is:issue is:open`,
                sort: "updated",
                order: "desc",
                per_page: limit,
            });
            return response.data.items.filter((item: any) => !item.pull_request);
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
     * Fetches the repo's CONTRIBUTING.md guidelines if present
     */
    async getContributingGuidelines(owner: string, repo: string): Promise<string | null> {
        return this.callApi(async (client) => {
            try {
                const response = await client.repos.getContent({
                    owner,
                    repo,
                    path: "CONTRIBUTING.md",
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
}
