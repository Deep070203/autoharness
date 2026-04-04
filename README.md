# AutoHarness

Autonomous agent harness engineering — in TypeScript.

Give an AI agent a task, let it build and iterate on an agent harness autonomously overnight. It modifies the system prompt, tools, agent configuration, and orchestration, runs the benchmark, checks the score, keeps or discards the change, and repeats.

**LLM-agnostic** via the [Vercel AI SDK](https://sdk.vercel.ai). Switch providers by changing one config string — no code changes needed.

## How it works

The repo has a few files and directories that matter:

- **`agent.ts`** — the entire harness under test in a single file. It contains config, tool definitions, agent construction, and orchestration logic. The adapter section is explicitly marked as fixed; the rest is the primary edit surface for the meta-agent.
- **`program.md`** — instructions for the meta-agent + the directive (what kind of agent to build). This file is edited by the human.
- **`tasks/`** — evaluation tasks in [Harbor](https://github.com/harbor-framework/harbor) format.
- **`.agent/`** — optional workspace artifacts for reusable instructions, notes, or skills.

The metric is total score produced by the benchmark's task test suites. The meta-agent hill-climbs on this score.

## Quick start

Requirements: Docker, Node.js 22+, [uv](https://docs.astral.sh/uv/) (for Harbor CLI), and API keys for your chosen provider.

```bash
# 1. Install dependencies
npm install

# 2. Set up environment variables
cat > .env << 'EOF'
OPENAI_API_KEY=...
# Optional: add keys for other providers
# ANTHROPIC_API_KEY=...
# GOOGLE_GENERATIVE_AI_API_KEY=...
EOF

# 3. Build base image
docker build -f Dockerfile.base -t autoharness-base .

# 4. Add tasks to tasks/ (see Task format below)

# 5. Run all tasks
rm -rf jobs; mkdir -p jobs && \
  uv run harbor run -p tasks/ -n 100 \
  --agent-import-path agent:AutoAgent \
  -o jobs --job-name latest > run.log 2>&1
```

## Switching models

Change the `MODEL` constant in `agent.ts`:

```typescript
// OpenAI
const MODEL = "openai/gpt-5";

// Anthropic
const MODEL = "anthropic/claude-opus-4-1";

// Google
const MODEL = "google/gemini-2.5-pro";

// Mistral
const MODEL = "mistral/mistral-large-latest";
```

Install additional provider packages as needed:
```bash
npm install @ai-sdk/mistral @ai-sdk/groq @ai-sdk/deepseek
```

## Running the meta-agent

Point your coding agent at the repo and prompt:

```
Read program.md and let's kick off a new experiment!
```

The meta-agent will read the directive, inspect the current harness, run the benchmark, diagnose failures, modify `agent.ts`, and iterate.

## Project structure

```
agent.ts              -- single-file harness under test
  editable section    -- prompt, tools, agent config, orchestration
  fixed adapter       -- Harbor integration + ATIF trajectory serialization
src/
  harbor.ts           -- Harbor BaseEnvironment/AgentContext interfaces
  atif.ts             -- ATIF v1.6 trajectory serializer
program.md            -- meta-agent instructions + directive
Dockerfile.base       -- base image (Node 22)
.agent/               -- optional agent workspace artifacts
tasks/                -- benchmark tasks (Harbor format)
jobs/                 -- Harbor job outputs
results.tsv           -- experiment log (created by meta-agent, gitignored)
run.log               -- latest run output
```

## Task format

Add tasks to `tasks/` following [Harbor's task format](https://harborframework.com/docs/tasks):

```
tasks/my-task/
  task.toml             -- config (timeouts, metadata)
  instruction.md        -- prompt sent to the agent
  tests/
    test.sh             -- entry point, writes /logs/reward.txt
    test.py             -- verification (deterministic or LLM-as-judge)
  environment/
    Dockerfile          -- task container (FROM autoharness-base)
    files/              -- reference files mounted into container
```

Tests write a score (0.0–1.0) to the verifier logs. The meta-agent hill-climbs on this.

## Design choices

- **LLM-agnostic.** Single harness supports 25+ providers via Vercel AI SDK.
- **Program the meta-agent, not the harness directly.** The human steers the loop through `program.md`, while the meta-agent edits `agent.ts`.
- **Single-file, tool-driven harness.** The implementation lives in one file for simplicity, but tool definitions stay structured so the harness can evolve cleanly.
- **Docker isolation.** The agent runs in a container. It can't damage the host.
- **Score-driven.** Every experiment produces a numeric score. Keep if better, discard if not.
- **Harbor-compatible tasks.** Tasks use the same format as Harbor benchmarks.

## Cleanup

Docker images and containers accumulate across runs. Clean up regularly:

```bash
# Harbor's cached task images + task cache
uv run harbor cache clean -f

# Full Docker nuke
docker system prune -a -f

# Lighter: just dead containers
docker container prune -f
```

## License

MIT
