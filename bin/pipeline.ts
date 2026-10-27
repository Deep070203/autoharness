import { parseArgs } from "node:util";
import { PipelineEngine } from "../src/orchestrator/engine.js";
import { awaitHumanGates } from "../src/orchestrator/drafting.js";

async function main() {
    const { values } = parseArgs({
        options: {
            repo: { type: "string", short: "r", default: "semantica-agi/semantica" },
            issue: { type: "string", short: "i" },
            "similar-pr": { type: "string", short: "p" },
            "similar-issue": { type: "string", short: "s" },
            help: { type: "boolean", short: "h" }
        },
        allowPositionals: true
    });

    if (values.help) {
        console.log(`
AutoHarness — Autonomous Issue Resolver & Coding Agent
Usage:
  npx tsx bin/pipeline.ts [options]

Options:
  -r, --repo <owner/repo>       Target repository (default: semantica-agi/semantica)
  -i, --issue <number>          Specific GitHub issue number to reproduce and fix
  -p, --similar-pr <number>     Reference PR number for style and fix guidance
  -s, --similar-issue <number>  Reference issue number for extra guidance
  -h, --help                    Show this help message
        `);
        process.exit(0);
    }

    const repoInput = values.repo || "semantica-agi/semantica";
    const targetIssueNumber = values.issue ? parseInt(values.issue, 10) : undefined;
    const similarPrNumber = values["similar-pr"] ? parseInt(values["similar-pr"], 10) : undefined;
    const similarIssueNumber = values["similar-issue"] ? parseInt(values["similar-issue"], 10) : undefined;

    const engine = new PipelineEngine();

    // Hook up terminal console listeners
    engine.on("event", (evt) => {
        const time = new Date(evt.timestamp).toLocaleTimeString();
        if (evt.type === "stage:start") {
            console.log(`\n[${time}] 🚀 Stage Started: ${evt.stage}`);
        } else if (evt.type === "stage:log") {
            console.log(`[${time}] [${evt.stage || "Pipeline"}] ${evt.data}`);
        } else if (evt.type === "proof:established") {
            console.log(`\n[${time}] 🧪 Breken Proof Established!`);
            console.log(`  Command: \`${evt.data.command}\``);
        } else if (evt.type === "localization:complete") {
            console.log(`[${time}] 🎯 Localized Targets: ${evt.data.targetFiles?.join(", ")}`);
        } else if (evt.type === "codefix:complete") {
            console.log(`[${time}] 🔧 CodeFix Complete: ${evt.data.modifiedFiles?.length || 0} files modified.`);
        } else if (evt.type === "verification:complete") {
            console.log(`[${time}] 🛡️ Verification: ${evt.data.summary}`);
        } else if (evt.type === "pr:submitted") {
            console.log(`\n🎉 Pull Request Submitted! URL: ${evt.data.prUrl}`);
        } else if (evt.type === "pipeline:error") {
            console.error(`\n❌ Error: ${evt.data.message}`);
        }
    });

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  AutoHarness Autonomous Contributor Engine`);
    console.log(`  Target: ${repoInput}`);
    console.log(`  Closed-Loop Behavioral Memory: Active (arXiv:2607.13091)`);
    console.log(`${"═".repeat(60)}`);

    const result = await engine.execute({
        repo: repoInput,
        issueNumber: targetIssueNumber,
        similarPrNumber,
        similarIssueNumber,
        waitForGate: async (gateData) => {
            const approved = await awaitHumanGates(
                gateData.draft,
                gateData.codeFix,
                gateData.targetOwner,
                gateData.targetRepo,
                engine.getMemory()
            );
            return { approved };
        }
    });

    if (result.success) {
        console.log(`\n✅ Completed successfully: ${result.prUrl}`);
    } else {
        console.log(`\n⚠️  Pipeline finished without submission: ${result.error || "Done"}`);
    }
}

main().catch(console.error);
