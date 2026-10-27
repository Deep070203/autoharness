import express, { Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineEngine, type PipelineEvent } from "../orchestrator/engine.js";
import { BehavioralMemory } from "../utils/memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../../");
const publicDir = path.join(rootDir, "public");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(publicDir));

// State management
let activeEngine: PipelineEngine | null = null;
let eventHistory: PipelineEvent[] = [];
let sseClients: Response[] = [];
let pendingGateResolver: ((value: { approved: boolean; notes?: string }) => void) | null = null;
let latestGateData: any = null;
let currentRunState: {
    status: "IDLE" | "RUNNING" | "AWAITING_APPROVAL" | "COMPLETED" | "FAILED";
    repo?: string;
    issue?: number;
    prUrl?: string;
    error?: string;
} = { status: "IDLE" };

const memory = new BehavioralMemory();

function broadcastEvent(event: PipelineEvent) {
    eventHistory.push(event);
    if (eventHistory.length > 500) eventHistory.shift();

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    sseClients.forEach((client) => {
        try {
            client.write(payload);
        } catch (e) {
            // Client disconnected
        }
    });
}

// ── Endpoints ─────────────────────────────────────────────────────────────

// 1. SSE Stream
app.get("/api/events", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Replay history
    eventHistory.forEach((evt) => {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
    });

    sseClients.push(res);

    req.on("close", () => {
        sseClients = sseClients.filter((c) => c !== res);
    });
});

// 2. Status
app.get("/api/status", (_req: Request, res: Response) => {
    res.json({
        ...currentRunState,
        latestGateData,
        hasPendingGate: pendingGateResolver !== null,
        historyCount: eventHistory.length,
    });
});

// 3. Start Pipeline Run
app.post("/api/run", async (req: Request, res: Response) => {
    if (currentRunState.status === "RUNNING" || currentRunState.status === "AWAITING_APPROVAL") {
        return res.status(409).json({ error: "A pipeline run is already in progress." });
    }

    const { repo, issueNumber, similarPrNumber, similarIssueNumber } = req.body;

    if (!repo || typeof repo !== "string" || !repo.includes("/")) {
        return res.status(400).json({ error: "Invalid repository. Format must be 'owner/repo'." });
    }

    const parsedIssue = issueNumber ? parseInt(issueNumber, 10) : undefined;
    const parsedPr = similarPrNumber ? parseInt(similarPrNumber, 10) : undefined;
    const parsedSimilarIssue = similarIssueNumber ? parseInt(similarIssueNumber, 10) : undefined;

    eventHistory = [];
    latestGateData = null;
    pendingGateResolver = null;
    currentRunState = {
        status: "RUNNING",
        repo,
        issue: parsedIssue,
    };

    activeEngine = new PipelineEngine();

    activeEngine.on("event", (evt: PipelineEvent) => {
        broadcastEvent(evt);
        if (evt.type === "pipeline:error") {
            currentRunState.status = "FAILED";
            currentRunState.error = evt.data?.message;
        } else if (evt.type === "pr:submitted") {
            currentRunState.prUrl = evt.data?.prUrl;
        } else if (evt.type === "pipeline:done") {
            currentRunState.status = evt.data?.success ? "COMPLETED" : "FAILED";
            if (evt.data?.error) currentRunState.error = evt.data.error;
        }
    });

    res.json({ message: "Pipeline execution started", repo, issue: parsedIssue });

    // Execute in background
    activeEngine.execute({
        repo,
        issueNumber: parsedIssue,
        similarPrNumber: parsedPr,
        similarIssueNumber: parsedSimilarIssue,
        waitForGate: async (gateData) => {
            currentRunState.status = "AWAITING_APPROVAL";
            latestGateData = gateData;
            broadcastEvent({
                type: "gate:waiting",
                stage: "GATE",
                data: gateData,
                timestamp: new Date().toISOString(),
            });

            return new Promise((resolve) => {
                pendingGateResolver = resolve;
            });
        },
    }).catch((err) => {
        currentRunState.status = "FAILED";
        currentRunState.error = err.message;
        broadcastEvent({
            type: "pipeline:error",
            data: { message: err.message },
            timestamp: new Date().toISOString(),
        });
    });
});

// 4. Human Gate Decision
app.post("/api/gate", (req: Request, res: Response) => {
    if (!pendingGateResolver) {
        return res.status(400).json({ error: "No pending approval gate to resolve." });
    }

    const { approved, notes } = req.body;
    const resolve = pendingGateResolver;
    pendingGateResolver = null;
    latestGateData = null;
    currentRunState.status = "RUNNING";

    resolve({
        approved: Boolean(approved),
        notes: notes ? String(notes).trim() : undefined,
    });

    res.json({ success: true, approved: Boolean(approved) });
});

// 5. Behavioral Rules (arXiv:2607.13091)
app.get("/api/rules", (req: Request, res: Response) => {
    const owner = req.query.owner as string | undefined;
    const repo = req.query.repo as string | undefined;
    const formatted = memory.getFormattedRules(owner, repo);
    res.json({ formatted });
});

app.post("/api/rules", (req: Request, res: Response) => {
    const { rule, scope } = req.body;
    if (!rule || typeof rule !== "string") {
        return res.status(400).json({ error: "Missing rule string." });
    }
    memory.addRule(rule, scope || "global", "ui_manual");
    res.json({ success: true, message: "Rule stored in behavioral memory." });
});

app.listen(PORT, () => {
    console.log(`\n🚀 AutoHarness Control Center live at http://localhost:${PORT}`);
    console.log(`   Interactive Web Dashboard: http://localhost:${PORT}`);
});
