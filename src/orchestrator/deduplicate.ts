export async function deduplicateCandidate(
    candidate: any,
    github: import("../utils/github.js").GitHubService,
    owner: string,
    repo: string
): Promise<boolean> {
    console.log(`🔍 Stage 4: Deduplication Check for: ${candidate.title}`);

    // Very naive deduplication logic to simulate checking issues
    // Extracts keywords from the candidate title
    const titleWords = candidate.title.toLowerCase().split(/\W+/).filter((w: string) => w.length > 4);

    // We only check if we have enough descriptive words
    if (titleWords.length < 3) {
        console.log(`[Dedupe] Title too generic to deduplicate securely. Assuming unique.`);
        return true;
    }

    const searchQuery = titleWords.slice(0, 3).join(' ');

    try {
        const response = await github.octokit.search.issuesAndPullRequests({
            q: `repo:${owner}/${repo} in:title ${searchQuery}`,
            per_page: 5
        });

        // If we find issues/PRs (other than the candidate itself if it happens to be one), 
        // it means someone might already be discussing/fixing this.
        const matches = response.data.items.filter((item: any) => item.html_url !== candidate.url);

        if (matches.length > 0) {
            console.log(`[Dedupe] Found ${matches.length} similar existing issues/PRs. Potential duplicate.`);
            console.log(`[Dedupe] Example: ${matches[0].title} (${matches[0].html_url})`);
            return false;
        }

        console.log(`[Dedupe] Candidate appears unique.`);
        return true;
    } catch (e: any) {
        console.warn(`[Dedupe] Search failed, allowing candidate through by default. Error: ${e.message}`);
        return true;
    }
}
