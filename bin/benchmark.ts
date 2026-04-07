#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { TrialOrchestrator } from '../src/orchestrator/trial.js';

async function main() {
    const { values, positionals } = parseArgs({
        options: {
            dataset: { type: 'string', short: 'd' },
            output: { type: 'string', short: 'o' },
            agent: { type: 'string', short: 'a', default: 'AutoAgent' },
            split: { type: 'string', short: 's', default: 'train' },
            'subset-file': { type: 'string' }
        },
        allowPositionals: true
    });

    if (!values.dataset || !values.output) {
        console.error('Dataset path (-d) and output path (-o) are required.');
        process.exit(1);
    }

    const items = await fs.readdir(values.dataset, { withFileTypes: true });
    let tasks = items.filter(d => d.isDirectory()).map(d => d.name);

    if (values['subset-file']) {
        try {
            const subsetStr = await fs.readFile(values['subset-file'], 'utf-8');
            const subsetTasks: string[] = JSON.parse(subsetStr);
            tasks = tasks.filter(t => subsetTasks.includes(t));
        } catch (e) {
            console.warn(`[Benchmark] Could not read subset file ${values['subset-file']}, assuming empty.`);
            tasks = [];
        }
    }

    if (tasks.length === 0) {
        console.error('No tasks found in dataset directory.');
        process.exit(1);
    }

    console.log(`[Benchmark] Starting benchmark over ${tasks.length} tasks (${values.split} split)...`);

    const results: Record<string, { reward: number, passed: boolean }> = {};
    let passed = 0;

    const baseOutputDir = path.resolve(values.output);
    await fs.mkdir(baseOutputDir, { recursive: true });

    for (const task of tasks) {
        const taskPath = path.join(values.dataset, task);
        const taskOutputDir = path.join(baseOutputDir, task);

        console.log(`\n--- Running Task: ${task} ---`);
        const trial = new TrialOrchestrator(taskPath, taskOutputDir, values.agent as string);

        try {
            await trial.setup();
            await trial.runTask();
            const reward = await trial.runVerification();

            const isPassed = reward >= 1.0;
            results[task] = { reward, passed: isPassed };
            if (isPassed) passed++;

        } catch (err: any) {
            console.error(`[Fatal] Task ${task} failed: ${err.message}`);
            results[task] = { reward: 0, passed: false };
        } finally {
            await trial.tearDown();
        }
    }

    const report = {
        timestamp: new Date().toISOString(),
        split: values.split,
        total_tasks: tasks.length,
        passed_tasks: passed,
        results
    };

    const workspaceDir = path.resolve('workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    let resultFile = 'train_results.json';
    if (values.split !== 'train') {
        resultFile = `${values.split}_results.json`;
    }

    await fs.writeFile(path.join(workspaceDir, resultFile), JSON.stringify(report, null, 2));

    console.log(`\n[Benchmark] Complete! Passed ${passed}/${tasks.length} tasks.`);
    console.log(`[Benchmark] Results saved to workspace/${resultFile}`);
}

main().catch(console.error);
