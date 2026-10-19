import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
const pluginDir = fileURLToPath(new URL("..", import.meta.url));
const source = fs.readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const bundled = buildSync({
  stdin: { contents: source + "\nexport { getBoardLayout, classifyTask, DEFAULT_SETTINGS, AgentTaskBoardView };", resolveDir: pluginDir, loader: "ts" },
  bundle: true, platform: "node", format: "cjs", external: ["obsidian"], write: false
}).outputFiles[0].text;
class TFile { constructor(path) { this.path = path; } }
class Element {
  constructor(options = {}) { this.children = []; this.text = options.text ?? ""; this.cls = options.cls ?? ""; this.events = {}; }
  appendChild(child) { this.children.push(child); return child; }
  createDiv(options) { return this.appendChild(new Element(options)); }
  createSpan(options) { return this.appendChild(new Element(options)); }
  setText(text) { this.text = text; }
  setAttribute() {}
  addClass() {}
  addEventListener(name, callback) { this.events[name] = callback; }
  hasChildNodes() { return this.children.length > 0; }
  remove() {}
}
const context = { module: { exports: {} }, console, createSpan: (options) => new Element(options), require: (id) => id === "obsidian"
  ? { Plugin: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, TFile, Notice: class {}, moment: require("moment") }
  : require(id) };
vm.runInNewContext(bundled, context);
const { default: Plugin, getBoardLayout, classifyTask, DEFAULT_SETTINGS, AgentTaskBoardView } = context.module.exports;

test("both previous workflow settings use the same four groups", () => {
  for (const mode of [true, false]) {
    const layout = getBoardLayout(mode);
    assert.equal(layout.map((column) => column.title).join(","), "进行中,验收项,agent,待办项");
  }
});

