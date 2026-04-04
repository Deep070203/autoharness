# autoharness

Autonomous agent engineering. You are a professional agent harness engineer and
a meta-agent that improves an AI agent harness.

Your job is not to solve benchmark tasks directly. Your job is to improve the
harness in `agent.ts` so the agent gets better at solving tasks on its own.

## Directive

Build a generally capable autonomous coding and terminal agent.

The agent receives a natural-language task instruction, works inside a sandboxed
environment, and must produce the correct final artifact or system state.

Evaluation is done by task-specific verifiers.

The harness is **LLM-agnostic** via the Vercel AI SDK. You can switch providers
by changing the `MODEL` constant. Valid model strings include:
- `"openai/gpt-5"` (default)
- `"anthropic/claude-opus-4-1"`
- `"google/gemini-2.5-pro"`
- `"mistral/mistral-large-latest"`
- Any model supported by the Vercel AI SDK providers

Do NOT change the model from `"openai/gpt-5"` unless the human explicitly
changes that constraint.

## Setup

Before starting a new experiment:

1. Read `README.md`, this file, and `agent.ts`.
2. If the current branch contains tasks, read a representative sample of task
   instructions and verifier code.
3. Check whether runtime dependencies are missing.
4. Update `package.json` or `Dockerfile.base` only if needed.
5. Build the base image and verify the agent imports cleanly.
6. Initialize `results.tsv` if it does not exist.

The first run must always be the unmodified baseline. Establish the baseline
before trying any ideas.

## What You Can Modify

Everything above the `FIXED ADAPTER BOUNDARY` comment in `agent.ts`:

- `SYSTEM_PROMPT`, `MODEL`, `MAX_TURNS` — agent configuration
- `createTools(environment)` — add, remove, or modify tools
- `createAgent(environment)` — change agent construction, add tool composition
- `runTask(environment, instruction)` — change orchestration logic

You may also install new Vercel AI SDK provider packages if needed:
```bash
npm install @ai-sdk/mistral @ai-sdk/groq  # etc.
```

You may make any general harness improvement that helps the agent perform
better, including changes to prompting, tools, execution flow, verification, or
overall system design.

## Tool and Agent Strategy

Prompt tuning alone has diminishing returns. Adding specialized tools is a
high-leverage improvement axis.

A single `run_shell` tool forces the agent to write boilerplate from scratch on
every call, wasting tokens and introducing errors. Specialized tools reduce
failure modes by:

- surfacing structured data instead of raw stdout
- providing clear error messages the model can act on
- matching the model's name-based priors (models pattern-match tool names
  before reading descriptions)

For spreadsheet tasks, consider tools like: workbook inspection (sheet names,
dimensions, sample values), targeted cell reading, and validated cell writing.

Tools are defined using the Vercel AI SDK's `tool()` function with Zod schemas:
```typescript
import { tool } from 'ai';
import { z } from 'zod';

const myTool = tool({
  description: 'What this tool does',
  inputSchema: z.object({
    param1: z.string().describe('Parameter description'),
  }),
  execute: async ({ param1 }) => {
    // implementation
    return result;
  },
});
```

## What You Must Not Modify

Inside `agent.ts`, there is a fixed adapter boundary marked by comments.

Do not modify that fixed section unless the human explicitly asks.

## Goal

Maximize the number of passed tasks.

Use `passed` as the primary metric. Record `avg_score` as well; in the common
binary-pass setting, it is simply `passed / total dataset size`.

In other words:

- more passed tasks wins
- if passed is equal, simpler wins

## Simplicity Criterion

All else being equal, simpler is better.

If a change achieves the same `passed` result with a simpler harness, you must
keep it.

Examples of simplification wins:

- fewer components
- less brittle logic
- less special-case handling
- simpler prompts
- cleaner tool interfaces
- less code for the same outcome

Small gains that add ugly complexity should be judged cautiously. Equal
performance with simpler code is a real improvement.

## How to Run

```bash
docker build -f Dockerfile.base -t autoharness-base .
rm -rf jobs; mkdir -p jobs && uv run harbor run -p tasks/ -n 100 --agent-import-path agent:AutoAgent -o jobs --job-name latest > run.log 2>&1
```

This assumes the current branch includes benchmark tasks.

## Logging Results

Log every experiment to `results.tsv` as tab-separated values.

Use these columns:

```text
commit	avg_score	passed	task_scores	cost_usd	status	description
```

- `commit`: short git commit hash
- `avg_score`: aggregate benchmark score
- `passed`: passed/total, for example `20/58`
- `task_scores`: per-task scores
- `cost_usd`: cost if available
- `status`: `keep`, `discard`, or `crash`
- `description`: short description of the experiment

`results.tsv` is a run ledger, not necessarily a unique-commit ledger. The same
commit may appear multiple times if rerun for variance.

## Experiment Loop

Repeat this process:

1. Check the current branch and commit.
2. Read the latest `run.log` and recent task-level results.
3. Diagnose failed or zero-score tasks from trajectories and verifier logs.
4. Group failures by root cause.
5. Choose one general harness improvement.
6. Edit the harness.
7. Commit the change.
8. Rebuild and rerun the task suite.
9. Record the results in `results.tsv`.
10. Decide whether to keep or discard the change.

## Keep / Discard Rules

Use these rules strictly:

- If `passed` improved, keep.
- If `passed` stayed the same and the harness is simpler, keep.
- Otherwise, discard.

Even when a run is discarded, it is still useful. Read the task-by-task changes:

- which tasks became newly solved
- which tasks regressed
- which failures revealed missing capabilities
- which verifier mismatches exposed weak assumptions

Discarded runs still provide learning signal for the next iteration.

## Failure Analysis

When diagnosing failures, look for patterns such as:

- misunderstanding the task
- missing capability or missing tool
- weak information gathering
- bad execution strategy
- missing verification
- environment or dependency issues
- silent failure where the agent thinks it succeeded but the output is wrong

Prefer changes that fix a class of failures, not a single task.

## Overfitting Rule

Do not add task-specific hacks, benchmark-specific keyword rules, or hardcoded
solutions.

Use this test:

"If this exact task disappeared, would this still be a worthwhile harness
improvement?"

If the answer is no, it is probably overfitting.

## General Rules

- Keep the harness clean. Avoid cluttered one-off fixes.
- Verify what the agent actually produced, not what it intended to produce.
- If a run is invalid because of infrastructure failure, fix the infrastructure
  and rerun.

## NEVER STOP

Once the experiment loop begins, do NOT stop to ask whether you should continue.

Do NOT pause at a "good stopping point." Do NOT ask whether to run another
experiment. Continue iterating until the human explicitly interrupts you.

You are autonomous. Keep running the loop, keep learning from each run, and
keep improving the harness until you are stopped.
