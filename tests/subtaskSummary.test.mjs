import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, "../subtaskSummary.ts");
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

const { getCurrentSubtaskSummary } = module.exports;

test("current subtask summary chooses the first incomplete subtask", () => {
  const summary = getCurrentSubtaskSummary([
    { text: "8月底之前完成评审", completed: true },
    { text: "同步周浩相关情况", completed: true },
    { text: "测试大纲需要清华出具并盖章", completed: false },
    { text: "绩效报告需要加到~100页", completed: false }
  ]);

  assert.deepEqual(summary, {
    index: 2,
    text: "测试大纲需要清华出具并盖章",
    completed: false,
    completedCount: 2,
    totalCount: 4
  });
});

test("current subtask summary falls back to the last completed subtask when all are done", () => {
  const summary = getCurrentSubtaskSummary([
    { text: "整理验收材料", completed: true },
    { text: "提交归档", completed: true }
  ]);

  assert.deepEqual(summary, {
    index: 1,
    text: "提交归档",
    completed: true,
    completedCount: 2,
    totalCount: 2
  });
});

test("current subtask summary is null when a task has no subtasks", () => {
  assert.equal(getCurrentSubtaskSummary([]), null);
});
