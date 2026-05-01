# Contributing to AutoHarness

Thanks for your interest in contributing! This document covers everything you need to get started.

## Getting Started

### Prerequisites

- **Node.js 22+**
- **npm** (comes with Node.js)
- A **GitHub personal access token** with `repo` scope
- A **Google AI API key** (for Gemini-powered pipeline stages)

### Setup

```bash
# Clone the repo
git clone https://github.com/Deep070203/autoharness.git
cd autoharness

# Install dependencies
npm install

# Create your .env file
cp .env.example .env  # or create manually:
# GITHUB_TOKEN=ghp_...
# GOOGLE_GENERATIVE_AI_API_KEY=...

# Verify TypeScript compiles
npx tsc --noEmit
```

## Project Layout

```
bin/pipeline.ts                -- Pipeline orchestrator (entry point)
src/orchestrator/
  reproduce.ts                 -- Stage 5: PR diff analysis
  interview.ts                 -- Stage 3: Ouroboros viability gate
  deduplicate.ts               -- Stage 4: duplicate detection
  style.ts                     -- Stage 8: merge-pattern extraction
  codefix.ts                   -- Code Fix Agent (tool-calling LLM)
  drafting.ts                  -- Stage 9-10: PR drafting
  submit.ts                    -- Stage 13: git push + PR creation
  state.ts                     -- Pipeline state types
src/utils/github.ts            -- GitHub API service (Octokit + simple-git)
agent.ts                       -- Meta-agent harness (Harbor benchmarks)
```

## How to Contribute

### Reporting Issues

Open an issue with:
- A clear title describing the problem
- Steps to reproduce (if applicable)
- Expected vs actual behavior
- Relevant logs or error output

### Submitting Changes

1. **Fork** the repository
2. **Create a branch** from `main`:
   ```bash
   git checkout -b fix/your-change-description
   ```
3. **Make your changes** — keep commits focused and atomic
4. **Run the type checker** before committing:
   ```bash
   npx tsc --noEmit
   ```
5. **Push** and open a Pull Request against `main`

### PR Guidelines

- **Title**: Use a short, descriptive title. Prefix with `fix:`, `feat:`, or `chore:` as appropriate.
- **Body**: Describe what changed and why. If fixing a bug, explain the root cause.
- **Scope**: One fix or feature per PR. Don't bundle unrelated changes.
- **Tests**: If you modify pipeline stages, run `npx tsx bin/pipeline.ts` against a test repo to verify end-to-end behavior.

## Code Style

- **TypeScript** with strict mode enabled
- **ES Modules** (`"type": "module"` in package.json, `.js` extensions in imports)
- No unnecessary comments — code should be self-documenting
- No error handling for impossible scenarios — only validate at system boundaries
- Prefer `patch_file` patterns (targeted edits) over full file rewrites

### Model References

All LLM calls use the Vercel AI SDK. The model is configured per-file as a `MODEL` constant:

```typescript
import { google } from "@ai-sdk/google";
const MODEL: LanguageModel = google("gemini-2.5-pro") as unknown as LanguageModel;
```

To switch providers, install the corresponding `@ai-sdk/*` package and update the import.

## Architecture Notes

### Pipeline Stages

Each stage is a standalone async function in `src/orchestrator/`. Stages communicate via typed return values — no shared mutable state. The pipeline in `bin/pipeline.ts` wires them together sequentially.

### Code Fix Agent (`codefix.ts`)

The agent uses `ToolLoopAgent` from the Vercel AI SDK with 6 tools (read, write, patch, shell, list, search). Key design constraints:

- **Max 20 tool-call steps** to prevent runaway execution
- **Mandatory verification** — the agent must run tests/build after edits
- **File tracking** — only files the agent explicitly modifies get staged for commit
- The system prompt includes self-awareness guardrails and security rails

### GitHub Service (`github.ts`)

All GitHub API interactions go through `GitHubService`. Key methods:
- `getPRDiff()` / `getPRFiles()` — fetch real PR diffs
- `getDefaultBranch()` — dynamic branch detection
- `forkRepository()` / `cloneRepository()` — repo setup
- `getContributingGuidelines()` — fetches this file!

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `GITHUB_TOKEN` | Yes | GitHub API access + authenticated git push |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes | Gemini model access for all LLM stages |

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
