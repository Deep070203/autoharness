#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import path from 'node:path';
import { TrialOrchestrator } from '../src/orchestrator/trial.js';

async function main() {
    const { values, positionals } = parseArgs({
        options: {
            task: { type: 'string', short: 'p' },
            output: { type: 'string', short: 'o' },
            agent: { type: 'string', short: 'a', default: 'AutoAgent' }
        },
        allowPositionals: true
    });

    const cmd = positionals[0];
    if (cmd !== 'run') {
        console.error('Usage: autoharness run -p <task_dir> -o <output_dir> [-a agent_name]');
        process.exit(1);
    }

    if (!values.task || !values.output) {
        console.error('Task path (-p) and output path (-o) are required.');
        process.exit(1);
    }

    const runDir = path.join(values.output, `trial_${Date.now()}`);
    const trial = new TrialOrchestrator(values.task, runDir, values.agent as string);

    try {
        await trial.setup();
        await trial.runTask();
        await trial.runVerification();
    } catch (err: any) {
        console.error(`[Fatal] Run failed: ${err.message}`);
    } finally {
        await trial.tearDown();
    }
}

main().catch(console.error);
