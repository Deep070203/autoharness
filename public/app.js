// AutoHarness Frontend Application Logic

document.addEventListener("DOMContentLoaded", () => {
    // DOM Elements
    const form = document.getElementById("pipeline-form");
    const repoInput = document.getElementById("repo-input");
    const issueInput = document.getElementById("issue-input");
    const similarPrInput = document.getElementById("similar-pr-input");
    const similarIssueInput = document.getElementById("similar-issue-input");
    const btnStart = document.getElementById("btn-start");
    const btnHunt = document.getElementById("btn-hunt");
    
    const statusPill = document.getElementById("status-pill");
    const statusText = document.getElementById("status-text");
    const elapsedTimeEl = document.getElementById("elapsed-time");
    const terminalBody = document.getElementById("terminal-body");
    const btnClearLogs = document.getElementById("btn-clear-logs");

    // Proof & Diff Elements
    const proofReproCmd = document.getElementById("proof-repro-cmd");
    const proofFailOutput = document.getElementById("proof-fail-output");
    const proofVerifySummary = document.getElementById("proof-verify-summary");
    const proofPassOutput = document.getElementById("proof-pass-output");
    const diffFileCount = document.getElementById("diff-file-count");
    const diffOutput = document.getElementById("diff-output");
    const locFilesList = document.getElementById("localization-files-list");
    const locSymbols = document.getElementById("localization-symbols");
    const locExplanation = document.getElementById("localization-explanation");

    // Gate Elements
    const gateBanner = document.getElementById("gate-banner");
    const gateTitle = document.getElementById("gate-pr-title");
    const gateSummary = document.getElementById("gate-pr-summary");
    const gateNotes = document.getElementById("gate-notes");
    const btnGateApprove = document.getElementById("btn-gate-approve");
    const btnGateReject = document.getElementById("btn-gate-reject");

    // Memory Modal Elements
    const btnOpenMemory = document.getElementById("btn-open-memory");
    const memoryModal = document.getElementById("memory-modal");
    const btnCloseMemory = document.getElementById("btn-close-memory");
    const rulesDisplay = document.getElementById("rules-display");
    const newRuleInput = document.getElementById("new-rule-input");
    const btnAddRule = document.getElementById("btn-add-rule");

    // Quick chips
    document.querySelectorAll(".chip").forEach((chip) => {
        chip.addEventListener("click", () => {
            repoInput.value = chip.getAttribute("data-repo");
        });
    });

    // Tab Switching
    const tabBtns = document.querySelectorAll(".tab-btn");
    const tabPanes = document.querySelectorAll(".tab-pane");

    tabBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
            tabBtns.forEach((b) => b.classList.remove("active"));
            tabPanes.forEach((p) => p.classList.remove("active"));
            btn.classList.add("active");
            const target = btn.getAttribute("data-tab");
            const targetPane = document.getElementById(target);
            if (targetPane) targetPane.classList.add("active");
        });
    });

    // Clear Logs
    btnClearLogs.addEventListener("click", () => {
        terminalBody.innerHTML = '<div class="log-line sys">[System] Logs cleared.</div>';
    });

    // Timer
    let timerInterval = null;
    let startTime = null;

    function startTimer() {
        if (timerInterval) clearInterval(timerInterval);
        startTime = Date.now();
        timerInterval = setInterval(() => {
            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            const mins = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
            const secs = String(elapsedSec % 60).padStart(2, "0");
            elapsedTimeEl.textContent = `Elapsed: ${mins}:${secs}`;
        }, 1000);
    }

    function stopTimer() {
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = null;
    }

    // Status Pill Handler
    function updateStatus(status) {
        statusPill.className = "status-pill";
        switch (status) {
            case "RUNNING":
                statusPill.classList.add("status-running");
                statusText.textContent = "AUTONOMOUS HEALING ACTIVE";
                btnStart.disabled = true;
                btnStart.style.opacity = "0.6";
                break;
            case "AWAITING_APPROVAL":
                statusPill.classList.add("status-awaiting");
                statusText.textContent = "AWAITING HUMAN APPROVAL";
                btnStart.disabled = true;
                break;
            case "COMPLETED":
                statusPill.classList.add("status-completed");
                statusText.textContent = "HEALING SHIPPED & MERGED";
                btnStart.disabled = false;
                btnStart.style.opacity = "1";
                stopTimer();
                break;
            case "FAILED":
                statusPill.classList.add("status-failed");
                statusText.textContent = "PIPELINE FAILED";
                btnStart.disabled = false;
                btnStart.style.opacity = "1";
                stopTimer();
                break;
            default:
                statusPill.classList.add("status-idle");
                statusText.textContent = "SYSTEM IDLE";
                btnStart.disabled = false;
                btnStart.style.opacity = "1";
                stopTimer();
        }
    }

    // Node Graph Manager
    const nodeIds = ["SCOUT", "INTERVIEW", "REPRODUCE", "LOCALIZE", "CODEFIX", "VERIFY", "GATE"];
    function setNodeStatus(stageName, state, statusText) {
        const mappedId = stageName === "HUNTER" ? "SCOUT" : stageName;
        const node = document.getElementById(`node-${mappedId}`);
        if (!node) return;

        node.classList.remove("active", "completed", "failed");
        if (state) node.classList.add(state);

        const statusEl = node.querySelector(".node-status");
        if (statusEl && statusText) {
            statusEl.textContent = statusText;
        }
    }

    function resetNodes() {
        nodeIds.forEach((id) => {
            const node = document.getElementById(`node-${id}`);
            if (node) {
                node.classList.remove("active", "completed", "failed");
                node.querySelector(".node-status").textContent = "Waiting";
            }
        });
    }

    // Append to Terminal Log
    function appendLog(lineText, type = "normal") {
        const line = document.createElement("div");
        line.className = `log-line ${type}`;
        line.textContent = lineText;
        terminalBody.appendChild(line);
        terminalBody.scrollTop = terminalBody.scrollHeight;
    }

    // Connect SSE Stream
    function connectSSE() {
        const sse = new EventSource("/api/events");

        sse.onmessage = (event) => {
            try {
                const evt = JSON.parse(event.data);
                handlePipelineEvent(evt);
            } catch (e) {
                console.error("Failed to parse SSE payload", e);
            }
        };

        sse.onerror = () => {
            // Reconnect after brief pause
            setTimeout(connectSSE, 3000);
        };
    }

    function handlePipelineEvent(evt) {
        const time = new Date(evt.timestamp).toLocaleTimeString();

        switch (evt.type) {
            case "stage:start":
                setNodeStatus(evt.stage, "active", "Running...");
                appendLog(`[${time}] 🚀 ${evt.stage} started`, "stage-start");
                updateStatus("RUNNING");
                break;

            case "stage:log":
                appendLog(`[${time}] [${evt.stage}] ${evt.data}`);
                break;

            case "stage:complete":
                setNodeStatus(evt.stage, "completed", "Complete ✓");
                appendLog(`[${time}] ✓ ${evt.stage} completed`, "pass");
                break;

            case "proof:established":
                proofReproCmd.textContent = `Command: ${evt.data.command}`;
                proofFailOutput.textContent = evt.data.failureTrace || "(Exited with non-zero status)";
                appendLog(`[${time}] 🧪 Breken Proof Established! Command: ${evt.data.command}`, "proof");
                break;

            case "localization:complete":
                if (evt.data.targetFiles && evt.data.targetFiles.length > 0) {
                    locFilesList.innerHTML = evt.data.targetFiles.map((f) => `<li>${f}</li>`).join("");
                }
                locSymbols.textContent = evt.data.likelyFunctions?.join(", ") || "N/A";
                locExplanation.textContent = evt.data.explanation || "Isolated via Agentless localization.";
                break;

            case "diff:ready":
                diffOutput.textContent = evt.data.diff || "(Empty diff)";
                diffFileCount.textContent = `${evt.data.modifiedFiles?.length || 0} files modified: ${evt.data.modifiedFiles?.join(", ")}`;
                break;

            case "verification:complete":
                proofVerifySummary.textContent = `Status: ${evt.data.passed ? "All Tests Passed ✓" : "Verification Failed ❌"}`;
                proofPassOutput.textContent = `Repro Output:\n${evt.data.reproOutput || "Passed cleanly"}\n\nRegression Suite:\n${evt.data.regressionOutput || "Passed"}`;
                appendLog(`[${time}] 🛡️ QA Verification: ${evt.data.summary}`, evt.data.passed ? "pass" : "err");
                break;

            case "gate:waiting":
                updateStatus("AWAITING_APPROVAL");
                setNodeStatus("GATE", "active", "Review Required");
                gateTitle.textContent = evt.data.draft?.title || "Pull Request Draft Ready";
                gateSummary.textContent = evt.data.draft?.body || "Review diff and authorize PR submission to GitHub.";
                gateBanner.classList.remove("hidden");
                appendLog(`[${time}] 🛑 Paused at Human Review Gate`, "proof");
                break;

            case "gate:resolved":
                gateBanner.classList.add("hidden");
                setNodeStatus("GATE", evt.data.approved ? "completed" : "failed", evt.data.approved ? "Approved ✓" : "Rejected");
                appendLog(`[${time}] Gate decision: ${evt.data.approved ? "APPROVED" : "REJECTED"}`, evt.data.approved ? "pass" : "err");
                break;

            case "pr:submitted":
                appendLog(`[${time}] 🎉 PR SUBMITTED: ${evt.data.prUrl}`, "pass");
                updateStatus("COMPLETED");
                alert(`🎉 Pull Request Successfully Opened!\n${evt.data.prUrl}`);
                break;

            case "pipeline:error":
                appendLog(`[${time}] ❌ ERROR: ${evt.data.message}`, "err");
                updateStatus("FAILED");
                break;

            case "pipeline:done":
                if (evt.data.success) {
                    updateStatus("COMPLETED");
                } else {
                    updateStatus("FAILED");
                }
                break;
        }
    }

    // Start Pipeline
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const repo = repoInput.value.trim();
        const issueNumber = issueInput.value.trim();
        const similarPrNumber = similarPrInput.value.trim();
        const similarIssueNumber = similarIssueInput.value.trim();

        if (!repo) {
            alert("Please enter a target repository.");
            return;
        }

        resetNodes();
        proofReproCmd.textContent = "Command: N/A";
        proofFailOutput.textContent = "Waiting for reproduction protocol...";
        proofVerifySummary.textContent = "Status: Pending Fix";
        proofPassOutput.textContent = "Waiting for fix...";
        diffOutput.textContent = "(No code diff generated yet)";
        diffFileCount.textContent = "0 files modified";
        gateBanner.classList.add("hidden");

        appendLog(`[System] Initializing pipeline run for ${repo}...`, "sys");
        startTimer();
        updateStatus("RUNNING");

        try {
            const res = await fetch("/api/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repo,
                    issueNumber: issueNumber ? parseInt(issueNumber, 10) : undefined,
                    similarPrNumber: similarPrNumber ? parseInt(similarPrNumber, 10) : undefined,
                    similarIssueNumber: similarIssueNumber ? parseInt(similarIssueNumber, 10) : undefined,
                }),
            });

            const data = await res.json();
            if (!res.ok) {
                alert(data.error || "Failed to start pipeline.");
                updateStatus("IDLE");
            }
        } catch (err) {
            alert("Network error: " + err.message);
            updateStatus("IDLE");
        }
    });

    if (btnHunt) {
        btnHunt.addEventListener("click", () => {
            issueInput.value = "";
            form.dispatchEvent(new Event("submit"));
        });
    }

    // Human Gate Handlers
    btnGateApprove.addEventListener("click", async () => {
        const notes = gateNotes.value.trim();
        btnGateApprove.disabled = true;
        btnGateReject.disabled = true;

        try {
            await fetch("/api/gate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ approved: true, notes }),
            });
            gateBanner.classList.add("hidden");
            gateNotes.value = "";
        } catch (e) {
            alert("Failed to submit gate approval: " + e.message);
        } finally {
            btnGateApprove.disabled = false;
            btnGateReject.disabled = false;
        }
    });

    btnGateReject.addEventListener("click", async () => {
        const notes = gateNotes.value.trim();
        if (!notes) {
            const confirmReject = confirm("Are you sure you want to reject without leaving feedback for the behavioral memory bank?");
            if (!confirmReject) return;
        }

        btnGateApprove.disabled = true;
        btnGateReject.disabled = true;

        try {
            await fetch("/api/gate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ approved: false, notes }),
            });
            gateBanner.classList.add("hidden");
            gateNotes.value = "";
        } catch (e) {
            alert("Failed to submit gate rejection: " + e.message);
        } finally {
            btnGateApprove.disabled = false;
            btnGateReject.disabled = false;
        }
    });

    // Memory Modal Handlers
    async function loadRules() {
        rulesDisplay.textContent = "Fetching active behavioral rules...";
        try {
            const res = await fetch("/api/rules");
            const data = await res.json();
            rulesDisplay.textContent = data.formatted || "No rules stored yet.";
        } catch (e) {
            rulesDisplay.textContent = "Failed to load rules.";
        }
    }

    btnOpenMemory.addEventListener("click", () => {
        memoryModal.classList.remove("hidden");
        loadRules();
    });

    btnCloseMemory.addEventListener("click", () => {
        memoryModal.classList.add("hidden");
    });

    memoryModal.addEventListener("click", (e) => {
        if (e.target === memoryModal) {
            memoryModal.classList.add("hidden");
        }
    });

    btnAddRule.addEventListener("click", async () => {
        const rule = newRuleInput.value.trim();
        if (!rule) return;

        try {
            const res = await fetch("/api/rules", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rule, scope: "global" }),
            });
            if (res.ok) {
                newRuleInput.value = "";
                loadRules();
            }
        } catch (e) {
            alert("Failed to add rule: " + e.message);
        }
    });

    // Initial Status Check & Connect
    async function checkInitialStatus() {
        try {
            const res = await fetch("/api/status");
            const data = await res.json();
            updateStatus(data.status);
            if (data.status === "AWAITING_APPROVAL" && data.latestGateData) {
                gateBanner.classList.remove("hidden");
                gateTitle.textContent = data.latestGateData.draft?.title || "PR Ready for Review";
                gateSummary.textContent = data.latestGateData.draft?.body || "";
            }
        } catch (e) {}
    }

    checkInitialStatus();
    connectSSE();
});
