import { execSync } from "child_process";
import * as path from "path";

export interface VerificationResult {
    passed: boolean;
    reproPassed: boolean;
    regressionPassed: boolean;
    reproOutput: string;
    regressionOutput: string;
    summary: string;
}

/**
 * Verifier & QA Agent (inspired by SWE-bench / Breken Proof Contract).
 * Verifies that:
 * 1. The reproduction test that failed previously now PASSES.
 * 2. The project's existing test suite passes with zero regressions.
 */
export async function runVerification(
    repoPath: string,
    reproCommand?: string,
    customTestCommand?: string
): Promise<VerificationResult> {
    console.log(`\n🛡️ [Verifier Agent] Verifying fix in ${repoPath}...`);

    let reproPassed = true;
    let reproOutput = "";

    // 1. Check reproduction proof
    if (reproCommand) {
        console.log(`[Verifier] Running reproduction command: ${reproCommand}`);
        try {
            const out = execSync(reproCommand, {
                cwd: repoPath,
                encoding: "utf-8",
                timeout: 90_000,
                env: { ...process.env, CI: "true" }
            });
            reproOutput = out.substring(0, 4000);
            reproPassed = true;
            console.log(`[Verifier] ✅ Reproduction test now PASSES! Proof confirmed.`);
        } catch (e: any) {
            reproPassed = false;
            reproOutput = (e.stdout || e.stderr || e.message).substring(0, 4000);
            console.warn(`[Verifier] ❌ Reproduction test still fails:\n${reproOutput.substring(0, 500)}`);
        }
    }

    // 2. Check regression test suite
    let regressionPassed = true;
    let regressionOutput = "";

    // Determine default test runner if not provided
    let testCmd = customTestCommand;
    if (!testCmd) {
        testCmd = detectTestCommand(repoPath);
    }

    if (testCmd) {
        console.log(`[Verifier] Running regression test suite: ${testCmd}`);
        try {
            const out = execSync(testCmd, {
                cwd: repoPath,
                encoding: "utf-8",
                timeout: 180_000,
                env: { ...process.env, CI: "true" }
            });
            regressionOutput = out.substring(0, 3000);
            regressionPassed = true;
            console.log(`[Verifier] ✅ Regression suite passed.`);
        } catch (e: any) {
            regressionPassed = false;
            regressionOutput = (e.stdout || e.stderr || e.message).substring(0, 3000);
            console.warn(`[Verifier] ⚠️ Regression tests had errors:\n${regressionOutput.substring(0, 400)}`);
        }
    } else {
        regressionOutput = "No automated test script detected in project.";
    }

    const passed = reproPassed && regressionPassed;

    return {
        passed,
        reproPassed,
        regressionPassed,
        reproOutput,
        regressionOutput,
        summary: passed
            ? "All verification checks passed cleanly (reproduction + regressions)."
            : `Verification failed. Repro passed: ${reproPassed}, Regressions passed: ${regressionPassed}`
    };
}

function detectTestCommand(repoPath: string): string | undefined {
    const fs = require("fs");
    if (fs.existsSync(path.join(repoPath, "package.json"))) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf-8"));
            if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes("no test specified")) {
                return "npm test";
            }
        } catch (e) {}
    }
    if (fs.existsSync(path.join(repoPath, "pyproject.toml")) || fs.existsSync(path.join(repoPath, "setup.py"))) {
        return "pytest";
    }
    if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) {
        return "cargo test";
    }
    if (fs.existsSync(path.join(repoPath, "go.mod"))) {
        return "go test ./...";
    }
    return undefined;
}
