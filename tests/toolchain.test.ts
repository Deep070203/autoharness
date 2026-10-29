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
    isEnvironmentalProbeFailure,
    rustPackage,
} from "../src/utils/toolchain.ts";

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
    write(path.join(root, "tests/test_hunted_probe.ts"), [
        'import { double } from "../src/math"',
        "double(null as unknown as number)",
        "",
    ].join("\n"));

    const command = buildProbeCommand("typescript", root, "src/math.ts");
    assert.ok(command?.includes("tests/test_hunted_probe.ts"));
    const failed = run(command!, root);
    assert.equal(failed.ok, false);
    assert.match(failed.output, /TypeError/);
    assert.equal(isEnvironmentalProbeFailure("typescript", failed.output, "tests/test_hunted_probe.ts"), false);

    write(path.join(root, "tests/test_hunted_probe.ts"), 'import { missing } from "../src/nope"\nconsole.log(missing)\n');
    const missing = run(command!, root);
    assert.equal(missing.ok, false);
    assert.equal(isEnvironmentalProbeFailure("typescript", missing.output, "tests/test_hunted_probe.ts"), true);
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
