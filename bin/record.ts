#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

async function main() {
    const { values } = parseArgs({
        options: {
            'val-score': { type: 'string' },
            'desc': { type: 'string', short: 'm' }
        }
    });

    const valScore = values['val-score'];
    const desc = values['desc'] || 'Iteration recorded';

    if (valScore === undefined) {
        console.error("Usage: npx tsx bin/record.ts --val-score <score> -m \"description\"");
        process.exit(1);
    }

    let commitHash = 'dirty';
    try {
        const { stdout } = await execAsync(`git rev-parse --short HEAD`);
        commitHash = stdout.trim();
    } catch (e) { }

    const workspaceDir = path.resolve('workspace');
    const resultsFile = path.join(workspaceDir, 'results.tsv');

    // Check if file exists to write header
    let hasHeader = false;
    try {
        await fs.stat(resultsFile);
        hasHeader = true;
    } catch (e) { }

    if (!hasHeader) {
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(resultsFile, "commit\tavg_score\tpassed\ttask_scores\tcost_usd\tstatus\tdescription\n");
    }

    // Try to grab suite pass numbers just for logging
    let numSuitePassed = 0;
    try {
        const suite = JSON.parse(await fs.readFile(path.join(workspaceDir, 'suite.json'), 'utf-8'));
        numSuitePassed = suite.length;
    } catch (e) { }

    const status = "keep"; // If we hit recording, the gate passed

    // commit | avg_score | passed | task_scores(omitted) | cost | status | description
    const entry = `${commitHash}\t${valScore}\t${numSuitePassed}/-\t\t\t${status}\t${desc}\n`;
    await fs.appendFile(resultsFile, entry);

    console.log(`[Record] 📝 Appended result to workspace/results.tsv: Score ${valScore}`);
}

main().catch(console.error);
