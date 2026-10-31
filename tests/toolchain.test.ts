import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
    buildProbeCommand,
    commandTimeoutMs,
    detectProject,
    goProbeFile,
    huntExtensions,
    assessProbeFailure,
    isEnvironmentalProbeFailure,
    isJsonResponseError,
    isPythonSetupFailure,
    rustPackage,
} from "../src/utils/toolchain.ts";
import { changesOnDisk, selectHuntScope } from "../src/utils/hunt-scope.ts";

function write(file: string, contents: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
}

function run(command: string, cwd: string): { ok: boolean; output: string } {
        try {
            const output = execSync(command, {
                cwd,
                encoding: "utf-8",
                timeout: commandTimeoutMs(command, 30_000),
                env: { ...process.env, CARGO_TERM_COLOR: "never" },
                stdio: ["ignore", "pipe", "pipe"],
            });
        return { ok: true, output };
    } catch (err: any) {
        return {
            ok: false,
            output: [err.stdout, err.stderr, err.message].filter(Boolean).join("\n"),
        };
    }
}

test("language detection follows the source files, not a side package.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-lang-"));
    write(path.join(root, "src/app.py"), "def run():\n    return 1\n");
    write(path.join(root, "src/other.py"), "VALUE = 1\n");
    write(path.join(root, "ui/App.tsx"), "export const App = () => null\n");
    write(path.join(root, "package.json"), '{ "scripts": { "test": "vitest" } }\n');
    assert.equal(detectProject(root).language, "python");

    const tsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ts-"));
    write(path.join(tsRoot, "src/index.ts"), "export const n: number = 1\n");
    write(path.join(tsRoot, "package.json"), '{ "type": "module" }\n');
    assert.equal(detectProject(tsRoot).language, "typescript");
    assert.deepEqual(huntExtensions("typescript"), [".ts", ".tsx", ".mts", ".cts"]);

    const jsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ah-js-"));
    write(path.join(jsRoot, "index.js"), "module.exports = 1\n");
    assert.equal(detectProject(jsRoot).language, "other");

    const goRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ah-go-"));
    write(path.join(goRoot, "main.go"), "package main\nfunc main() {}\n");
    assert.equal(detectProject(goRoot).language, "go");
    assert.equal(goProbeFile("pkg/add.go"), "pkg/hunted_probe_test.go");

    const rustRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ah-rs-"));
    write(path.join(rustRoot, "Cargo.toml"), '[workspace]\nmembers = ["crates/demo"]\n');
    write(path.join(rustRoot, "crates/demo/Cargo.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
    write(path.join(rustRoot, "crates/demo/src/lib.rs"), "pub fn first(items: &[i32]) -> i32 { items[0] }\n");
    const crate = rustPackage(rustRoot, "crates/demo/src/lib.rs");
    assert.equal(crate?.name, "demo");
    assert.equal(crate?.probeFile, "crates/demo/tests/hunted_probe.rs");
    assert.match(crate?.command || "", /--manifest-path crates\/demo\/Cargo.toml/);
    assert.match(crate?.command || "", /--test hunted_probe/);
});

test("a probe that only reports a missing import is not a Python bug", () => {
    const trace = [
        "Could not import prefect_aws.s3.get_s3_client. Ensure prefect-aws is installed and on PYTHONPATH.",
        "Command failed: python -P probe_get_s3_client_nil_credentials.py",
        "Could not import prefect_aws.s3.get_s3_client. Ensure prefect-aws is installed and on PYTHONPATH.",
    ].join("\n");
    assert.equal(isPythonSetupFailure(trace), true);
    assert.equal(isEnvironmentalProbeFailure("python", trace, "probe_get_s3_client_nil_credentials.py"), true);

    const bug = [
        "Traceback (most recent call last):",
        "  File \"probe.py\", line 4, in <module>",
        "    get_s3_client()",
        "pydantic_core._pydantic_core.ValidationError: 1 validation error",
    ].join("\n");
    assert.equal(isPythonSetupFailure(bug), false);
    assert.equal(isJsonResponseError("Bad escaped character in JSON at position 3848 (line 6 column 2681)"), true);
});

