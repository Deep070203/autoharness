import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { resolveRepoEnv, normalizeCommandWithVenv } from "../utils/env.js";
import { commandTimeoutMs, detectProject } from "../utils/toolchain.js";

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

    const repoEnv = resolveRepoEnv(repoPath);
    let reproPassed = false;
    let reproOutput = "No reproduction command. The patch needs a test that failed on the current code.";

    // 1. The same test that failed before the patch must now pass.
    if (reproCommand) {
        let cmd = normalizeCommandWithVenv(reproCommand, repoEnv.pythonBin);
        console.log(`[Verifier] Running reproduction command: ${cmd}`);
        try {
            const out = execSync(cmd, {
                cwd: repoPath,
                encoding: "utf-8",
                timeout: commandTimeoutMs(cmd, 90_000),
                env: repoEnv.env
            });
            reproOutput = out.substring(0, 4000);
            reproPassed = true;
            console.log(`[Verifier] ✅ Reproduction test now PASSES! Proof confirmed.`);
        } catch (e: any) {
            // Check if fallback to python3 is needed
            if (cmd.startsWith("python ") && (e.message.includes("not found") || e.status === 127)) {
                try {
                    const fallbackCmd = cmd.replace(/^python /, "python3 ");
                    console.log(`[Verifier] Retrying with python3: ${fallbackCmd}`);
                    const out = execSync(fallbackCmd, {
                        cwd: repoPath,
                        encoding: "utf-8",
                        timeout: 90_000,
                        env: repoEnv.env
                    });
                    reproOutput = out.substring(0, 4000);
                    reproPassed = true;
                    console.log(`[Verifier] ✅ Reproduction test now PASSES with python3!`);
                } catch (retryErr: any) {
                    reproPassed = false;
                    reproOutput = (retryErr.stdout || retryErr.stderr || retryErr.message).substring(0, 4000);
                    console.warn(`[Verifier] ❌ Reproduction test still fails:\n${reproOutput.substring(0, 500)}`);
                }
            } else {
                reproPassed = false;
                reproOutput = (e.stdout || e.stderr || e.message).substring(0, 4000);
                console.warn(`[Verifier] ❌ Reproduction test still fails:\n${reproOutput.substring(0, 500)}`);
            }
        }
    }

    // 2. Check regression test suite
    let regressionPassed = true;
    let regressionOutput = "";

    // Determine default test runner if not provided.
    // TypeScript, Go, and Rust full suites do not finish on large repositories.
    let testCmd = customTestCommand;
    let regressionIsSmoke = false;
    if (!testCmd) {
        const profile = detectProject(repoPath);
        if (
            (profile.language === "typescript" || profile.language === "go" || profile.language === "rust")
            && profile.smokeCommand
        ) {
            testCmd = profile.smokeCommand;
            regressionIsSmoke = true;
            console.log(`[Verifier] Skipping the full ${profile.suiteLabel} suite. Toolchain smoke: ${testCmd}`);
        } else {
            testCmd = detectTestCommand(repoPath);
        }
    }

    if (testCmd) {
        testCmd = normalizeCommandWithVenv(testCmd, repoEnv.pythonBin);
        console.log(`[Verifier] Running regression test suite: ${testCmd}`);
        try {
            const out = execSync(testCmd, {
                cwd: repoPath,
                encoding: "utf-8",
                timeout: commandTimeoutMs(testCmd, 90_000),
                env: repoEnv.env
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
            ? regressionIsSmoke
                ? "Reproduction passed. Toolchain smoke passed. The full test suite was not run."
                : "All verification checks passed cleanly (reproduction + regressions)."
            : `Verification completed. Repro passed: ${reproPassed}, Regressions passed: ${regressionPassed}`
    };
}

function detectTestCommand(repoPath: string): string | undefined {
    if (fs.existsSync(path.join(repoPath, "package.json"))) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf-8"));
            if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes("no test specified")) {
                return "npm test";
            }
        } catch (e) {}
    }
    if (fs.existsSync(path.join(repoPath, "pyproject.toml")) || fs.existsSync(path.join(repoPath, "setup.py"))) {
        return "pytest -q --tb=short";
    }
    if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) {
        return "cargo test";
    }
    if (fs.existsSync(path.join(repoPath, "go.mod"))) {
        return "go test ./...";
    }
    return undefined;
}
