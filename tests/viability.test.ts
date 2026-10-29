import assert from "node:assert/strict";
import test from "node:test";
import { parseViabilityDecision } from "../src/orchestrator/interview.ts";
import { openBugIssueQuery, preferLabeledIssues } from "../src/utils/github.ts";

test("viability decision uses the final DECISION line", () => {
    const mixed = [
        "This is not an existing patch, so a naive reading would DECISION: DROP.",
        "REASON: The report names the lease renewal crash and the functions involved.",
        "DECISION: KEEP",
    ].join("\n");
    const kept = parseViabilityDecision(mixed);
    assert.equal(kept.keep, true);
    assert.match(kept.reason, /lease renewal/);

    const dropped = parseViabilityDecision("REASON: This is a feature request.\nDECISION: DROP");
    assert.equal(dropped.keep, false);
    assert.match(dropped.reason, /feature request/);

    const missing = parseViabilityDecision("I think we should look at this later.");
    assert.equal(missing.keep, false);
    assert.match(missing.reason, /No DECISION line/);
});

test("bug issues are searched ahead of unlabeled chatter", () => {
    assert.match(openBugIssueQuery("PrefectHQ", "prefect", true), /label:bug/);
    assert.doesNotMatch(openBugIssueQuery("PrefectHQ", "prefect", false), /label:bug/);
    assert.match(openBugIssueQuery("PrefectHQ", "prefect", true), /-label:question/);

    const chosen = preferLabeledIssues(
        [{ number: 23658, title: "lease crash" }],
        [
            { number: 23658, title: "lease crash" },
            { number: 1, title: "question", pull_request: { url: "x" } },
            { number: 2, title: "other bug" },
        ],
        5
    );
    assert.deepEqual(chosen.map((item) => item.number), [23658, 2]);
});
