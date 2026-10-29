import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
    discoverPythonPackageRoots,
    normalizeCommandWithVenv,
    primaryPackageName,
    pythonScriptCommand,
    resolveRepoEnv,
} from "../src/utils/env.ts";

function write(file: string, contents: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
}

function prefectLayout(root: string) {
    write(path.join(root, "src/prefect/__init__.py"), [
        "from functools import partial",
        "from prefect.types import MARKER",
        "VALUE = partial(lambda: MARKER)",
        "",
    ].join("\n"));
    write(path.join(root, "src/prefect/types/__init__.py"), [
        "from types import SimpleNamespace",
        "MARKER = SimpleNamespace(name='ok')",
        "",
    ].join("\n"));
    write(path.join(root, "src/integrations/prefect-aws/prefect_aws/__init__.py"), "NAME = 'aws'\n");
    write(path.join(root, "src/integrations/prefect-aws/prefect_aws/s3.py"), "def get_s3_client(client_parameters=None):\n    return client_parameters\n");
    // A probe living next to a module named `types` must not shadow the stdlib.
    write(path.join(root, "tests/types.py"), "raise RuntimeError('tests/types.py shadowed the stdlib')\n");
    write(path.join(root, "tests/check_stdlib.py"), [
        "import types, functools",
        "assert 'prefect' not in (types.__file__ or '')",
        "assert types.__file__.endswith('types.py')",
        "assert hasattr(functools, 'partial')",
        "print('stdlib-ok')",
        "",
    ].join("\n"));
}

test("package roots do not include the package interior", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoharness-prefect-"));
    prefectLayout(root);
    const roots = discoverPythonPackageRoots(root);
    const ends = roots.map((entry) => path.relative(root, entry));

    assert.deepEqual(ends.sort(), ["src", path.join("src", "integrations", "prefect-aws")].sort());
    assert.equal(primaryPackageName(root, "prefect"), "prefect");

    const pythonPath = resolveRepoEnv(root).env.PYTHONPATH || "";
    for (const entry of pythonPath.split(path.delimiter)) {
        assert.ok(!entry.endsWith(`${path.sep}prefect`), entry);
        assert.ok(!entry.endsWith(`${path.sep}types`), entry);
        assert.ok(!entry.endsWith(`${path.sep}prefect_aws`), entry);
    }
});

test("src-layout import does not shadow stdlib types or functools", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoharness-prefect-"));
    prefectLayout(root);
    const env = resolveRepoEnv(root).env;

    const shadowed = path.join(root, "src", "prefect");
    assert.throws(() => {
        execFileSync("python3", ["-c", "import prefect"], {
            cwd: root,
            env: { ...process.env, PYTHONPATH: `${shadowed}${path.delimiter}${path.join(root, "src")}` },
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    });

    const out = execFileSync("python3", ["-P", "-c", "import prefect, prefect_aws, types, functools; assert prefect.VALUE().name == 'ok'"], {
        cwd: root,
        env,
        encoding: "utf-8",
    });
    assert.equal(out, "");

    const script = execFileSync("python3", ["tests/check_stdlib.py"], {
        cwd: root,
        env,
        encoding: "utf-8",
    });
    assert.match(script, /stdlib-ok/);
});

test("python commands run with an isolated script path", () => {
    assert.equal(
        normalizeCommandWithVenv("python tests/test_hunted_probe.py", "/opt/venv/bin/python"),
        '"/opt/venv/bin/python" -P tests/test_hunted_probe.py'
    );
    assert.equal(
        normalizeCommandWithVenv("python3 -P -m pytest tests/test_hunted_probe.py", "/opt/venv/bin/python"),
        '"/opt/venv/bin/python" -P -m pytest tests/test_hunted_probe.py'
    );
    assert.equal(
        pythonScriptCommand("tests/test_hunted_probe.py", "/opt/venv/bin/python"),
        '"/opt/venv/bin/python" -P tests/test_hunted_probe.py'
    );
    assert.equal(normalizeCommandWithVenv("npm test", "/opt/venv/bin/python"), "npm test");
});