test("typescript probe throws on the bug and a bad import is environmental", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ts-probe-"));
    write(path.join(root, "package.json"), '{ "type": "module" }\n');
    write(path.join(root, "src/add.ts"), [
        "export function add(a: number, b: number): number {",
        "  return a.toFixed(0) as unknown as number",
        "}",
        "",
    ].join("\n"));
    write(path.join(root, "src/math.ts"), [
        'import { add } from "./add"',
        "export function double(n: number): number { return add(n, n) }",
        "",
    ].join("\n"));
    write(path.join(root, "src/hunted_probe.test.ts"), [
        'import { double } from "./math"',
        "double(null as unknown as number)",
        "",
    ].join("\n"));

    const command = buildProbeCommand("typescript", root, "src/math.ts");
    assert.ok(command?.includes("src/hunted_probe.test.ts"));
    const failed = run(command!, root);
    assert.equal(failed.ok, false);
    assert.match(failed.output, /TypeError/);
    assert.equal(isEnvironmentalProbeFailure("typescript", failed.output, "src/hunted_probe.test.ts"), false);

    write(path.join(root, "src/hunted_probe.test.ts"), 'import { missing } from "./nope"\nconsole.log(missing)\n');
    const missing = run(command!, root);
    assert.equal(missing.ok, false);
    assert.equal(isEnvironmentalProbeFailure("typescript", missing.output, "src/hunted_probe.test.ts"), true);
});

test("go probe panic is a bug and a missing name is environmental", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-go-probe-"));
    write(path.join(root, "go.mod"), "module example.com/demo\n\ngo 1.22\n");
    write(path.join(root, "pkg/add.go"), [
        "package pkg",
        "func Add(a, b int) int {",
        '  if a < 0 { panic("negative") }',
        "  return a + b",
        "}",
        "",
    ].join("\n"));
    write(path.join(root, "pkg/hunted_probe_test.go"), [
        "package pkg",
        'import "testing"',
        "func TestHuntedProbe(t *testing.T) { Add(-1, 1) }",
        "",
    ].join("\n"));

    const command = buildProbeCommand("go", root, "pkg/add.go");
    assert.match(command || "", /go test/);
    const failed = run(command!, root);
    assert.equal(failed.ok, false);
    assert.match(failed.output, /negative/);
    assert.equal(isEnvironmentalProbeFailure("go", failed.output, "pkg/hunted_probe_test.go"), false);

    write(path.join(root, "pkg/hunted_probe_test.go"), [
        "package pkg",
        'import "testing"',
        "func TestHuntedProbe(t *testing.T) { DoesNotExist() }",
        "",
    ].join("\n"));
    const broken = run(command!, root);
    assert.equal(broken.ok, false);
    assert.equal(isEnvironmentalProbeFailure("go", broken.output, "pkg/hunted_probe_test.go"), true);
});