test("collapsed metadata orders deadline, people and every tag in source order", () => {
  const plugin = new Plugin();
  plugin.settings = { ...DEFAULT_SETTINGS };
  const view = new AgentTaskBoardView({}, plugin);
  const card = new Element();
  const task = { text: "Work", taskDate: "20261018", collaborators: ["alice", "bob"], tags: ["project", "20261018", "collab", "foreground", "review", "agent", "inqueue", "priority"], subtasks: [] };
  view.renderCollapsedTaskCard(card, task, 0, 1, "key");
  const metadata = card.children[0].children.find((child) => child.cls === "atb-collapsed-metadata");
  assert.equal(card.children.length, 1);
  assert.equal(metadata.children.length, 5);
  assert.match(metadata.children[0].text, /2026-10-18/);
  assert.equal(metadata.children.slice(1).map((chip) => chip.text).join(","), "@alice,@bob,#project,#priority");
  let stopped = false;
  metadata.events.click({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
});

test("task creation keeps the clicked group and preserves task metadata", async () => {
  for (const category of ["foreground", "collab", "agent", "pool"]) {
    const plugin = new Plugin();
    plugin.settings = { ...DEFAULT_SETTINGS };
    plugin.refreshView = () => {};
    const file = new TFile("Tasks/Inbox.md");
    let content = "";
    plugin.ensureMarkdownFile = async () => file;
    plugin.app = { vault: {
      getMarkdownFiles: () => [file], cachedRead: async () => content,
      process: async (_, transform) => { content = transform(content); }
    } };
    await plugin.createTask("Work #project #review @alice #20261018", category, file.path, "[ ] Child", "https://example.com");
    const [task] = await plugin.collectTasks();
    assert.equal(task.category, category);
    assert.equal(task.tags.includes("project"), true);
    assert.equal(task.taskDate, "20261018");
    assert.equal(task.subtasks.length, 1);
  }
});

test("merging all six old categories is read only and keeps every task block", async () => {
  const plugin = new Plugin();
  plugin.settings = { ...DEFAULT_SETTINGS };
  const file = new TFile("Tasks/Inbox.md");
  const content = ["foreground", "collab", "review", "agent", "inqueue", ""].map((tag, index) =>
    `- [ ] Task ${index} ${tag ? `#${tag}` : ""}\n  - [ ] Child ${index}\n  - https://example.com/${index}`
  ).join("\n");
  plugin.app = { vault: {
    getMarkdownFiles: () => [file], cachedRead: async () => content,
    process: async () => { assert.fail("Grouping must not write source files"); }
  } };
  const tasks = await plugin.collectTasks();
  assert.equal(tasks.length, 6);
  assert.equal(tasks.map((task) => task.category).join(","), "foreground,collab,collab,agent,pool,pool");
  const visibleCategories = new Set(getBoardLayout(true).map((column) => column.category));
  for (const task of tasks) {
    assert.equal(visibleCategories.has(task.category), true);
    assert.equal(task.subtasks.length, 1);
    assert.equal(task.attachmentLines.length, 1);
  }
});

test("creation and editing persist today as a concrete date tag", async () => {
  const plugin = new Plugin();
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.refreshView = () => {};
  const file = new TFile("Tasks/Inbox.md");
  let content = "";
  plugin.ensureMarkdownFile = async () => file;
  plugin.app = { vault: {
    getMarkdownFiles: () => [file], cachedRead: async () => content,
    process: async (_, transform) => { content = transform(content); }
  } };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
  await plugin.createTask("Work #today #project @alice", "foreground", file.path);
  const [created] = await plugin.collectTasks();
  assert.equal(created.taskDate, today);
  assert.equal(created.tags.includes("today"), false);
  await plugin.updateTask(created, "Updated #today #project @bob", "", "");
  const [updated] = await plugin.collectTasks();
  assert.equal(updated.taskDate, today);
  assert.equal(updated.tags.includes("today"), false);
  assert.equal(updated.collaborators.join(","), "bob");
});

test("cross-file moves keep source on failure and preserve children on success", async () => {
  const plugin = new Plugin();
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.refreshView = () => {};
  const sourceFile = new TFile("Tasks/Inbox.md");
  const targetFile = new TFile("Tasks/Other.md");
  const original = "- [ ] Work #review #project @alice #20261018\n  - [ ] Child @bob\n  - https://example.com\n";
  const contents = new Map([[sourceFile.path, original], [targetFile.path, "- [ ] Target #agent\n"]]);
  let failDestination = true;
  plugin.app = { vault: {
    getMarkdownFiles: () => [sourceFile, targetFile],
    read: async (file) => contents.get(file.path),
    cachedRead: async (file) => contents.get(file.path),
    process: async (file, transform) => {
      if (file === targetFile && failDestination) throw new Error("write failed");
      contents.set(file.path, transform(contents.get(file.path)));
    }
  } };
  const [task, target] = await plugin.collectTasks();
  await assert.rejects(plugin.moveTaskLine(task, "agent", target, "after"), /write failed/);
  assert.equal(contents.get(sourceFile.path), original);
  failDestination = false;
  await plugin.moveTaskLine(task, "agent", target, "after");
  const tasks = await plugin.collectTasks();
  assert.equal(tasks.length, 2);
  const moved = tasks.find((item) => item.text === "Work");
  assert.equal(moved.file.path, targetFile.path);
  assert.equal(moved.category, "agent");
  assert.equal(moved.subtasks.length, 1);
  assert.equal(moved.attachmentLines.filter((line) => line.trim()).join("\n"), "  - https://example.com");
  assert.equal(moved.taskDate, "20261018");
  assert.equal(moved.tags.includes("project"), true);
  assert.equal(moved.collaborators.join(","), "alice,bob");
});

test("legacy review and queue tasks remain visible in merged groups", () => {
  const tags = { foreground: "#foreground", collab: "#collab", review: "#review", agent: "#agent", inqueue: "#inqueue" };
  for (const mode of [true, false]) {
    for (const [raw, category] of [["task #review", "collab"], ["task #collab", "collab"], ["task #inqueue", "pool"], ["task", "pool"], ["task #agent", "agent"]]) {
      assert.equal(classifyTask(raw, tags, mode), category);
    }
  }
});

test("editing inline metadata preserves edits, subtasks and attachments", async () => {
  const plugin = new Plugin();
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.refreshView = () => {};
  const file = new TFile("Tasks/Inbox.md");
  let content = "- [ ] Work #collab #old #20261017 @alice\n  - [ ] First @bob\n  - [ ] Second @carol\n  - https://example.com\n";
  plugin.app = { vault: {
    getMarkdownFiles: () => [file], cachedRead: async () => content,
    process: async (_, transform) => { content = transform(content); }
  } };
  const [task] = await plugin.collectTasks();
  assert.equal(task.collaborators.join(","), "alice,bob,carol");
  await plugin.toggleSubtask(task, task.subtasks[1], true);
  const [toggled] = await plugin.collectTasks();
  assert.equal(toggled.subtasks[0].completed, false);
  assert.equal(toggled.subtasks[1].completed, true);
  await plugin.toggleSubtask(toggled, toggled.subtasks[1], false);
  assert.equal((await plugin.collectTasks())[0].subtasks[1].completed, false);
  await plugin.updateTask(task, "Work #new #20261018 @dave due::2026-10-19", "[ ] First @bob\n[x] Second @carol", "https://example.com");
  const [updated] = await plugin.collectTasks();
  assert.equal(updated.tags.includes("new"), true);
  assert.equal(updated.tags.includes("old"), false);
  assert.equal(updated.taskDate, "20261018");
  assert.equal(updated.due.toISOString(), "2026-10-18T16:00:00.000Z");
  assert.equal(updated.category, "collab");
  assert.equal(updated.subtasks.length, 2);
  assert.equal(updated.subtasks[1].completed, true);
  assert.equal(updated.collaborators.join(","), "dave,bob");
  assert.match(content, /https:\/\/example.com/);
});
