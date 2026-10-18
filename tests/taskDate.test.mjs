import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, "../taskDate.ts");
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
  formatTaskDateKey,
  getBeijingDateKey,
  getDeadlineKey,
  getTaskDateTag,
  matchesTaskDateFilter
} = module.exports;

test("getTaskDateTag finds the first valid #YYYYMMDD tag value", () => {
  assert.equal(getTaskDateTag(["foreground", "20260730", "important"]), "20260730");
  assert.equal(getTaskDateTag(["20260230", "20260228"]), "20260228");
  assert.equal(getTaskDateTag(["20240229"]), "20240229");
  assert.equal(getTaskDateTag(["20230229"]), undefined);
  assert.equal(getTaskDateTag(["20261301", "today"]), undefined);
});

test("getBeijingDateKey uses Asia/Shanghai even across UTC date boundaries", () => {
  assert.equal(getBeijingDateKey(new Date("2026-07-29T16:30:00.000Z")), "20260730");
  assert.equal(getBeijingDateKey(new Date("2026-07-29T15:59:59.000Z")), "20260729");
});

test("task date filters distinguish today, overdue, future, and undated tasks", () => {
  const today = "20260730";
  assert.equal(matchesTaskDateFilter("20260730", "today", today), true);
  assert.equal(matchesTaskDateFilter("20260729", "today", today), false);
  assert.equal(matchesTaskDateFilter("20260729", "overdue", today), true);
  assert.equal(matchesTaskDateFilter("20260731", "overdue", today), false);
  assert.equal(matchesTaskDateFilter(undefined, "overdue", today), false);
  assert.equal(matchesTaskDateFilter(undefined, "all", today), true);
});

test("formatTaskDateKey renders the storage tag as an ISO date", () => {
  assert.equal(formatTaskDateKey("20260101"), "2026-01-01");
});

test("urgent includes overdue and today but excludes future and undated tasks", () => {
  for (const [date, expected] of [["20261017", true], ["20261018", true], ["20261019", false], [undefined, false]]) {
    assert.equal(matchesTaskDateFilter(date, "urgent", "20261018"), expected);
  }
});

test("week starts Sunday and ends Saturday, including year boundaries", () => {
  for (const today of ["20261018", "20261024"]) {
    assert.equal(matchesTaskDateFilter("20261017", "week", today), false);
    assert.equal(matchesTaskDateFilter("20261018", "week", today), true);
    assert.equal(matchesTaskDateFilter("20261024", "week", today), true);
    assert.equal(matchesTaskDateFilter("20261025", "week", today), false);
  }
  assert.equal(matchesTaskDateFilter("20251228", "week", "20260101"), true);
  assert.equal(matchesTaskDateFilter("20260103", "week", "20260101"), true);
  assert.equal(matchesTaskDateFilter("20260104", "week", "20260101"), false);
});

test("next seven days include today and cross months and leap days", () => {
  assert.equal(matchesTaskDateFilter("20240301", "7d", "20240224"), true);
  assert.equal(matchesTaskDateFilter("20240302", "7d", "20240224"), false);
  assert.equal(matchesTaskDateFilter("20240223", "7d", "20240224"), false);
});

test("explicit deadline takes precedence over legacy date tags", () => {
  assert.equal(getDeadlineKey(new Date("2026-10-18T16:00:00Z"), "20261017"), "20261019");
  assert.equal(getDeadlineKey(undefined, "20261017"), "20261017");
  assert.equal(getDeadlineKey(undefined, undefined), undefined);
});