test("rust probe panic is a bug and a missing item is environmental", { timeout: 180_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-rs-probe-"));
    write(path.join(root, "Cargo.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
    write(path.join(root, "src/lib.rs"), "pub fn first(items: &[i32]) -> i32 { items[0] }\n");
    write(path.join(root, "tests/hunted_probe.rs"), [
        "use demo::first;",
        "#[test]",
        "fn hunted_probe() { let _ = first(&[]); }",
        "",
    ].join("\n"));

    const command = buildProbeCommand("rust", root, "src/lib.rs");
    assert.match(command || "", /^cargo test /);
    const failed = run(command!, root);
    assert.equal(failed.ok, false);
    assert.match(failed.output, /panicked at/);
    assert.equal(isEnvironmentalProbeFailure("rust", failed.output, "tests/hunted_probe.rs"), false);

    write(path.join(root, "tests/hunted_probe.rs"), [
        "use demo::missing;",
        "#[test]",
        "fn hunted_probe() { missing(); }",
        "",
    ].join("\n"));
    const broken = run(command!, root);
    assert.equal(broken.ok, false);
    assert.equal(isEnvironmentalProbeFailure("rust", broken.output, "tests/hunted_probe.rs"), true);
});

const mockPrefectTrace = [
    "Traceback (most recent call last):",
    "  File \"/workspace/prefect/probe_artifacts_aformat_missing.py\", line 18, in main",
    "    await Artifact.acreate(key=\"test\", description=\"test\", client=client)",
    "  File \"/workspace/prefect/src/prefect/artifacts.py\", line 62, in acreate",
    "    async with get_client(sync_client=False, client=client) as client:",
    "  File \"/workspace/prefect/src/prefect/client/orchestration/__init__.py\", line 199, in __init__",
    "    async with client:",
    "TypeError: 'MockPrefectClient' object does not support the asynchronous context manager protocol",
].join("\n");

test("a crash of a client the probe invented is not a library bug", () => {
    const probe = [
        "class MockPrefectClient:",
        "    pass",
        "client = MockPrefectClient()",
        "await Artifact.acreate(client=client)",
        "",
    ].join("\n");
    const verdict = assessProbeFailure({
        trace: mockPrefectTrace,
        probeSource: probe,
        targetFile: "src/prefect/artifacts.py",
    });
    assert.equal(verdict.accept, false);
    assert.match(verdict.reason, /MockPrefectClient|stand-in/);
});

test("a crash inside the target file on a real call is a bug", () => {
    const trace = [
        "Traceback (most recent call last):",
        "  File \"probe_empty.py\", line 3, in <module>",
        "    first([])",
        "  File \"/workspace/demo/src/demo/lists.py\", line 4, in first",
        "    return items[0]",
        "IndexError: list index out of range",
    ].join("\n");
    const verdict = assessProbeFailure({
        trace,
        probeSource: "from demo.lists import first\nfirst([])\n",
        targetFile: "src/demo/lists.py",
    });
    assert.equal(verdict.accept, true);
    assert.equal(verdict.exceptionType, "IndexError");
});

test("a crash that never reaches the target file is not a bug", () => {
    const trace = [
        "Traceback (most recent call last):",
        "  File \"probe.py\", line 2, in <module>",
        "    helper()",
        "  File \"probe.py\", line 1, in helper",
        "    raise TypeError('probe bug')",
        "TypeError: probe bug",
    ].join("\n");
    const verdict = assessProbeFailure({
        trace,
        probeSource: "def helper():\n    raise TypeError('probe bug')\nhelper()\n",
        targetFile: "src/demo/lists.py",
    });
    assert.equal(verdict.accept, false);
    assert.match(verdict.reason, /never entered/);
});

test("a named stand-in is rejected even without the word Mock", () => {
    const trace = [
        "Traceback (most recent call last):",
        "  File \"/workspace/demo/src/demo/client.py\", line 8, in open",
        "    async with client:",
        "TypeError: 'HandmadeClient' object does not support the asynchronous context manager protocol",
    ].join("\n");
    const verdict = assessProbeFailure({
        trace,
        probeSource: "class HandmadeClient:\n    pass\nopen(HandmadeClient())\n",
        targetFile: "src/demo/client.py",
    });
    assert.equal(verdict.accept, false);
    assert.match(verdict.reason, /HandmadeClient/);
});

test("a 401 from Prefect Cloud is not a bug, even when the traceback touches the target file", () => {
    const trace = [
        "Traceback (most recent call last):",
        "  File \"/Users/deepshah/Downloads/PRs/prefect/src/prefect/cli/cloud/webhook.py\", line 53, in webhook_ls",
        "    retrieved_webhooks = await client.request(\"POST\", \"/webhooks/filter\")",
        "  File \"/Users/deepshah/Downloads/PRs/prefect/src/prefect/client/cloud.py\", line 229, in request",
        "    raise CloudUnauthorizedError(str(exc)) from exc",
        "prefect.client.cloud.CloudUnauthorizedError: Client error '401 Unauthorized' for url 'https://api.prefect.cloud/api/webhooks/filter' - Response: {'detail': 'Invalid authentication credentials'}",
    ].join("\n");
    const verdict = assessProbeFailure({
        trace,
        probeSource: "from prefect.cli.cloud.webhook import webhook_ls\nwebhook_ls()\n",
        targetFile: "src/prefect/cli/cloud/webhook.py",
        claimedText: "cli: Webhook commands crash with AttributeError on non-string output format",
    });
    assert.equal(verdict.accept, false);
    assert.match(verdict.reason, /remote service|401|CloudUnauthorizedError/);
});

test("a local crash is rejected when it is a different exception than the hypothesis", () => {
    const trace = [
        "Traceback (most recent call last):",
        "  File \"/workspace/demo/src/demo/lists.py\", line 4, in first",
        "    return items[0]",
        "IndexError: list index out of range",
    ].join("\n");
    const verdict = assessProbeFailure({
        trace,
        probeSource: "from demo.lists import first\nfirst([])\n",
        targetFile: "src/demo/lists.py",
        claimedText: "first() raises AttributeError when items is empty",
    });
    assert.equal(verdict.accept, false);
    assert.match(verdict.reason, /AttributeError/);
    assert.match(verdict.reason, /IndexError/);
});

test("a wrong result asserted against the library is a bug", () => {
    const trace = [
        "AssertionError: assert [] == [{'n': 1}]",
        "E       assert [] == [{'n': 1}]",
    ].join("\n");
    const probe = [
        "from realtime._async.client import AsyncRealtimeClient",
        "socket = AsyncRealtimeClient()",
        "first = socket.channel('room')",
        "socket.channel('room')",
        "assert received == [{'n': 1}]",
        "",
    ].join("\n");
    const verdict = assessProbeFailure({
        trace,
        probeSource: probe,
        targetFile: "src/realtime/_async/client.py",
        claimedText: "TypeError when channel() is called twice",
    });
    assert.equal(verdict.accept, true);
});

test("a constant assertion is not a bug", () => {
    const verdict = assessProbeFailure({
        trace: "AssertionError: assert 1 == 2",
        probeSource: "assert 1 == 2\n",
        targetFile: "src/client.py",
    });
    assert.equal(verdict.accept, false);
    assert.match(verdict.reason, /does not call the library/);
});

test("a monorepo hunt stays inside the package recent commits changed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-scope-"));
    execSync("git init -q", { cwd: root });
    execSync("git config user.email t@example.com", { cwd: root });
    execSync("git config user.name t", { cwd: root });
    write(path.join(root, "package.json"), '{ "private": true }\n');
    write(path.join(root, "packages/react/package.json"), '{ "name": "@example/react" }\n');
    write(path.join(root, "packages/react/src/Feature.tsx"), "export const Feature = () => null\n");
    write(path.join(root, "packages/node/package.json"), '{ "name": "@example/node" }\n');
    write(path.join(root, "packages/node/src/index.ts"), "export const n = 1\n");
    write(path.join(root, "apps/studio/package.json"), '{ "name": "studio" }\n');
    write(path.join(root, "apps/studio/lib/page.ts"), "export const page = 1\n");
    execSync("git add -A && git commit -q -m init", { cwd: root });

    const scoped = selectHuntScope(root, ["apps/studio/lib/page.ts"]);
    assert.equal(scoped.root, "apps/studio");
    assert.ok(scoped.files.some((file) => file.endsWith("apps/studio/lib/page.ts")));
    assert.equal(scoped.files.some((file) => file.includes("packages/react")), false);
    assert.match(scoped.reason, /Monorepo|Auditing apps\/studio/);

    const small = fs.mkdtempSync(path.join(os.tmpdir(), "ah-scope-small-"));
    execSync("git init -q", { cwd: small });
    execSync("git config user.email t@example.com", { cwd: small });
    execSync("git config user.name t", { cwd: small });
    write(path.join(small, "package.json"), '{ "name": "storage" }\n');
    write(path.join(small, "src/render.ts"), "export const render = 1\n");
    execSync("git add -A && git commit -q -m init", { cwd: small });
    const whole = selectHuntScope(small, ["src/render.ts"]);
    assert.equal(whole.root, ".");
    assert.ok(whole.files.includes("src/render.ts"));
});

test("a deleted scratch file is not part of the commit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-commit-"));
    execSync("git init -q", { cwd: root });
    execSync("git config user.email t@example.com", { cwd: root });
    execSync("git config user.name t", { cwd: root });
    write(path.join(root, "src/mutation.ts"), "export const n = 1\n");
    execSync("git add -A && git commit -q -m init", { cwd: root });
    write(path.join(root, "src/mutation.ts"), "export const n = 2\n");
    write(path.join(root, "temp_test_org_update.ts"), "throw new Error('scratch')\n");
    fs.unlinkSync(path.join(root, "temp_test_org_update.ts"));
    const files = changesOnDisk(root, ["src/mutation.ts", "temp_test_org_update.ts"]);
    assert.deepEqual(files, ["src/mutation.ts"]);
});

test("a panic inside the target file is a bug", () => {
    const verdict = assessProbeFailure({
        trace: "panic: negative\n\t/workspace/demo/pkg/add.go:3 +0x20",
        probeSource: "package pkg\nfunc TestHuntedProbe(t *testing.T) { Add(-1, 1) }\n",
        targetFile: "pkg/add.go",
    });
    assert.equal(verdict.accept, true);
    assert.equal(verdict.exceptionType, "panic");
});
