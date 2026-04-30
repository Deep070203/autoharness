import { Octokit } from "@octokit/rest";
import simpleGit, { type SimpleGit, type SimpleGitOptions } from "simple-git";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

export class GitHubService {
    public octokit: Octokit;
    private git: SimpleGit;
    private baseDir: string;

    constructor(baseDir: string = "./workspace/repos") {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
            console.warn("GITHUB_TOKEN not found in environment variables. API calls will be unauthenticated and severely rate-limited.");
        }

        this.octokit = new Octokit({
            auth: token,
        });

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
        this.git = typeof simpleGit === 'function' ? simpleGit(options) : (simpleGit as any).default(options);
    }

    /**
     * Gets the last N merged PRs for a repository
     */
    async getRecentMergedPRs(owner: string, repo: string, limit: number = 20) {
        const response = await this.octokit.search.issuesAndPullRequests({
            q: `repo:${owner}/${repo} is:pr is:merged`,
            sort: "updated",
            order: "desc",
            per_page: limit,
        });
        return response.data.items;
    }

    /**
     * Forks a repository and returns the fork details
     */
    async forkRepository(owner: string, repo: string) {
        const response = await this.octokit.repos.createFork({
            owner,
            repo,
        });
        return response.data;
    }

    /**
     * Clones a repository locally
     */
    async cloneRepository(repoUrl: string, localFolderName: string) {
        const targetDir = path.join(this.baseDir, localFolderName);
        if (fs.existsSync(targetDir)) {
            console.log(`Repository already exists at ${targetDir}`);
            // @ts-ignore
            return typeof simpleGit === 'function' ? simpleGit(targetDir) : (simpleGit as any).default(targetDir);
        }
        await this.git.clone(repoUrl, localFolderName);
        // @ts-ignore
        return typeof simpleGit === 'function' ? simpleGit(targetDir) : (simpleGit as any).default(targetDir);
    }

    /**
     * Gets the unified diff of a specific pull request
     */
    async getPRDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
        const response = await this.octokit.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
            mediaType: { format: 'diff' }
        });
        // When format is 'diff', response.data is a string
        return response.data as unknown as string;
    }

    /**
     * Gets the list of files changed in a pull request with patch hunks
     */
    async getPRFiles(owner: string, repo: string, pullNumber: number) {
        const response = await this.octokit.pulls.listFiles({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
        });
        return response.data.map(f => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch || '',
        }));
    }

    /**
     * Gets the default branch name for a repository (not always 'main')
     */
    async getDefaultBranch(owner: string, repo: string): Promise<string> {
        const { data } = await this.octokit.repos.get({ owner, repo });
        return data.default_branch;
    }

    /**
     * Gets full PR details (title, body, author, labels, merge commit)
     */
    async getPRDetails(owner: string, repo: string, pullNumber: number) {
        const { data } = await this.octokit.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
        });
        return {
            title: data.title,
            body: data.body || '',
            author: data.user?.login || 'unknown',
            labels: data.labels.map((l: any) => l.name),
            mergeCommitSha: data.merge_commit_sha,
            baseBranch: data.base.ref,
            headBranch: data.head.ref,
        };
    }

    /**
     * Fetches the CONTRIBUTING.md file if it exists
     */
    async getContributingGuidelines(owner: string, repo: string): Promise<string | null> {
        try {
            const possiblePaths = ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'];
            for (const p of possiblePaths) {
                try {
                    const response = await this.octokit.repos.getContent({
                        owner,
                        repo,
                        path: p,
                    });

                    if ('content' in response.data && 'encoding' in response.data) {
                        return Buffer.from(response.data.content, response.data.encoding as BufferEncoding).toString('utf-8');
                    }
                } catch (e: any) {
                    if (e.status !== 404) throw e;
                }
            }
            return null;
        } catch (error) {
            console.error(`Error fetching CONTRIBUTING.md for ${owner}/${repo}:`, error);
            return null;
        }
    }
}
