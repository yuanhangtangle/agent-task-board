import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, "../taskViewState.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020
  }
}).outputText;

const module = { exports: {} };
const load = new Function("module", "exports", compiled);
load(module, module.exports);

const { getTaskViewStateKey } = module.exports;

test("task view state key is stable when prepending tasks changes line numbers", () => {
  assert.equal(
    getTaskViewStateKey("Tasks/Inbox.md", "Tasks/Inbox.md:3:abc123"),
    getTaskViewStateKey("Tasks/Inbox.md", "Tasks/Inbox.md:11:abc123")
  );
});

test("task view state key still distinguishes tasks and source files", () => {
  assert.notEqual(
    getTaskViewStateKey("Tasks/Inbox.md", "Tasks/Inbox.md:3:abc123"),
    getTaskViewStateKey("Tasks/Inbox.md", "Tasks/Inbox.md:3:def456")
  );
  assert.notEqual(
    getTaskViewStateKey("Tasks/Inbox.md", "Tasks/Inbox.md:3:abc123"),
    getTaskViewStateKey("Projects/Plan.md", "Projects/Plan.md:3:abc123")
  );
});
