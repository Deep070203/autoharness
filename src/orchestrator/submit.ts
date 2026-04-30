import { GitHubService } from "../utils/github.js";
import simpleGit from "simple-git";
import * as path from "path";

/**
 * Stage 13: Submission and Follow-up
 *
 * Commits the actual file changes made by the coding agent,
 * pushes to the fork, and opens a PR against upstream.
 */
export async function submitPullRequest(
    github: GitHubService,
    owner: string,
    repo: string,
    draft: { title: string; body: string },
    localDirName: string,
    modifiedFiles: string[],
    baseBranch?: string,
): Promise<string | null> {
    console.log(`\n🚀 Stage 13: Submission to ${owner}/${repo}`);

    const repoPath = path.resolve(`./workspace/repos/${localDirName}`);

    try {
        // @ts-ignore
        const git = typeof simpleGit === 'function' ? simpleGit(repoPath) : (simpleGit as any).default(repoPath);

        await git.addConfig('user.name', 'AutoHarness Bot');
        await git.addConfig('user.email', 'bot@autoharness.local');

        // Detect the default branch if not provided
        if (!baseBranch) {
            try {
                baseBranch = await github.getDefaultBranch(owner, repo);
                console.log(`[Submit] Detected default branch: ${baseBranch}`);
            } catch {
                baseBranch = 'main';
                console.log(`[Submit] Could not detect default branch, defaulting to 'main'`);
            }
        }

        // Create a unique branch
        const headBranch = `fix/auto-patch-${Date.now()}`;
        console.log(`[Submit] Creating branch: ${headBranch}`);
        await git.checkoutLocalBranch(headBranch);

        // Stage ONLY the files the coding agent modified
        if (modifiedFiles.length === 0) {
            console.error(`[Submit] No files to commit. Cannot create a PR with zero changes.`);
            return null;
        }

        console.log(`[Submit] Staging ${modifiedFiles.length} modified files...`);
        for (const file of modifiedFiles) {
            console.log(`  + ${file}`);
            await git.add(file);
        }

        // Commit
        console.log(`[Submit] Committing...`);
        await git.commit(draft.title);

        // Verify the commit has changes
        const log = await git.log({ maxCount: 1 });
        console.log(`[Submit] Committed: ${log.latest?.hash?.substring(0, 8)} — ${log.latest?.message}`);

        // Authenticate and push
        const { data: user } = await github.octokit.users.getAuthenticated();
        const token = process.env.GITHUB_TOKEN;
        await git.remote(['set-url', 'origin', `https://x-access-token:${token}@github.com/${user.login}/${localDirName}.git`]);

        console.log(`[Submit] Pushing branch '${headBranch}' to ${user.login}/${localDirName}...`);
        await git.push('origin', headBranch, { '--set-upstream': null });

        // Open PR against upstream
        console.log(`[Submit] Creating PR against ${owner}/${repo}...`);
        const pr = await github.octokit.pulls.create({
            owner,
            repo,
            title: draft.title,
            body: draft.body,
            head: `${user.login}:${headBranch}`,
            base: baseBranch,
        });

        console.log(`[Submit] ✅ PR created: ${pr.data.html_url}`);
        return pr.data.html_url;

    } catch (e: any) {
        console.error(`[Submit] Submission failed: ${e.message}`);
        return null;
    }
}
