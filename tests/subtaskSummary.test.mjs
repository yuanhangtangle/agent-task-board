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

const {
  getAdjacentSubtaskIndex,
  getCurrentSubtaskSummary,
  getSubtaskIndexAfterToggle
} = module.exports;

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

test("current subtask summary can browse a preferred previous or next subtask", () => {
  const subtasks = [
    { text: "整理验收材料", completed: true },
    { text: "提交归档", completed: false },
    { text: "同步结论", completed: false }
  ];

  assert.equal(getCurrentSubtaskSummary(subtasks, 0)?.text, "整理验收材料");
  assert.equal(getCurrentSubtaskSummary(subtasks, 2)?.text, "同步结论");
  assert.equal(getCurrentSubtaskSummary(subtasks, 99)?.index, 2);
  assert.equal(getCurrentSubtaskSummary(subtasks, -1)?.index, 0);
});

test("adjacent subtask browsing stops at the first and last item", () => {
  assert.equal(getAdjacentSubtaskIndex(1, -1, 3), 0);
  assert.equal(getAdjacentSubtaskIndex(1, 1, 3), 2);
  assert.equal(getAdjacentSubtaskIndex(0, -1, 3), 0);
  assert.equal(getAdjacentSubtaskIndex(2, 1, 3), 2);
  assert.equal(getAdjacentSubtaskIndex(0, 1, 0), -1);
});

test("checking a subtask advances to the next item without moving past the end", () => {
  assert.equal(getSubtaskIndexAfterToggle(0, true, 3), 1);
  assert.equal(getSubtaskIndexAfterToggle(1, true, 3), 2);
  assert.equal(getSubtaskIndexAfterToggle(2, true, 3), 2);
});

test("unchecking a subtask keeps the current item selected", () => {
  assert.equal(getSubtaskIndexAfterToggle(1, false, 3), 1);
});

test("current subtask summary is null when a task has no subtasks", () => {
  assert.equal(getCurrentSubtaskSummary([]), null);
});
