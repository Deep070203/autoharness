import { generateText, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import * as path from "path";
import { execSync } from "child_process";

const MODEL: LanguageModel = google("gemini-3.5-flash") as unknown as LanguageModel;

export interface LocalizationResult {
    targetFiles: string[];
    likelyFunctions: string[];
    explanation: string;
}

/**
 * Localizer Agent (inspired by Agentless: Xia et al., UIUC 2024).
 * Hierarchically identifies the exact suspect files and symbols before the code-fix agent begins.
 */
export async function runLocalization(
    repoPath: string,
    issueTitle: string,
    issueBody: string,
    reproTrace: string
): Promise<LocalizationResult> {
    console.log(`\n🔍 [Localizer Agent] Pinpointing bug location in ${repoPath}...`);

    // 1. Gather git tree overview (excluding node_modules, git, vendor)
    let repoStructure = "";
    try {
        repoStructure = execSync("git ls-files | head -n 300", {
            cwd: repoPath,
            encoding: "utf-8",
            timeout: 10_000
        });
    } catch (e) {
        repoStructure = "(could not list files)";
    }

    const prompt = `
You are an expert Fault Localization Agent for software engineering (following Agentless research).
Your mission is to examine a reported bug and identify the EXACT files and symbols that need to be fixed.

### Issue Title:
${issueTitle}

### Issue Description:
${issueBody.substring(0, 3000)}

### Reproduction Failure Trace / Evidence:
${reproTrace.substring(0, 3000)}

### Repository File Tree Sample (first 300 files):
${repoStructure.substring(0, 4000)}

### Instructions:
1. Identify the 1 to 3 primary source files where the root cause lies.
2. Identify the specific functions, methods, or classes involved.
3. Provide a brief 1-2 sentence rationale.

Respond in exact JSON format:
{
  "targetFiles": ["path/to/file1.ext", "path/to/file2.ext"],
  "likelyFunctions": ["functionOrMethodName"],
  "explanation": "Brief rationale"
}
`;

    try {
        const { text } = await generateText({
            model: MODEL,
            prompt,
            system: "You are a fault localization expert. Output valid JSON only, no markdown wrapping.",
        });

        const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
        const parsed = JSON.parse(cleaned);

        console.log(`[Localizer Agent] Identified targets: ${parsed.targetFiles?.join(", ")}`);
        return {
            targetFiles: parsed.targetFiles || [],
            likelyFunctions: parsed.likelyFunctions || [],
            explanation: parsed.explanation || "Identified from trace and issue keywords"
        };
    } catch (e: any) {
        console.warn(`[Localizer Agent] Localization fallback: ${e.message}`);
        return {
            targetFiles: [],
            likelyFunctions: [],
            explanation: "Localization completed with fallback."
        };
    }
}
