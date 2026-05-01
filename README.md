# AutoHarness

Autonomous OSS contributor pipeline + agent harness engineering — in TypeScript.

A **13-stage pipeline** that sources bug-fix candidates from open-source repositories, analyzes merged PRs for fix patterns, deploys a **tool-calling coding agent** that writes real fixes in cloned repos, and submits pull requests — with a human gate before anything goes public.

**LLM-agnostic** via the [Vercel AI SDK](https://sdk.vercel.ai). Switch providers by changing one config string.

## OSS Contributor Pipeline

The pipeline automates the full lifecycle of an open-source contribution:

```
Stage 1-2   Sourcing & Filtering      ← Fetch recent merged PRs, filter for bug fixes
Stage 3     Ouroboros Interview        ← LLM viability gate (KEEP / DROP)
Stage 4     Deduplication              ← Check for existing similar issues/PRs
Stage 5     Real Analysis              ← Fetch PR diff via GitHub API, deep LLM analysis
Stage 8     Merge-Pattern Matching     ← Extract repo's PR style from last 10 merged PRs
    ↓
          Code Fix Agent               ← Tool-calling agent writes actual code fixes
    ↓
Stage 9-10  PR Drafting                ← Generate title/body from real code changes
Stage 11-12 Human Review Gate          ← CLI prompt: review diff, approve CLA
Stage 13    Submission                 ← Git push + PR creation via GitHub API
```

### The Code Fix Agent

The core of the pipeline. A `ToolLoopAgent` that operates inside the cloned fork with 6 tools:

| Tool | Purpose |
|------|---------|
| `read_file` | Read any file in the repo |
| `write_file` | Create or overwrite files |
| `patch_file` | Surgical search-and-replace edits (preferred for existing files) |
| `run_shell` | Execute commands — tests, build, grep |
| `list_directory` | Navigate the project structure |
| `search_codebase` | Grep across the repo for patterns |

The agent's system prompt is built on patterns from production coding agents:
- **Self-awareness guardrails** — explicitly warns the LLM about common failure modes (claiming correctness without running code)
- **Mandatory verification** — every edit must be followed by running tests/build/command
- **No-narration rule** — cuts output token waste by ~30%
- **Security rails** — OWASP top 10 awareness to avoid introducing vulnerabilities
- **Post-fix self-review** — agent reviews its own diff and strips unnecessary complexity

### Running the Pipeline

```bash
# Run the full pipeline against a target repo
npx tsx bin/pipeline.ts
```

The target repo is configured in `bin/pipeline.ts` (default: `exo-explore/exo`). The pipeline will:
1. Fetch and filter recent merged PRs
2. Run each through viability interview + deduplication
3. Analyze the PR diff and find similar fix patterns
4. Deploy the coding agent to write a real fix
5. Draft the PR and pause for human approval
6. Submit on approval

## Quick Start

### Requirements

- Node.js 22+
- GitHub personal access token (for API + push)
- Google AI API key (for LLM stages)
- Docker (optional, for sandboxed meta-agent harness)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
cat > .env << 'EOF'
GITHUB_TOKEN=ghp_...
GOOGLE_GENERATIVE_AI_API_KEY=...
EOF

# 3. Run the OSS pipeline
npx tsx bin/pipeline.ts
```

## Project Structure

```
bin/
  pipeline.ts               -- 13-stage OSS contributor pipeline orchestrator

src/orchestrator/
  reproduce.ts              -- Stage 5: real PR diff analysis via GitHub API
  interview.ts              -- Stage 3: Ouroboros viability interview (LLM gate)
  deduplicate.ts            -- Stage 4: duplicate detection via GitHub search
  style.ts                  -- Stage 8: merge-pattern extraction from recent PRs
  codefix.ts                -- Code Fix Agent: tool-calling LLM with 6 tools
  drafting.ts               -- Stage 9-10: PR title/body from real code changes
  submit.ts                 -- Stage 13: git push + PR creation
  state.ts                  -- Pipeline state types and GitHub issue tracker

src/utils/
  github.ts                 -- GitHub service (Octokit + simple-git)
                               getPRDiff, getPRFiles, getDefaultBranch,
                               forkRepository, cloneRepository, etc.

agent.ts                    -- Meta-agent harness (Harbor benchmark runner)
program.md                  -- Meta-agent instructions + directive
Dockerfile.base             -- Base image (Node 22)
tasks/                      -- Benchmark tasks (Harbor format)
```

## Meta-Agent Harness

The repo also includes a **meta-agent loop** for benchmark-driven harness engineering:

- **`agent.ts`** — the harness under test. Contains config, tool definitions, agent construction, and orchestration. The adapter section is fixed; the rest is the edit surface.
- **`program.md`** — instructions for the meta-agent directing what kind of agent to build.
- **`tasks/`** — evaluation tasks in [Harbor](https://github.com/harbor-framework/harbor) format.

The meta-agent hill-climbs on benchmark scores by modifying `agent.ts`.

```bash
# Build base image
docker build -f Dockerfile.base -t autoharness-base .

# Run all tasks
rm -rf jobs; mkdir -p jobs && \
  uv run harbor run -p tasks/ -n 100 \
  --agent-import-path agent:AutoAgent \
  -o jobs --job-name latest > run.log 2>&1
```

## Switching Models

Change the `MODEL` constant in `agent.ts` or the orchestrator files:

```typescript
import { google } from "@ai-sdk/google";
const MODEL = google("gemini-2.5-flash");

// Or use other providers:
// import { anthropic } from "@ai-sdk/anthropic";
// const MODEL = anthropic("claude-sonnet-4-20250514");
```

## Design Choices

- **LLM-agnostic.** Single harness supports 25+ providers via Vercel AI SDK.
- **Real code, not mocks.** The pipeline fetches actual diffs, writes actual fixes, and pushes actual PRs.
- **Human-in-the-loop.** Nothing goes to GitHub without explicit human approval at Stage 11-12.
- **Tool-calling agent.** The code fix agent uses a proven agentic loop (read → search → patch → test → verify) instead of single-shot generation.
- **Token-efficient prompts.** System prompts are compressed using patterns from production coding agents — tight tool descriptions, no narration, capped context windows.
- **GitHub Issue as state.** Pipeline progress is tracked via issue checkboxes, surviving session restarts.

## Dependencies

| Package | Purpose |
|---------|---------|
| `ai` | Vercel AI SDK — model abstraction + tool loop |
| `@ai-sdk/google` | Google Gemini provider |
| `@octokit/rest` | GitHub API client |
| `simple-git` | Git operations (clone, branch, push) |
| `zod` | Tool input schema validation |
| `dotenv` | Environment variable loading |

## Cleanup

```bash
# Docker cleanup
docker system prune -a -f

# Remove cloned repos
rm -rf workspace/repos/*
```

## License

MIT
