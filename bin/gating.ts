#!/usr/bin/env tsx
import path from 'node:path';
import fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

async function runBenchmark(split: string, subsetFile: string = '') {
    const subsetArg = subsetFile ? `--subset-file ${subsetFile}` : '';
    const outputDir = `outputs/${split}_${Date.now()}`;
    const cmd = `npx tsx bin/benchmark.ts -d tasks -o ${outputDir} -s ${split} ${subsetArg}`;
    console.log(`[Gating] Running: ${cmd}`);
    try {
        await execAsync(cmd, { stdio: 'inherit' } as any);
        const resultFile = path.resolve(`workspace/${split}_results.json`);
        const resultContent = await fs.readFile(resultFile, 'utf-8');
        return JSON.parse(resultContent);
    } catch (e: any) {
        console.error(`[Gating] Benchmark execution failed: ${e.message}`);
        return null; // Benchmark crash
    }
}

async function revertAndExit(reason: string) {
    console.error(`\n[Gating] ❌ GATE FAILED: ${reason}`);
    console.error(`[Gating] Reverting agent.ts...`);
    try {
        await execAsync(`git checkout agent.ts`);
    } catch (e) {
        console.error(`[Gating] Failed to revert: ${e}`);
    }
    process.exit(1);
}

async function main() {
    console.log(`\n=== 🛡️  NeoSigmaAI 3-Step Gate ===\n`);
    const workspaceDir = path.resolve('workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    const suiteFile = path.join(workspaceDir, 'suite.json');

    // Check if regression suite exists
    let hasRegressionSuite = false;
    try {
        const suite = JSON.parse(await fs.readFile(suiteFile, 'utf-8'));
        if (Array.isArray(suite) && suite.length > 0) hasRegressionSuite = true;
    } catch (e) {
        // file doesn't exist or is empty
        await fs.writeFile(suiteFile, '[]');
    }

    // Step 1: Regression Suite Protection
    if (hasRegressionSuite) {
        console.log(`[Gate Step 1] Verifying Registration Suite...`);
        const suiteResults = await runBenchmark('suite', suiteFile);
        if (!suiteResults) {
            await revertAndExit("Regression suite benchmark crashed.");
        }
        if (suiteResults.passed_tasks < suiteResults.total_tasks) {
            await revertAndExit(`Regression Suite Failed! Expected ${suiteResults.total_tasks}, got ${suiteResults.passed_tasks}`);
        }
        console.log(`[Gate Step 1] ✅ Regression Suite passed (${suiteResults.passed_tasks}/${suiteResults.total_tasks}).\n`);
    } else {
        console.log(`[Gate Step 1] No regression suite tracked yet. Skipping.\n`);
    }

    // Step 2: Full Test
    console.log(`[Gate Step 2] Running full validation split...`);
    const trainResults = await runBenchmark('train');
    if (!trainResults) {
        await revertAndExit("Validation benchmark crashed.");
    }

    // Check vs best recorded score
    const resultsTsv = path.join(workspaceDir, 'results.tsv');
    let bestScore = 0;
    try {
        const history = await fs.readFile(resultsTsv, 'utf-8');
        for (const line of history.split('\n').filter(Boolean)) {
            const parts = line.split('\t');
            if (parts.length > 2 && parts[0] !== 'commit') {
                const score = parseFloat(parts[1]);
                if (score > bestScore) bestScore = score;
            }
        }
    } catch (e) { /* no history yet */ }

    const valScore = trainResults.passed_tasks / trainResults.total_tasks;

    if (valScore < bestScore) {
        await revertAndExit(`Validation Regressed! Score ${valScore.toFixed(3)} is worse than best recorded ${bestScore.toFixed(3)}`);
    }

    console.log(`[Gate Step 2] ✅ Full validation passed (Score: ${valScore.toFixed(3)}, >= Best: ${bestScore.toFixed(3)}).\n`);

    // Step 3: Suite Promotion
    console.log(`[Gate Step 3] Promoting newly solved tasks to Regression Suite...`);
    const suiteTasks: string[] = JSON.parse(await fs.readFile(suiteFile, 'utf-8'));
    let promoted = 0;

    for (const [taskId, result] of Object.entries(trainResults.results) as any) {
        if (result.passed && !suiteTasks.includes(taskId)) {
            suiteTasks.push(taskId);
            promoted++;
            console.log(`   + Promoted task to suite: ${taskId}`);
        }
    }

    if (promoted > 0) {
        await fs.writeFile(suiteFile, JSON.stringify(suiteTasks, null, 2));
        console.log(`[Gate Step 3] ✅ Suite updated. ${promoted} additions.`);
    } else {
        console.log(`[Gate Step 3] ✅ No new tasks to promote.`);
    }

    console.log(`\n🎉 All Gates Passed! Ready to Record!`);
    console.log(`Next step: Run record script to log iteration.\n`);

    // Create a temporary file with the val_score for the record script
    await fs.writeFile(path.join(workspaceDir, '.last_val_score'), valScore.toString());
}

main().catch(console.error);
