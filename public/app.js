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
                if (evt.stage === "DRAFTING" && evt.data) {
                    if (evt.data.issueDraft) {
                        const issueTitleEl = document.getElementById("issue-draft-title");
                        const issueBodyEl = document.getElementById("issue-draft-body");
                        if (issueTitleEl) issueTitleEl.textContent = evt.data.issueDraft.title;
                        if (issueBodyEl) issueBodyEl.textContent = evt.data.issueDraft.body;
                    }
                    if (evt.data.draft) {
                        const prTitleEl = document.getElementById("pr-draft-title");
                        const prBodyEl = document.getElementById("pr-draft-body");
                        if (prTitleEl) prTitleEl.textContent = evt.data.draft.title;
                        if (prBodyEl) prBodyEl.textContent = evt.data.draft.body;
                    }
                }
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
                gateTitle.textContent = evt.data.draft?.title || "Pull Request Ready for Review";
                gateSummary.textContent = evt.data.issueDraft 
                    ? `Phase 1: Will create Issue "${evt.data.issueDraft.title}"\nPhase 2: Will open Pull Request linking to that issue.`
                    : (evt.data.draft?.body || "Review diff and authorize submission.");

                if (evt.data.issueDraft) {
                    const issueTitleEl = document.getElementById("issue-draft-title");
                    const issueBodyEl = document.getElementById("issue-draft-body");
                    if (issueTitleEl) issueTitleEl.textContent = evt.data.issueDraft.title;
                    if (issueBodyEl) issueBodyEl.textContent = evt.data.issueDraft.body;
                }
                if (evt.data.draft) {
                    const prTitleEl = document.getElementById("pr-draft-title");
                    const prBodyEl = document.getElementById("pr-draft-body");
                    if (prTitleEl) prTitleEl.textContent = evt.data.draft.title;
                    if (prBodyEl) prBodyEl.textContent = evt.data.draft.body;
                }

                const claWarningBox = document.getElementById("gate-cla-warning");
                const claText = document.getElementById("gate-cla-text");
                const claLink = document.getElementById("gate-cla-link");
                if (evt.data.claNotice && evt.data.claNotice.required) {
                    if (claWarningBox) claWarningBox.classList.remove("hidden");
                    if (claText) claText.textContent = evt.data.claNotice.message;
                    if (claLink) {
                        if (evt.data.claNotice.url) {
                            claLink.href = evt.data.claNotice.url;
                            claLink.style.display = "inline-block";
                        } else {
                            claLink.style.display = "none";
                        }
                    }
                    appendLog(`[${time}] ⚠️ CLA Warning: Repository requires a signed Contributor License Agreement`, "err");
                } else {
                    if (claWarningBox) claWarningBox.classList.add("hidden");
                }

                btnGateApprove.textContent = evt.data.issueDraft 
                    ? "✓ Approve Two-Phase Submission (Issue + PR)"
                    : "✓ Approve & Submit PR";

                gateBanner.classList.remove("hidden");
                appendLog(`[${time}] 🛑 Paused at Human Review Gate (Proposal vaulted)`, "proof");
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
        const claWarningBox = document.getElementById("gate-cla-warning");
        const claCheckbox = document.getElementById("gate-cla-checkbox");
        if (claWarningBox && !claWarningBox.classList.contains("hidden")) {
            if (claCheckbox && !claCheckbox.checked) {
                const confirmed = confirm(
                    "⚠️ Contributor License Agreement (CLA) Reminder\n\n" +
                    "This repository requires contributors to sign a CLA before pull requests can be accepted.\n\n" +
                    "Have you filled out and signed the CLA for this repository?\n\n" +
                    "Click OK if you have signed it (or wish to proceed now), or Cancel to go back and open the CLA link."
                );
                if (!confirmed) {
                    return;
                }
            }
        }

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
            if (claCheckbox) claCheckbox.checked = false;
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

    // Vault Modal Handlers (OS ~/.autoharness)
    const btnOpenVault = document.getElementById("btn-open-vault");
    const vaultModal = document.getElementById("vault-modal");
    const btnCloseVault = document.getElementById("btn-close-vault");
    const vaultContainer = document.getElementById("vault-proposals-container");

    async function loadVaultProposals() {
        const repo = repoInput.value.trim();
        if (!repo || !repo.includes("/")) {
            vaultContainer.innerHTML = `<p class="dim-text">Please enter a valid repository (owner/repo) first.</p>`;
            return;
        }
        vaultContainer.innerHTML = `<p class="dim-text">Loading archived proposals for ${repo} from OS vault (~/.autoharness)...</p>`;
        try {
            const res = await fetch(`/api/proposals?repo=${encodeURIComponent(repo)}`);
            const data = await res.json();
            const proposals = data.proposals || [];
            if (proposals.length === 0) {
                vaultContainer.innerHTML = `<div class="empty-state">No proposals archived yet for ${repo}.</div>`;
                return;
            }

            vaultContainer.innerHTML = proposals.map(p => `
                <div class="proposal-card" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 14px; margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-weight: 600; font-size: 13px; color: ${p.status === 'APPROVED' ? '#7ee787' : p.status === 'REJECTED' ? '#f85149' : '#e3b341'};">
                            ${p.status === 'APPROVED' ? '✓ APPROVED' : p.status === 'REJECTED' ? '✕ REJECTED' : '⏳ PENDING'}
                        </span>
                        <span style="font-size: 11px; color: rgba(255,255,255,0.4);">${new Date(p.timestamp).toLocaleString()}</span>
                    </div>
                    <h4 style="margin: 0 0 6px 0; color: #f0f6fc; font-size: 14px;">${p.prDraft?.title || p.huntedBug?.title || 'Untitled Proposal'}</h4>
                    ${p.issueDraft ? `<div style="font-size: 12px; color: #58a6ff; margin-bottom: 6px;">📝 Issue: ${p.issueDraft.title} ${p.issueDraft.issueNumber ? `(#${p.issueDraft.issueNumber})` : ''}</div>` : ''}
                    ${p.rejectionNotes ? `<div style="font-size: 12px; color: #f85149; margin-bottom: 6px;">💬 Rejection Note: ${p.rejectionNotes}</div>` : ''}
                    ${p.codeFix ? `<div style="font-size: 12px; color: rgba(255,255,255,0.6); margin-bottom: 8px;">Files: ${p.codeFix.modifiedFiles.join(', ')}</div>` : ''}
                    <div style="display: flex; gap: 8px; margin-top: 10px;">
                        <button class="btn-mini btn-view-diff" data-id="${p.id}" style="padding: 4px 10px; font-size: 11px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #f0f6fc; cursor: pointer;">View Diff</button>
                        ${p.prDraft?.prUrl ? `<a href="${p.prDraft.prUrl}" target="_blank" style="padding: 4px 10px; font-size: 11px; text-decoration: none; color: #58a6ff; border: 1px solid rgba(88,166,255,0.3); border-radius: 4px; display: inline-block;">View PR ↗</a>` : ''}
                        ${p.issueDraft?.issueUrl ? `<a href="${p.issueDraft.issueUrl}" target="_blank" style="padding: 4px 10px; font-size: 11px; text-decoration: none; color: #e3b341; border: 1px solid rgba(227,179,65,0.3); border-radius: 4px; display: inline-block;">View Issue ↗</a>` : ''}
                    </div>
                </div>
            `).join("");

            vaultContainer.querySelectorAll(".btn-view-diff").forEach(btn => {
                btn.addEventListener("click", async () => {
                    const id = btn.getAttribute("data-id");
                    const [owner, name] = repo.split("/");
                    const res = await fetch(`/api/proposals/${owner}/${name}/${id}`);
                    const detail = await res.json();
                    if (detail.diff) {
                        diffOutput.textContent = detail.diff;
                        diffFileCount.textContent = `Archived Patch: ${detail.record?.prDraft?.title || id}`;
                        document.querySelector('[data-tab="tab-diff"]')?.click();
                        vaultModal.classList.add("hidden");
                    }
                });
            });
        } catch (e) {
            vaultContainer.innerHTML = `<p class="dim-text" style="color: #f85149;">Failed to load vault proposals: ${e.message}</p>`;
        }
    }

    if (btnOpenVault) {
        btnOpenVault.addEventListener("click", () => {
            vaultModal.classList.remove("hidden");
            loadVaultProposals();
        });
    }

    if (btnCloseVault) {
        btnCloseVault.addEventListener("click", () => {
            vaultModal.classList.add("hidden");
        });
    }

    if (vaultModal) {
        vaultModal.addEventListener("click", (e) => {
            if (e.target === vaultModal) {
                vaultModal.classList.add("hidden");
            }
        });
    }

    // Initial Status Check & Connect
    async function checkInitialStatus() {
        try {
            const res = await fetch("/api/status");
            const data = await res.json();
            updateStatus(data.status);
            if (data.status === "AWAITING_APPROVAL" && data.latestGateData) {
                gateBanner.classList.remove("hidden");
                gateTitle.textContent = data.latestGateData.draft?.title || "PR Ready for Review";
                gateSummary.textContent = data.latestGateData.issueDraft 
                    ? `Phase 1: Will create Issue "${data.latestGateData.issueDraft.title}"\nPhase 2: Will open Pull Request linking to that issue.`
                    : (data.latestGateData.draft?.body || "");

                if (data.latestGateData.issueDraft) {
                    const issueTitleEl = document.getElementById("issue-draft-title");
                    const issueBodyEl = document.getElementById("issue-draft-body");
                    if (issueTitleEl) issueTitleEl.textContent = data.latestGateData.issueDraft.title;
                    if (issueBodyEl) issueBodyEl.textContent = data.latestGateData.issueDraft.body;
                }
                if (data.latestGateData.draft) {
                    const prTitleEl = document.getElementById("pr-draft-title");
                    const prBodyEl = document.getElementById("pr-draft-body");
                    if (prTitleEl) prTitleEl.textContent = data.latestGateData.draft.title;
                    if (prBodyEl) prBodyEl.textContent = data.latestGateData.draft.body;
                }

                const claWarningBox = document.getElementById("gate-cla-warning");
                const claText = document.getElementById("gate-cla-text");
                const claLink = document.getElementById("gate-cla-link");
                if (data.latestGateData.claNotice && data.latestGateData.claNotice.required) {
                    if (claWarningBox) claWarningBox.classList.remove("hidden");
                    if (claText) claText.textContent = data.latestGateData.claNotice.message;
                    if (claLink) {
                        if (data.latestGateData.claNotice.url) {
                            claLink.href = data.latestGateData.claNotice.url;
                            claLink.style.display = "inline-block";
                        } else {
                            claLink.style.display = "none";
                        }
                    }
                } else {
                    if (claWarningBox) claWarningBox.classList.add("hidden");
                }
            }
        } catch (e) {}
    }

    checkInitialStatus();
    connectSSE();
});

