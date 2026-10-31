import { GitHubService } from "../utils/github.js";
import simpleGit from "simple-git";
import * as fs from "fs";
import * as path from "path";

export interface SubmissionResult {
    prUrl: string;
    issueUrl?: string;
    issueNumber?: number;
}

/**
 * Stage 13: Submission and Follow-up (Two-Phase Issue & PR Creation)
 *
 * 1. If issueDraft is provided (e.g. for hunted latent bugs), opens a GitHub Issue first.
 * 2. Injects 'Fixes #<number>' into the PR draft.
 * 3. Commits the surgical file changes, pushes to fork, and opens the PR.
 */
export async function submitPullRequest(
    github: GitHubService,
    owner: string,
    repo: string,
    draft: { title: string; body: string },
    localDirName: string,
    modifiedFiles: string[],
    baseBranch?: string,
    issueDraft?: { title: string; body: string; labels?: string[] },
    requiresDCO?: boolean
): Promise<SubmissionResult | null> {
    console.log(`\n🚀 Stage 13: Submission to ${owner}/${repo}`);

    const repoPath = path.join(github.baseDir, localDirName);

    try {
        let createdIssue: { number: number; html_url: string } | undefined;

        // ── Phase 1: Create GitHub Issue first if hunted bug ──────────
        if (issueDraft) {
            console.log(`[Submit] Phase 1: Filing style-matched GitHub Issue: "${issueDraft.title}"...`);
            try {
                createdIssue = await github.createIssue(
                    owner,
                    repo,
                    issueDraft.title,
                    issueDraft.body,
                    issueDraft.labels || ["bug"]
                );
                console.log(`[Submit] ✅ Phase 1 Complete: Created Issue #${createdIssue.number} (${createdIssue.html_url})`);

                // Link PR to the newly filed issue
                draft.body = `${draft.body}\n\nFixes #${createdIssue.number}\nCloses #${createdIssue.number}`;
            } catch (err: any) {
                console.warn(`[Submit] Warning: Failed to create GitHub issue: ${err.message}. Proceeding directly with PR.`);
            }
        }

        // ── Phase 2: Git Commit, Push & PR Creation ──────────────────
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

        const present = modifiedFiles.filter((file) => fs.existsSync(path.join(repoPath, file)));
        const missing = modifiedFiles.filter((file) => !present.includes(file));
        for (const file of missing) {
            console.warn(`[Submit] Skipping ${file}. It is no longer on disk.`);
        }
        if (present.length === 0) {
            console.error(`[Submit] No files to commit. Cannot create a PR with zero changes.`);
            return null;
        }

        console.log(`[Submit] Staging ${present.length} modified files...`);
        for (const file of present) {
            console.log(`  + ${file}`);
            await git.add(file);
        }

        // Commit (with DCO Signed-off-by if repository requires DCO)
        console.log(`[Submit] Committing${requiresDCO ? " (with DCO signoff)" : ""}...`);
        if (requiresDCO) {
            await git.commit(draft.title, { '--signoff': null });
        } else {
            await git.commit(draft.title);
        }

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

        console.log(`[Submit] ✅ Phase 2 Complete: PR created: ${pr.data.html_url}`);
        return {
            prUrl: pr.data.html_url,
            issueUrl: createdIssue?.html_url,
            issueNumber: createdIssue?.number,
        };

    } catch (e: any) {
        console.error(`[Submit] Submission failed: ${e.message}`);
        return null;
    }
}
