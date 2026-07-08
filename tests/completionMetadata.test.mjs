import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(__dirname, "../completionMetadata.ts");
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

const { setCheckboxCompletion } = module.exports;

test("setCheckboxCompletion adds completion date when checking a subtask", () => {
  assert.equal(
    setCheckboxCompletion("  - [ ] 绩效报告需要加到~100页", true, "2026-07-08"),
    "  - [x] 绩效报告需要加到~100页 ✅ 2026-07-08"
  );
});

test("setCheckboxCompletion removes old completion date when unchecking", () => {
  assert.equal(
    setCheckboxCompletion("  - [x] 绩效报告需要加到~100页 ✅ 2026-07-07", false, "2026-07-08"),
    "  - [ ] 绩效报告需要加到~100页"
  );
});

test("setCheckboxCompletion replaces existing completion date when checking", () => {
  assert.equal(
    setCheckboxCompletion("  - [x] 绩效报告需要加到~100页 ✅ 2026-07-07", true, "2026-07-08"),
    "  - [x] 绩效报告需要加到~100页 ✅ 2026-07-08"
  );
});
