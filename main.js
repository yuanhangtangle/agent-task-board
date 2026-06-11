var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => AgentTaskBoardPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var VIEW_TYPE_AGENT_TASK_BOARD = "agent-task-board-view";
var DEFAULT_SETTINGS = {
  scanPathPatterns: ["Inbox.md", "Tasks/.*\\.md", "Projects/.*\\.md"],
  inboxFile: "Tasks/Inbox.md",
  completedTaskFile: "Tasks/Done.md",
  foregroundTag: "#foreground",
  agentTag: "#agent",
  collabTag: "#collab",
  inqueueTag: "#inqueue",
  dateFormat: "YYYY-MM-DD",
  density: "compact",
  moveCompletedTasks: true,
  taskOrder: {
    foreground: [],
    agent: [],
    collab: [],
    inqueue: [],
    pool: []
  }
};
var CATEGORY_LABELS = {
  foreground: "\u524D\u53F0\u4EFB\u52A1",
  agent: "Agent \u4EFB\u52A1",
  collab: "\u534F\u4F5C\u4EFB\u52A1",
  inqueue: "\u5165\u961F\u4EFB\u52A1",
  pool: "\u4EFB\u52A1\u6C60"
};
var AgentTaskBoardPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_AGENT_TASK_BOARD, (leaf) => new AgentTaskBoardView(leaf, this));
    this.addRibbonIcon("list-checks", "Open Agent Task Board", () => this.activateView());
    this.addCommand({
      id: "open-agent-task-board",
      name: "Open Agent Task Board",
      callback: () => this.activateView()
    });
    this.addCommand({
      id: "create-agent-task",
      name: "Create agent task",
      callback: () => new CreateTaskModal(this.app, this).open()
    });
    this.addSettingTab(new AgentTaskBoardSettingTab(this.app, this));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshView()));
    this.registerEvent(this.app.vault.on("modify", () => this.refreshView()));
  }
  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_TASK_BOARD);
    if (leaves.length === 0) {
      const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_AGENT_TASK_BOARD, active: true });
    } else {
      this.app.workspace.revealLeaf(leaves[0]);
    }
  }
  refreshView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_TASK_BOARD)) {
      const view = leaf.view;
      if (view instanceof AgentTaskBoardView) void view.renderTasks();
    }
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.taskOrder = normalizeTaskOrder(this.settings.taskOrder);
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshView();
  }
  getCategoryTags() {
    return {
      foreground: prefixHash(this.settings.foregroundTag),
      agent: prefixHash(this.settings.agentTag),
      collab: prefixHash(this.settings.collabTag),
      inqueue: prefixHash(this.settings.inqueueTag)
    };
  }
  async collectTasks() {
    const tasks = [];
    const matchers = compilePathMatchers(this.settings.scanPathPatterns);
    const completedPath = normalizePath(this.settings.completedTaskFile);
    const inboxPath = normalizePath(this.settings.inboxFile);
    const categoryTags = this.getCategoryTags();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (completedPath && file.path === completedPath) continue;
      if (matchers.length > 0 && file.path !== inboxPath && !matchers.some((re) => re.test(file.path))) continue;
      const content = await this.app.vault.cachedRead(file);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = /^(\s*[-*]\s+\[\s\]\s+)(.*)$/.exec(line);
        if (!match) continue;
        const raw = match[2];
        const blockRange = getTaskBlockRange(lines, i);
        const originalBlock = lines.slice(i, blockRange.end + 1);
        const attachmentLines = originalBlock.slice(1);
        const tags = extractTags(raw);
        const collaborators = extractCollaborators(raw);
        const category = classifyTask(raw, categoryTags);
        const created = extractDate(raw, "created", ["\u{1F4CB}"]);
        const start = extractDate(raw, "start", ["\u{1F6EB}", "\u23F3"]);
        const due = extractDate(raw, "due", ["\u{1F4C5}"]);
        const text = cleanupTaskText(raw);
        if (!text) continue;
        tasks.push({
          id: buildTaskId(file.path, i, raw, categoryTags),
          text,
          rawText: raw,
          file,
          line: i,
          blockEndLine: blockRange.end,
          category,
          tags,
          collaborators,
          links: extractLinks([raw, ...attachmentLines]),
          attachmentLines,
          created: created ?? void 0,
          start: start ?? void 0,
          due: due ?? void 0,
          originalLine: line,
          originalBlock
        });
      }
    }
    return tasks;
  }
  async createTask(text, category, targetFilePath, attachmentText = "") {
    const cleaned = text.trim();
    if (!cleaned) return;
    const path = normalizePath(targetFilePath || this.settings.inboxFile);
    if (!path) {
      new import_obsidian.Notice("\u8BF7\u5148\u8BBE\u7F6E\u9ED8\u8BA4 Inbox \u6587\u4EF6");
      return;
    }
    const block = [
      buildTaskLine(cleaned, category, this.getCategoryTags()),
      ...normalizeAttachmentInput(attachmentText)
    ];
    const file = await this.ensureMarkdownFile(path);
    await this.app.vault.process(file, (data) => appendBlock(data, block));
    this.refreshView();
    new import_obsidian.Notice("\u5DF2\u521B\u5EFA\u4EFB\u52A1");
  }
  async updateTask(task, rawText, attachmentText) {
    const categoryTags = this.getCategoryTags();
    const nextRaw = rawText.trim();
    if (!nextRaw) {
      new import_obsidian.Notice("\u4EFB\u52A1\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
      return;
    }
    const nextBlock = [
      buildTaskLine(nextRaw, task.category, categoryTags),
      ...attachmentText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => `  - ${line.replace(/^[-*]\s+/, "")}`)
    ];
    await this.replaceTaskBlock(task, nextBlock);
    this.refreshView();
    new import_obsidian.Notice("\u5DF2\u66F4\u65B0\u4EFB\u52A1");
  }
  async appendTaskAttachments(task, attachmentLines) {
    const nextAttachments = [
      ...task.attachmentLines.map((line) => cleanupAttachmentLine(line)).filter(Boolean),
      ...attachmentLines.map((line) => line.trim()).filter(Boolean)
    ];
    const nextBlock = [
      buildTaskLine(task.rawText, task.category, this.getCategoryTags()),
      ...normalizeAttachmentInput(nextAttachments.join("\n"))
    ];
    await this.replaceTaskBlock(task, nextBlock);
    this.refreshView();
    new import_obsidian.Notice(`\u5DF2\u6DFB\u52A0 ${attachmentLines.length} \u4E2A\u9644\u4EF6`);
  }
  async deleteTaskAttachment(task, link) {
    const nextAttachments = removeMatchingAttachment(task.attachmentLines, link);
    if (nextAttachments.length === task.attachmentLines.length) {
      new import_obsidian.Notice("\u672A\u627E\u5230\u5BF9\u5E94\u9644\u4EF6\u884C");
      return;
    }
    const nextBlock = [
      buildTaskLine(task.rawText, task.category, this.getCategoryTags()),
      ...normalizeAttachmentInput(nextAttachments.join("\n"))
    ];
    await this.replaceTaskBlock(task, nextBlock);
    this.refreshView();
    new import_obsidian.Notice("\u5DF2\u5220\u9664\u9644\u4EF6");
  }
  async deleteTask(task) {
    await this.removeTaskBlock(task);
    this.refreshView();
    new import_obsidian.Notice("\u5DF2\u5220\u9664\u4EFB\u52A1");
  }
  async completeTask(task) {
    const today = (0, import_obsidian.moment)().format(this.settings.dateFormat);
    const completedBlock = [...task.originalBlock];
    let completedLine = completedBlock[0].replace(/^(\s*[-*]\s+\[)\s(\]\s+)/, "$1x$2");
    completedLine = completedLine.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, "");
    completedBlock[0] = `${completedLine} \u2705 ${today} <!-- from: ${task.file.path}:${task.line + 1} -->`;
    if (this.settings.moveCompletedTasks && this.settings.completedTaskFile.trim()) {
      const completedFile = await this.ensureMarkdownFile(normalizePath(this.settings.completedTaskFile));
      await this.removeTaskBlock(task);
      await this.app.vault.process(completedFile, (data) => appendBlock(data, completedBlock));
      new import_obsidian.Notice("\u5DF2\u5B8C\u6210\u5E76\u79FB\u52A8\u5230\u5F52\u6863\u6587\u4EF6");
    } else {
      await this.replaceTaskBlock(task, completedBlock);
      new import_obsidian.Notice("\u5DF2\u6807\u8BB0\u5B8C\u6210");
    }
    this.refreshView();
  }
  async setTaskCategory(task, category) {
    const categoryTags = this.getCategoryTags();
    await this.transformTaskLine(task, (line) => setCategoryTag(line, category, categoryTags));
    this.refreshView();
    new import_obsidian.Notice(`\u5DF2\u79FB\u52A8\u5230${CATEGORY_LABELS[category]}`);
  }
  async moveTask(task, category, targetId, position) {
    const categoryTags = this.getCategoryTags();
    if (task.category !== category) {
      await this.transformTaskLine(task, (line) => setCategoryTag(line, category, categoryTags));
    }
    this.setOrderPosition(task.id, category, targetId, position);
    await this.saveSettings();
    new import_obsidian.Notice(`\u5DF2\u79FB\u52A8\u5230${CATEGORY_LABELS[category]}`);
  }
  async moveTaskLine(task, category, targetTask, position) {
    const categoryTags = this.getCategoryTags();
    const rewriteBlock = (block) => {
      const next = [...block];
      next[0] = setCategoryTag(next[0], category, categoryTags);
      return next;
    };
    if (targetTask && task.id === targetTask.id) return;
    if (!targetTask) {
      await this.replaceTaskBlock(task, rewriteBlock(task.originalBlock));
      this.refreshView();
      new import_obsidian.Notice(`\u5DF2\u79FB\u52A8\u5230${CATEGORY_LABELS[category]}`);
      return;
    }
    if (task.file.path === targetTask.file.path) {
      await this.app.vault.process(task.file, (data) => {
        const lines = data.split(/\r?\n/);
        const sourceIdx = findCurrentTaskLine(lines, task);
        if (sourceIdx < 0) {
          new import_obsidian.Notice("\u4EFB\u52A1\u6E90\u884C\u5DF2\u53D8\u5316\uFF0C\u672A\u79FB\u52A8");
          return data;
        }
        const sourceRange = getTaskBlockRange(lines, sourceIdx);
        const sourceBlock = lines.splice(sourceIdx, sourceRange.end - sourceIdx + 1);
        const targetIdx = findCurrentTaskLine(lines, targetTask);
        if (targetIdx < 0) {
          new import_obsidian.Notice("\u76EE\u6807\u4EFB\u52A1\u6E90\u884C\u5DF2\u53D8\u5316\uFF0C\u672A\u79FB\u52A8");
          lines.splice(sourceIdx, 0, ...sourceBlock);
          return lines.join("\n");
        }
        const targetRange = getTaskBlockRange(lines, targetIdx);
        const insertIdx = position === "before" ? targetIdx : targetRange.end + 1;
        lines.splice(insertIdx, 0, ...rewriteBlock(sourceBlock));
        return lines.join("\n");
      });
    } else {
      let movedBlock = null;
      await this.app.vault.process(task.file, (data) => {
        const lines = data.split(/\r?\n/);
        const sourceIdx = findCurrentTaskLine(lines, task);
        if (sourceIdx < 0) {
          new import_obsidian.Notice("\u4EFB\u52A1\u6E90\u884C\u5DF2\u53D8\u5316\uFF0C\u672A\u79FB\u52A8");
          return data;
        }
        const sourceRange = getTaskBlockRange(lines, sourceIdx);
        movedBlock = rewriteBlock(lines.splice(sourceIdx, sourceRange.end - sourceIdx + 1));
        return lines.join("\n");
      });
      if (!movedBlock) return;
      const blockToInsert = movedBlock;
      await this.app.vault.process(targetTask.file, (data) => {
        const lines = data.split(/\r?\n/);
        const targetIdx = findCurrentTaskLine(lines, targetTask);
        if (targetIdx < 0) {
          new import_obsidian.Notice("\u76EE\u6807\u4EFB\u52A1\u6E90\u884C\u5DF2\u53D8\u5316\uFF0C\u672A\u63D2\u5165");
          return appendBlock(data, blockToInsert);
        }
        const targetRange = getTaskBlockRange(lines, targetIdx);
        const insertIdx = position === "before" ? targetIdx : targetRange.end + 1;
        lines.splice(insertIdx, 0, ...blockToInsert);
        return lines.join("\n");
      });
    }
    this.refreshView();
    new import_obsidian.Notice(`\u5DF2\u79FB\u52A8\u5230${CATEGORY_LABELS[category]}`);
  }
  syncTaskOrder(tasks) {
    const presentIds = new Set(tasks.map((task) => task.id));
    let changed = false;
    for (const category of Object.keys(CATEGORY_LABELS)) {
      const before = this.settings.taskOrder[category] ?? [];
      const after = before.filter((id) => presentIds.has(id));
      if (after.length !== before.length) changed = true;
      this.settings.taskOrder[category] = after;
    }
    for (const task of tasks) {
      const order = this.settings.taskOrder[task.category];
      if (!order.includes(task.id)) {
        order.push(task.id);
        changed = true;
      }
    }
    if (changed) void this.saveData(this.settings);
  }
  setOrderPosition(taskId, category, targetId, position) {
    for (const key of Object.keys(CATEGORY_LABELS)) {
      removeValue(this.settings.taskOrder[key], taskId);
    }
    const order = this.settings.taskOrder[category];
    let insertIndex = order.length;
    if (targetId && position !== "end") {
      const targetIndex = order.indexOf(targetId);
      if (targetIndex >= 0) insertIndex = position === "before" ? targetIndex : targetIndex + 1;
    }
    order.splice(insertIndex, 0, taskId);
  }
  async transformTaskLine(task, replacer) {
    await this.app.vault.process(task.file, (data) => {
      const lines = data.split(/\r?\n/);
      const idx = findCurrentTaskLine(lines, task);
      if (idx < 0) {
        new import_obsidian.Notice("\u4EFB\u52A1\u6E90\u884C\u5DF2\u53D8\u5316\uFF0C\u672A\u5199\u56DE");
        return data;
      }
      lines[idx] = replacer(lines[idx]);
      return lines.join("\n");
    });
  }
  async removeOriginalLine(task) {
    await this.removeTaskBlock(task);
  }
  async replaceTaskBlock(task, nextBlock) {
    await this.app.vault.process(task.file, (data) => {
      const lines = data.split(/\r?\n/);
      const idx = findCurrentTaskLine(lines, task);
      if (idx < 0) {
        new import_obsidian.Notice("\u4EFB\u52A1\u6E90\u884C\u5DF2\u53D8\u5316\uFF0C\u672A\u5199\u56DE");
        return data;
      }
      const range = getTaskBlockRange(lines, idx);
      lines.splice(idx, range.end - idx + 1, ...nextBlock);
      return lines.join("\n");
    });
  }
  async removeTaskBlock(task) {
    await this.app.vault.process(task.file, (data) => {
      const lines = data.split(/\r?\n/);
      const idx = findCurrentTaskLine(lines, task);
      if (idx < 0) {
        new import_obsidian.Notice("\u4EFB\u52A1\u6E90\u884C\u5DF2\u53D8\u5316\uFF0C\u672A\u5220\u9664\u539F\u4EFB\u52A1");
        return data;
      }
      const range = getTaskBlockRange(lines, idx);
      lines.splice(idx, range.end - idx + 1);
      return lines.join("\n");
    });
  }
  async ensureMarkdownFile(path) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian.TFile) return existing;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await ensureFolder(this.app, parent);
    return await this.app.vault.create(path, "");
  }
};
var AgentTaskBoardView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.filterTags = [];
    this.excludeTags = [];
    this.filterCollabs = [];
    this.excludeCollabs = [];
    this.filterMode = "OR";
    this.expandedTaskIds = /* @__PURE__ */ new Set();
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_AGENT_TASK_BOARD;
  }
  getDisplayText() {
    return "Agent Task Board";
  }
  getIcon() {
    return "list-checks";
  }
  async onOpen() {
    await this.renderTasks();
  }
  async onClose() {
  }
  async renderTasks() {
    const root = this.containerEl;
    root.empty();
    root.toggleClass("atb-compact", this.plugin.settings.density === "compact");
    const outer = root.createDiv({ cls: "atb-outer" });
    this.renderTopbar(outer);
    let tasks = await this.plugin.collectTasks();
    tasks.sort(compareTasks);
    this.renderFilterToolbar(outer, tasks);
    tasks = this.applyFilters(tasks);
    const grid = outer.createDiv({ cls: "atb-board" });
    const panels = {
      foreground: this.createPanel(grid, "\u524D\u53F0\u4EFB\u52A1", "atb-q-foreground", "foreground"),
      agent: this.createPanel(grid, "Agent \u4EFB\u52A1", "atb-q-agent", "agent"),
      collab: this.createPanel(grid, "\u534F\u4F5C\u4EFB\u52A1", "atb-q-collab", "collab"),
      inqueue: this.createPanel(grid, "\u5165\u961F\u4EFB\u52A1", "atb-q-inqueue", "inqueue"),
      pool: this.createPanel(grid, "\u4EFB\u52A1\u6C60", "atb-q-pool", "pool")
    };
    const counters = { foreground: 0, agent: 0, collab: 0, inqueue: 0, pool: 0 };
    const tasksByCategory = { foreground: [], agent: [], collab: [], inqueue: [], pool: [] };
    for (const task of tasks) {
      counters[task.category]++;
      tasksByCategory[task.category].push(task);
      panels[task.category].list.appendChild(this.renderTaskCard(task));
    }
    Object.keys(panels).forEach((category) => panels[category].countEl.setText(String(counters[category])));
    for (const [category, panel] of Object.entries(panels)) {
      panel.list.addEventListener("dragover", (ev) => {
        if (ev.target.closest(".atb-card")) return;
        ev.preventDefault();
        panel.el.addClass("drop-target");
      });
      panel.list.addEventListener("dragleave", () => panel.el.removeClass("drop-target"));
      panel.list.addEventListener("drop", async (ev) => {
        if (ev.target.closest(".atb-card")) return;
        ev.preventDefault();
        panel.el.removeClass("drop-target");
        const payload = ev.dataTransfer?.getData("application/json");
        if (!payload) return;
        try {
          const data = JSON.parse(payload);
          const file = this.plugin.app.vault.getAbstractFileByPath(data.filePath);
          if (!(file instanceof import_obsidian.TFile)) return;
          const targetTask = findLastDifferentTask(tasksByCategory[category], data.id);
          await this.plugin.moveTaskLine({
            id: data.id,
            text: "",
            file,
            line: data.line,
            blockEndLine: data.line + data.originalBlock.length - 1,
            rawText: "",
            originalLine: data.originalLine,
            originalBlock: data.originalBlock,
            category: data.category,
            tags: [],
            collaborators: [],
            links: [],
            attachmentLines: []
          }, category, targetTask, targetTask ? "after" : "end");
        } catch (error) {
          console.error(error);
          new import_obsidian.Notice("\u62D6\u62FD\u5199\u56DE\u5931\u8D25");
        }
      });
    }
  }
  renderTopbar(container) {
    const topbar = container.createDiv({ cls: "atb-topbar" });
    topbar.createDiv({ cls: "atb-view-title", text: "Agent Task Board" });
    const addButton = topbar.createEl("button", { cls: "atb-primary-btn", text: "+" });
    addButton.setAttribute("aria-label", "\u65B0\u589E\u4EFB\u52A1");
    addButton.setAttribute("title", "\u65B0\u589E\u4EFB\u52A1");
    addButton.addEventListener("click", () => new CreateTaskModal(this.app, this.plugin).open());
    const refreshButton = topbar.createEl("button", { cls: "atb-icon-btn", text: "\u21BB" });
    refreshButton.setAttribute("aria-label", "\u5237\u65B0");
    refreshButton.setAttribute("title", "\u5237\u65B0");
    refreshButton.addEventListener("click", () => this.renderTasks());
  }
  createPanel(container, title, cls, category) {
    const panel = container.createDiv({ cls: `atb-panel ${cls}` });
    const header = panel.createDiv({ cls: "atb-panel-header" });
    header.createDiv({ cls: "atb-panel-title", text: title });
    const actions = header.createDiv({ cls: "atb-panel-actions" });
    const addButton = actions.createEl("button", { cls: "atb-panel-add", text: "+" });
    addButton.setAttribute("title", `\u65B0\u589E${title}`);
    addButton.addEventListener("click", () => new CreateTaskModal(this.app, this.plugin, category).open());
    const countEl = actions.createDiv({ cls: "atb-count" });
    const list = panel.createDiv({ cls: "atb-list" });
    return { el: panel, list, countEl };
  }
  renderTaskCard(task) {
    const tooltipParts = [
      task.file.path,
      `\u884C ${task.line + 1}`,
      task.due ? `\u622A\u6B62 ${(0, import_obsidian.moment)(task.due).format(this.plugin.settings.dateFormat)}` : "",
      task.created ? `\u521B\u5EFA ${(0, import_obsidian.moment)(task.created).format(this.plugin.settings.dateFormat)}` : ""
    ].filter(Boolean);
    const isExpanded = this.expandedTaskIds.has(task.id);
    const card = createDiv({ cls: `atb-card ${isExpanded ? "is-expanded" : ""}`, attr: { draggable: "true", title: tooltipParts.join(" \xB7 ") } });
    card.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("application/json", JSON.stringify({
        id: task.id,
        filePath: task.file.path,
        line: task.line,
        originalLine: task.originalLine,
        originalBlock: task.originalBlock,
        category: task.category
      }));
      ev.dataTransfer?.setData("text/plain", task.text);
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => {
      card.removeClass("is-dragging");
      card.removeClass("insert-before");
      card.removeClass("insert-after");
    });
    card.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      const position = getInsertPosition(card, ev);
      card.toggleClass("insert-before", position === "before");
      card.toggleClass("insert-after", position === "after");
    });
    card.addEventListener("dragleave", () => {
      card.removeClass("insert-before");
      card.removeClass("insert-after");
    });
    card.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      card.removeClass("insert-before");
      card.removeClass("insert-after");
      const payload = ev.dataTransfer?.getData("application/json");
      const hasDroppedFiles = (ev.dataTransfer?.files.length ?? 0) > 0;
      const fileAttachments = !payload || hasDroppedFiles ? collectDroppedFileAttachments(ev.dataTransfer) : [];
      if (fileAttachments.length > 0) {
        await this.plugin.appendTaskAttachments(task, fileAttachments);
        await this.renderTasks();
        return;
      }
      if (!payload) return;
      try {
        const data = JSON.parse(payload);
        if (data.id === task.id) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(data.filePath);
        if (!(file instanceof import_obsidian.TFile)) return;
        await this.plugin.moveTaskLine({
          id: data.id,
          text: "",
          file,
          line: data.line,
          blockEndLine: data.line + data.originalBlock.length - 1,
          rawText: "",
          originalLine: data.originalLine,
          originalBlock: data.originalBlock,
          category: data.category,
          tags: [],
          collaborators: [],
          links: [],
          attachmentLines: []
        }, task.category, task, getInsertPosition(card, ev));
        await this.renderTasks();
      } catch (error) {
        console.error(error);
        new import_obsidian.Notice("\u62D6\u62FD\u6392\u5E8F\u5931\u8D25");
      }
    });
    const top = card.createDiv({ cls: "atb-card-top" });
    const checkbox = top.createEl("input", { type: "checkbox" });
    checkbox.addClass("atb-done-box");
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", async () => {
      await this.plugin.completeTask(task);
      await this.renderTasks();
    });
    const title = top.createDiv({ cls: "atb-task-title", text: task.text });
    const chips = card.createDiv({ cls: "atb-chips" });
    if (task.collaborators.length > 0) {
      for (const collaborator of task.collaborators) chips.appendChild(createChip(`@${collaborator}`, "atb-chip-collab"));
    }
    if (task.tags.length > 0) {
      for (const tag of task.tags) {
        const chip = createChip(`#${tag}`, "atb-chip-tag");
        chip.setAttribute("data-tag-color", String(getTagColorIndex(tag)));
        chips.appendChild(chip);
      }
    }
    if (task.due) {
      const today = (0, import_obsidian.moment)().startOf("day");
      const due = (0, import_obsidian.moment)(task.due).startOf("day");
      const diff = due.diff(today, "days");
      const chip = createChip(diff < 0 ? `\u903E\u671F${Math.abs(diff)}\u5929` : diff === 0 ? "\u4ECA\u5929\u5230\u671F" : `${diff}\u5929\u540E\u5230\u671F`, diff <= 0 ? "atb-chip-danger" : "atb-chip-date");
      chips.appendChild(chip);
    }
    const footer = card.createDiv({ cls: "atb-card-footer" });
    const source = footer.createDiv({ cls: "atb-source", text: `${task.file.basename}:${task.line + 1}` });
    source.setAttribute("title", "\u6253\u5F00\u6E90\u6587\u4EF6");
    source.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.openTaskSource(task);
    });
    const linkIndicator = footer.createEl("button", {
      cls: `atb-link-indicator ${task.links.length === 0 ? "is-empty" : ""}`,
      text: `\u9644\u4EF6 ${task.links.length}`
    });
    linkIndicator.setAttribute("title", isExpanded ? "\u6536\u8D77\u9644\u4EF6" : "\u5C55\u5F00\u9644\u4EF6");
    linkIndicator.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.expandedTaskIds.has(task.id)) this.expandedTaskIds.delete(task.id);
      else this.expandedTaskIds.add(task.id);
      void this.renderTasks();
    });
    if (isExpanded) this.renderTaskDetails(card, task);
    return card;
  }
  renderTaskDetails(card, task) {
    const details = card.createDiv({ cls: "atb-card-details" });
    if (task.links.length > 0) {
      const links = details.createDiv({ cls: "atb-link-list" });
      for (const link of task.links) {
        const row = links.createDiv({ cls: "atb-link-row" });
        const button = row.createEl("button", { cls: `atb-link-btn ${link.type === "file" ? "is-file" : ""}`, text: link.label });
        button.setAttribute("title", link.url);
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          await openAttachment(link);
        });
        const remove = row.createEl("button", { cls: "atb-link-remove", text: "\xD7" });
        remove.setAttribute("title", "\u5220\u9664\u9644\u4EF6");
        remove.addEventListener("click", async (event) => {
          event.stopPropagation();
          await this.plugin.deleteTaskAttachment(task, link);
          await this.renderTasks();
        });
      }
    } else {
      details.createDiv({ cls: "atb-detail-empty", text: "\u65E0\u9644\u4EF6" });
    }
    const actions = details.createDiv({ cls: "atb-detail-actions" });
    const editButton = actions.createEl("button", { text: "\u7F16\u8F91" });
    editButton.addEventListener("click", (event) => {
      event.stopPropagation();
      new EditTaskModal(this.app, this.plugin, task).open();
    });
  }
  async openTaskSource(task) {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(task.file);
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) return;
    view.editor.setCursor({ line: task.line, ch: 0 });
    view.editor.scrollIntoView({ from: { line: task.line, ch: 0 }, to: { line: task.line + 1, ch: 0 } }, true);
  }
  renderFilterToolbar(container, allTasks) {
    const tags = Array.from(new Set(allTasks.flatMap((task) => task.tags))).sort();
    const collaborators = Array.from(new Set(allTasks.flatMap((task) => task.collaborators))).sort();
    const toolbar = container.createDiv({ cls: "atb-filter-toolbar" });
    const activeFilters = this.filterTags.length + this.excludeTags.length + this.filterCollabs.length + this.excludeCollabs.length;
    if (this.filterTags.length >= 2) {
      const modeButton = toolbar.createEl("button", { cls: "atb-filter-mode", text: this.filterMode });
      modeButton.setAttribute("title", this.filterMode === "AND" ? "\u6240\u6709\u6807\u7B7E\u90FD\u5339\u914D" : "\u4EFB\u4E00\u6807\u7B7E\u5339\u914D");
      modeButton.addEventListener("click", () => {
        this.filterMode = this.filterMode === "AND" ? "OR" : "AND";
        void this.renderTasks();
      });
    }
    for (const tag of this.filterTags) this.renderFilterChip(toolbar, tag, "#", false, this.filterTags, this.excludeTags, "tag");
    for (const tag of this.excludeTags) this.renderFilterChip(toolbar, tag, "#", true, this.filterTags, this.excludeTags, "tag");
    for (const collaborator of this.filterCollabs) this.renderFilterChip(toolbar, collaborator, "@", false, this.filterCollabs, this.excludeCollabs, "collab");
    for (const collaborator of this.excludeCollabs) this.renderFilterChip(toolbar, collaborator, "@", true, this.filterCollabs, this.excludeCollabs, "collab");
    if (activeFilters >= 2) {
      const clearButton = toolbar.createEl("button", { cls: "atb-clear-filter", text: "\u6E05\u9664" });
      clearButton.addEventListener("click", () => {
        this.filterTags = [];
        this.excludeTags = [];
        this.filterCollabs = [];
        this.excludeCollabs = [];
        void this.renderTasks();
      });
    }
    this.renderFilterInput(toolbar, tags, collaborators);
  }
  renderFilterChip(container, name, prefix, isExclude, includeList, excludeList, type) {
    const chip = container.createSpan({ cls: `atb-filter-chip ${isExclude ? "is-exclude" : ""} ${type === "tag" ? "atb-chip-tag" : "atb-chip-collab"}` });
    if (type === "tag") chip.setAttribute("data-tag-color", String(getTagColorIndex(name)));
    const label = chip.createSpan({ text: `${prefix}${name}` });
    label.addEventListener("click", () => {
      if (isExclude) {
        removeValue(excludeList, name);
        includeList.push(name);
      } else {
        removeValue(includeList, name);
        excludeList.push(name);
      }
      void this.renderTasks();
    });
    const remove = chip.createSpan({ cls: "atb-chip-remove", text: "\xD7" });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeValue(isExclude ? excludeList : includeList, name);
      void this.renderTasks();
    });
  }
  renderFilterInput(container, allTags, allCollaborators) {
    const wrapper = container.createDiv({ cls: "atb-filter-input-wrap" });
    const input = wrapper.createEl("input", {
      cls: "atb-filter-input",
      attr: { type: "text", placeholder: "\u7B5B\u9009 #tag / @who" }
    });
    const dropdown = wrapper.createDiv({ cls: "atb-filter-dropdown" });
    dropdown.style.display = "none";
    let selectedIndex = -1;
    let suggestions = [];
    const select = (suggestion) => {
      if (suggestion.type === "tag") this.filterTags.push(suggestion.name);
      else this.filterCollabs.push(suggestion.name);
      void this.renderTasks();
    };
    const renderSuggestions = () => {
      const query = input.value.trim().replace(/^[#@]/, "").toLowerCase();
      dropdown.empty();
      selectedIndex = -1;
      suggestions = [];
      if (!query) {
        dropdown.style.display = "none";
        return;
      }
      suggestions = [
        ...allTags.filter((tag) => !this.filterTags.includes(tag) && !this.excludeTags.includes(tag)).filter((tag) => tag.toLowerCase().includes(query)).map((name) => ({ type: "tag", name })),
        ...allCollaborators.filter((collab) => !this.filterCollabs.includes(collab) && !this.excludeCollabs.includes(collab)).filter((collab) => collab.toLowerCase().includes(query)).map((name) => ({ type: "collab", name }))
      ].slice(0, 12);
      if (suggestions.length === 0) {
        dropdown.style.display = "none";
        return;
      }
      dropdown.style.display = "block";
      for (const suggestion of suggestions) {
        const item = dropdown.createDiv({ cls: "atb-filter-dropdown-item" });
        item.appendChild(createChip(`${suggestion.type === "tag" ? "#" : "@"}${suggestion.name}`, suggestion.type === "tag" ? "atb-chip-tag" : "atb-chip-collab"));
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          select(suggestion);
        });
      }
    };
    input.addEventListener("input", renderSuggestions);
    input.addEventListener("focus", renderSuggestions);
    input.addEventListener("blur", () => window.setTimeout(() => dropdown.style.display = "none", 150));
    input.addEventListener("keydown", (event) => {
      if (dropdown.style.display === "none") return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedIndex = selectedIndex < suggestions.length - 1 ? selectedIndex + 1 : 0;
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : suggestions.length - 1;
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (suggestions[selectedIndex] || suggestions[0]) select(suggestions[selectedIndex] || suggestions[0]);
      } else if (event.key === "Escape") {
        dropdown.style.display = "none";
        input.blur();
      }
      dropdown.querySelectorAll(".atb-filter-dropdown-item").forEach((el, idx) => el.toggleClass("is-selected", idx === selectedIndex));
    });
  }
  applyFilters(tasks) {
    const hasFilter = this.filterTags.length > 0 || this.excludeTags.length > 0 || this.filterCollabs.length > 0 || this.excludeCollabs.length > 0;
    if (!hasFilter) return tasks;
    return tasks.filter((task) => {
      if (this.excludeTags.some((tag) => task.tags.includes(tag))) return false;
      if (this.excludeCollabs.some((collab) => task.collaborators.includes(collab))) return false;
      const tagPass = this.filterTags.length === 0 ? true : this.filterMode === "AND" ? this.filterTags.every((tag) => task.tags.includes(tag)) : this.filterTags.some((tag) => task.tags.includes(tag));
      const collabPass = this.filterCollabs.length === 0 ? true : this.filterCollabs.some((collab) => task.collaborators.includes(collab));
      return tagPass && collabPass;
    });
  }
};
var CreateTaskModal = class extends import_obsidian.Modal {
  constructor(app, plugin, initialCategory = "foreground") {
    super(app);
    this.taskText = "";
    this.attachmentText = "";
    this.plugin = plugin;
    this.initialCategory = initialCategory;
    this.category = initialCategory;
    this.targetFile = plugin.settings.inboxFile;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("atb-create-modal");
    contentEl.createEl("h2", { text: "\u65B0\u589E\u4EFB\u52A1" });
    new import_obsidian.Setting(contentEl).setName("\u4EFB\u52A1").addTextArea((text) => {
      text.inputEl.rows = 4;
      text.setValue(this.taskText);
      text.setPlaceholder("\u5199\u4E0B\u8981\u5904\u7406\u7684 TODO\uFF0C\u53EF\u5305\u542B #tag \u548C @who");
      text.onChange((value) => this.taskText = value);
      window.setTimeout(() => text.inputEl.focus(), 50);
    });
    new import_obsidian.Setting(contentEl).setName("\u9644\u4EF6").setDesc("\u6BCF\u884C\u4E00\u4E2A\u94FE\u63A5\u3001\u672C\u673A\u6587\u4EF6\u6216\u8BF4\u660E\uFF0C\u4F1A\u5199\u6210\u4EFB\u52A1\u4E0B\u65B9\u7684\u7F29\u8FDB\u5B50\u9879\u3002").addTextArea((text) => {
      text.inputEl.rows = 4;
      text.setValue(this.attachmentText);
      text.setPlaceholder("PR: https://...\n\u672C\u673A\u6587\u4EF6: file:///Users/...");
      text.onChange((value) => this.attachmentText = value);
    });
    addLocalFilePicker(contentEl, (paths) => {
      this.attachmentText = appendAttachmentText(this.attachmentText, paths);
      this.onOpen();
    });
    new import_obsidian.Setting(contentEl).setName("\u5206\u7C7B").addDropdown((dropdown) => {
      dropdown.addOption("foreground", "\u524D\u53F0\u4EFB\u52A1").addOption("agent", "Agent \u4EFB\u52A1").addOption("collab", "\u534F\u4F5C\u4EFB\u52A1").addOption("inqueue", "\u5165\u961F\u4EFB\u52A1").addOption("pool", "\u4EFB\u52A1\u6C60").setValue(this.category).onChange((value) => this.category = value);
    });
    new import_obsidian.Setting(contentEl).setName("\u76EE\u6807\u6587\u4EF6").addText((text) => {
      text.setValue(this.targetFile);
      text.onChange((value) => this.targetFile = value.trim());
    });
    const buttons = contentEl.createDiv({ cls: "atb-modal-buttons" });
    const createButton = buttons.createEl("button", { cls: "mod-cta", text: "\u521B\u5EFA" });
    createButton.addEventListener("click", async () => {
      await this.plugin.createTask(this.taskText, this.category, this.targetFile, this.attachmentText);
      this.close();
    });
    const cancelButton = buttons.createEl("button", { text: "\u53D6\u6D88" });
    cancelButton.addEventListener("click", () => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
};
var EditTaskModal = class extends import_obsidian.Modal {
  constructor(app, plugin, task) {
    super(app);
    this.plugin = plugin;
    this.task = task;
    this.rawText = task.rawText;
    this.attachmentText = task.attachmentLines.map((line) => cleanupAttachmentLine(line)).filter(Boolean).join("\n");
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("atb-create-modal");
    contentEl.createEl("h2", { text: "\u7F16\u8F91\u4EFB\u52A1" });
    new import_obsidian.Setting(contentEl).setName("\u4EFB\u52A1").addTextArea((text) => {
      text.inputEl.rows = 4;
      text.setValue(this.rawText);
      text.onChange((value) => this.rawText = value);
      window.setTimeout(() => text.inputEl.focus(), 50);
    });
    new import_obsidian.Setting(contentEl).setName("\u9644\u4EF6").setDesc("\u6BCF\u884C\u4E00\u4E2A\u94FE\u63A5\u3001\u672C\u673A\u6587\u4EF6\u6216\u8BF4\u660E\uFF0C\u4F1A\u5199\u6210\u4EFB\u52A1\u4E0B\u65B9\u7684\u7F29\u8FDB\u5B50\u9879\u3002").addTextArea((text) => {
      text.inputEl.rows = 6;
      text.setValue(this.attachmentText);
      text.onChange((value) => this.attachmentText = value);
    });
    addLocalFilePicker(contentEl, (paths) => {
      this.attachmentText = appendAttachmentText(this.attachmentText, paths);
      this.onOpen();
    });
    const buttons = contentEl.createDiv({ cls: "atb-modal-buttons" });
    const saveButton = buttons.createEl("button", { cls: "mod-cta", text: "\u4FDD\u5B58" });
    saveButton.addEventListener("click", async () => {
      await this.plugin.updateTask(this.task, this.rawText, this.attachmentText);
      this.close();
    });
    const cancelButton = buttons.createEl("button", { text: "\u53D6\u6D88" });
    cancelButton.addEventListener("click", () => this.close());
  }
  onClose() {
    this.contentEl.empty();
  }
};
var AgentTaskBoardSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Agent Task Board \u8BBE\u7F6E" });
    new import_obsidian.Setting(containerEl).setName("\u626B\u63CF\u8DEF\u5F84\u6B63\u5219").setDesc("\u6BCF\u884C\u4E00\u4E2A vault \u76F8\u5BF9\u8DEF\u5F84\u6B63\u5219\u3002\u7559\u7A7A\u8868\u793A\u626B\u63CF\u6240\u6709 Markdown \u6587\u4EF6\u3002").addTextArea((text) => {
      text.inputEl.rows = 5;
      text.setValue(this.plugin.settings.scanPathPatterns.join("\n"));
      text.onChange(async (value) => {
        this.plugin.settings.scanPathPatterns = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("\u9ED8\u8BA4 Inbox \u6587\u4EF6").setDesc("\u63D2\u4EF6\u4E2D\u65B0\u5EFA\u4EFB\u52A1\u65F6\u9ED8\u8BA4\u8FFD\u52A0\u5230\u8FD9\u91CC\u3002").addText((text) => text.setValue(this.plugin.settings.inboxFile).onChange(async (value) => {
      this.plugin.settings.inboxFile = value.trim();
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u5B8C\u6210\u4EFB\u52A1\u6587\u4EF6").setDesc("\u52FE\u9009\u5B8C\u6210\u540E\u79FB\u52A8\u5230\u8FD9\u91CC\u3002").addText((text) => text.setValue(this.plugin.settings.completedTaskFile).onChange(async (value) => {
      this.plugin.settings.completedTaskFile = value.trim();
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u5B8C\u6210\u540E\u79FB\u52A8").setDesc("\u5173\u95ED\u540E\u53EA\u5728\u539F\u6587\u4EF6\u6807\u8BB0\u4E3A\u5B8C\u6210\u3002").addToggle((toggle) => toggle.setValue(this.plugin.settings.moveCompletedTasks).onChange(async (value) => {
      this.plugin.settings.moveCompletedTasks = value;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u524D\u53F0\u4EFB\u52A1\u6807\u7B7E").addText((text) => text.setValue(this.plugin.settings.foregroundTag).onChange(async (value) => {
      this.plugin.settings.foregroundTag = value.trim() || "#foreground";
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Agent \u4EFB\u52A1\u6807\u7B7E").addText((text) => text.setValue(this.plugin.settings.agentTag).onChange(async (value) => {
      this.plugin.settings.agentTag = value.trim() || "#agent";
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u534F\u4F5C\u4EFB\u52A1\u6807\u7B7E").addText((text) => text.setValue(this.plugin.settings.collabTag).onChange(async (value) => {
      this.plugin.settings.collabTag = value.trim() || "#collab";
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u5165\u961F\u4EFB\u52A1\u6807\u7B7E").addText((text) => text.setValue(this.plugin.settings.inqueueTag).onChange(async (value) => {
      this.plugin.settings.inqueueTag = value.trim() || "#inqueue";
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u65E5\u671F\u683C\u5F0F").addText((text) => text.setValue(this.plugin.settings.dateFormat).onChange(async (value) => {
      this.plugin.settings.dateFormat = value.trim() || "YYYY-MM-DD";
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("\u663E\u793A\u5BC6\u5EA6").addDropdown((dropdown) => dropdown.addOption("comfortable", "\u8212\u9002").addOption("compact", "\u7D27\u51D1").setValue(this.plugin.settings.density).onChange(async (value) => {
      this.plugin.settings.density = value;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "\u5206\u7C7B\u51B2\u7A81\u4F18\u5148\u7EA7\u56FA\u5B9A\u4E3A\uFF1A#foreground > #agent > #collab > #inqueue > \u65E0\u6807\u7B7E\u3002\u62D6\u62FD\u4F1A\u5148\u79FB\u9664\u56DB\u4E2A\u5206\u7C7B\u6807\u7B7E\uFF0C\u518D\u5199\u5165\u76EE\u6807\u5206\u7C7B\u6807\u7B7E\u3002"
    });
  }
};
var DATE_TIME_REGEX_FRAGMENT = "\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{2}:\\d{2}(?::\\d{2})?)?";
var STRICT_DATE_FORMATS = [
  "YYYY-MM-DD",
  "YYYY-MM-DD HH:mm",
  "YYYY-MM-DD HH:mm:ss",
  "YYYY-MM-DDTHH:mm",
  "YYYY-MM-DDTHH:mm:ss"
];
function compilePathMatchers(patterns) {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern);
    } catch {
      new import_obsidian.Notice(`\u65E0\u6548\u8DEF\u5F84\u6B63\u5219\uFF1A${pattern}`);
      return null;
    }
  }).filter((re) => re !== null);
}
function classifyTask(raw, tags) {
  if (containsTag(raw, tags.foreground)) return "foreground";
  if (containsTag(raw, tags.agent)) return "agent";
  if (containsTag(raw, tags.collab)) return "collab";
  if (containsTag(raw, tags.inqueue)) return "inqueue";
  return "pool";
}
function setCategoryTag(line, category, tags) {
  let next = removeCategoryTags(line, tags);
  if (category !== "pool") next = `${next.trim()} ${tags[category]}`;
  return squashSpaces(next);
}
function buildTaskLine(text, category, tags) {
  let line = text.replace(/^[-*]\s+\[[ xX]\]\s+/, "").trim();
  line = setCategoryTag(`- [ ] ${line}`, category, tags);
  return line;
}
function findCurrentTaskLine(lines, task) {
  if (lines[task.line] === task.originalLine) return task.line;
  const start = Math.max(0, task.line - 5);
  const end = Math.min(lines.length, task.line + 6);
  for (let i = start; i < end; i++) {
    if (lines[i] === task.originalLine) return i;
  }
  return lines.findIndex((line) => line === task.originalLine);
}
function appendLine(data, line) {
  const trimmedEnd = data.replace(/\s*$/, "");
  return trimmedEnd ? `${trimmedEnd}
${line}
` : `${line}
`;
}
function appendBlock(data, block) {
  return appendLine(data, block.join("\n"));
}
function getTaskBlockRange(lines, startIdx) {
  const taskIndent = getIndentLength(lines[startIdx] ?? "");
  let end = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      end = i;
      continue;
    }
    if (getIndentLength(line) > taskIndent) {
      end = i;
      continue;
    }
    break;
  }
  return { start: startIdx, end };
}
function getIndentLength(line) {
  return /^(\s*)/.exec(line)?.[1].length ?? 0;
}
function normalizeAttachmentInput(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => `  - ${line.replace(/^[-*]\s+/, "")}`);
}
function cleanupAttachmentLine(line) {
  return line.trim().replace(/^[-*]\s+/, "").trim();
}
function addLocalFilePicker(container, onSelect) {
  const wrapper = container.createDiv({ cls: "atb-file-picker" });
  const button = wrapper.createEl("button", { type: "button", text: "\u6DFB\u52A0\u672C\u673A\u6587\u4EF6" });
  const hint = wrapper.createSpan({ text: "\u4E5F\u53EF\u4EE5\u628A\u6587\u4EF6\u62D6\u5230\u4EFB\u52A1\u5361\u7247\u4E0A" });
  const input = wrapper.createEl("input", { type: "file" });
  input.multiple = true;
  input.style.display = "none";
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const paths = collectFileInputPaths(input.files);
    if (paths.length === 0) {
      new import_obsidian.Notice("\u6CA1\u6709\u8BFB\u53D6\u5230\u672C\u673A\u6587\u4EF6\u8DEF\u5F84");
      return;
    }
    onSelect(paths);
    input.value = "";
  });
}
function collectFileInputPaths(files) {
  if (!files) return [];
  return Array.from(files).map((file) => getFilePath(file)).filter((path) => Boolean(path)).map((path) => pathToFileUrl(path));
}
function collectDroppedFileAttachments(dataTransfer) {
  if (!dataTransfer) return [];
  const paths = collectFileInputPaths(dataTransfer.files);
  const uriList = dataTransfer.getData("text/uri-list").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && isFileAttachmentUrl(line));
  const plainTextPaths = dataTransfer.getData("text/plain").split(/\r?\n/).map((line) => line.trim()).filter((line) => parseLocalFilePath(line));
  return Array.from(/* @__PURE__ */ new Set([...paths, ...uriList, ...plainTextPaths]));
}
function getFilePath(file) {
  const maybePath = file.path;
  return typeof maybePath === "string" && maybePath.trim() ? maybePath.trim() : null;
}
function appendAttachmentText(current, additions) {
  const next = additions.map((line) => line.trim()).filter(Boolean).join("\n");
  return [current.trim(), next].filter(Boolean).join("\n");
}
function removeMatchingAttachment(attachmentLines, link) {
  const next = [];
  let removed = false;
  for (const line of attachmentLines) {
    const cleaned = cleanupAttachmentLine(line);
    if (!removed && attachmentLineMatchesLink(cleaned, link)) {
      removed = true;
      continue;
    }
    if (cleaned) next.push(cleaned);
  }
  return next;
}
function attachmentLineMatchesLink(line, link) {
  const candidates = /* @__PURE__ */ new Set([link.url]);
  if (link.type === "file") {
    candidates.add(fileUrlToPath(link.url));
    candidates.add(pathToFileUrl(link.url));
  }
  for (const candidate of candidates) {
    if (candidate && line.includes(candidate)) return true;
  }
  const localFile = extractLocalFileAttachment(line);
  return localFile?.url === link.url;
}
async function ensureFolder(app, folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}
function compareTasks(a, b) {
  return a.file.path.localeCompare(b.file.path) || a.line - b.line;
}
function findLastDifferentTask(tasks, taskId) {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].id !== taskId) return tasks[i];
  }
  return null;
}
function getInsertPosition(card, event) {
  const rect = card.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}
function normalizeTaskOrder(order) {
  return {
    foreground: Array.isArray(order?.foreground) ? order.foreground : [],
    agent: Array.isArray(order?.agent) ? order.agent : [],
    collab: Array.isArray(order?.collab) ? order.collab : [],
    inqueue: Array.isArray(order?.inqueue) ? order.inqueue : [],
    pool: Array.isArray(order?.pool) ? order.pool : []
  };
}
function buildTaskId(filePath, line, raw, categoryTags) {
  const stableRaw = removeCategoryTags(raw, categoryTags).replace(/\s{2,}/g, " ").trim();
  return `${filePath}:${line + 1}:${hashString(stableRaw)}`;
}
function removeCategoryTags(line, tags) {
  return removeTag(removeTag(removeTag(removeTag(line, tags.foreground), tags.agent), tags.collab), tags.inqueue);
}
function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) + hash ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
function extractTags(raw) {
  const tags = [];
  const re = /#([a-zA-Z0-9_/\-\u4e00-\u9fff]+)/g;
  let match;
  while ((match = re.exec(raw)) !== null) tags.push(match[1]);
  return Array.from(new Set(tags));
}
function extractCollaborators(raw) {
  const collaborators = [];
  const re = /@([a-zA-Z0-9_\-\u4e00-\u9fff]+)/g;
  let match;
  while ((match = re.exec(raw)) !== null) collaborators.push(match[1]);
  return Array.from(new Set(collaborators));
}
function extractLinks(lines) {
  const links = [];
  const seen = /* @__PURE__ */ new Set();
  const markdownLinkRe = /\[([^\]]+)\]((?:\((https?:\/\/[^\s)]+|obsidian:\/\/[^\s)]+|file:\/\/[^\s)]+)\)))/g;
  const urlRe = /(https?:\/\/[^\s<>)\]]+|obsidian:\/\/[^\s<>)\]]+|file:\/\/[^\s<>)\]]+)/g;
  for (const line of lines) {
    let markdownMatch;
    while ((markdownMatch = markdownLinkRe.exec(line)) !== null) {
      const url = trimUrl(markdownMatch[3]);
      if (!seen.has(url)) {
        links.push({ label: markdownMatch[1].trim() || linkFallbackLabel(url), url, type: isFileAttachmentUrl(url) ? "file" : "url" });
        seen.add(url);
      }
    }
    let urlMatch;
    while ((urlMatch = urlRe.exec(line)) !== null) {
      const url = trimUrl(urlMatch[1]);
      if (!seen.has(url)) {
        links.push({ label: inferLinkLabel(line, url), url, type: isFileAttachmentUrl(url) ? "file" : "url" });
        seen.add(url);
      }
    }
    const localFile = extractLocalFileAttachment(line);
    if (localFile && !seen.has(localFile.url)) {
      links.push(localFile);
      seen.add(localFile.url);
    }
  }
  return links;
}
function extractLocalFileAttachment(line) {
  const cleaned = cleanupAttachmentLine(line);
  if (hasUrlScheme(cleaned) && !isFileAttachmentUrl(cleaned)) return null;
  const stripped = stripAttachmentLabel(cleaned);
  const path = parseLocalFilePath(cleaned) ?? (stripped === cleaned ? null : parseLocalFilePath(stripped));
  if (!path) return null;
  return {
    label: inferLocalFileLabel(cleaned, path),
    url: path,
    type: "file"
  };
}
function parseLocalFilePath(value) {
  const cleaned = trimUrl(value.trim());
  if (isFileAttachmentUrl(cleaned)) return cleaned;
  return null;
}
function stripAttachmentLabel(value) {
  if (hasUrlScheme(value)) return value;
  return value.replace(/^[^:：]{1,40}[:：]\s*/, "");
}
function inferLocalFileLabel(line, path) {
  const beforePath = line.includes(path) ? line.slice(0, line.indexOf(path)) : "";
  const cleaned = cleanupAttachmentLine(beforePath).replace(/[:：-]\s*$/, "").trim();
  return cleaned || linkFallbackLabel(path);
}
async function openAttachment(link) {
  if (link.type !== "file") {
    window.open(link.url, "_blank");
    return;
  }
  const shell = getElectronShell();
  if (shell) {
    const target = fileUrlToPath(link.url);
    const error = await shell.openPath(target);
    if (error) new import_obsidian.Notice(`\u65E0\u6CD5\u6253\u5F00\u9644\u4EF6\uFF1A${error}`);
    return;
  }
  window.open(isFileAttachmentUrl(link.url) ? link.url : pathToFileUrl(link.url), "_blank");
}
function getElectronShell() {
  const req = window.require;
  if (!req) return null;
  try {
    const electron = req("electron");
    return electron.shell ?? null;
  } catch {
    return null;
  }
}
function inferLinkLabel(line, url) {
  const beforeUrl = line.slice(0, line.indexOf(url));
  const cleaned = cleanupAttachmentLine(beforeUrl).replace(/\[[^\]]+\]\($/, "").replace(/[:：-]\s*$/, "").trim();
  return cleaned || linkFallbackLabel(url);
}
function linkFallbackLabel(url) {
  if (isFileAttachmentUrl(url) || parseLocalFilePath(url)) {
    const path = fileUrlToPath(url);
    return path.split(/[\\/]/).filter(Boolean).pop() || path.slice(0, 60);
  }
  try {
    const parsed = new URL(url);
    return parsed.hostname || url.slice(0, 60);
  } catch {
    return url.slice(0, 60);
  }
}
function trimUrl(url) {
  return url.replace(/[.,;，。；]+$/, "");
}
function isFileAttachmentUrl(value) {
  return /^file:\/\//i.test(value);
}
function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}
function fileUrlToPath(value) {
  if (!isFileAttachmentUrl(value)) return value;
  try {
    const parsed = new URL(value);
    return decodeURIComponent(parsed.pathname.replace(/^\/([a-zA-Z]:[\\/])/, "$1"));
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
}
function pathToFileUrl(path) {
  if (isFileAttachmentUrl(path)) return path;
  const normalized = path.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`;
  return `file://${encodeURI(normalized)}`;
}
function extractDate(raw, key, icons) {
  const kvRe = new RegExp(`\\b${escapeReg(key)}::?\\s*(?:\\[\\[\\s*)?(${DATE_TIME_REGEX_FRAGMENT})(?:\\s*\\]\\])?`, "i");
  const kvMatch = kvRe.exec(raw);
  if (kvMatch) return parseDateString(kvMatch[1]);
  for (const icon of icons) {
    const iconRe = new RegExp(`${escapeReg(icon)}\\s*(?:\\[\\[\\s*)?(${DATE_TIME_REGEX_FRAGMENT})(?:\\s*\\]\\])?`, "i");
    const iconMatch = iconRe.exec(raw);
    if (iconMatch) return parseDateString(iconMatch[1]);
  }
  return null;
}
function parseDateString(value) {
  const parsed = (0, import_obsidian.moment)(value.trim(), STRICT_DATE_FORMATS, true);
  if (parsed.isValid()) return parsed.toDate();
  const iso = (0, import_obsidian.moment)(value.trim(), import_obsidian.moment.ISO_8601, true);
  return iso.isValid() ? iso.toDate() : null;
}
function cleanupTaskText(raw) {
  return raw.replace(new RegExp(`\\b(?:created|start|due)::?\\s*(?:\\[\\[\\s*)?${DATE_TIME_REGEX_FRAGMENT}(?:\\s*\\]\\])?`, "ig"), "").replace(new RegExp(`[\u{1F4CB}\u{1F6EB}\u23F3\u{1F4C5}]\\s*(?:\\[\\[\\s*)?${DATE_TIME_REGEX_FRAGMENT}(?:\\s*\\]\\])?`, "ig"), "").replace(/#([a-zA-Z0-9_/\-\u4e00-\u9fff]+)/g, "").replace(/@[a-zA-Z0-9_\-\u4e00-\u9fff]+/g, "").replace(/\s{2,}/g, " ").trim();
}
function createChip(text, cls) {
  const chip = createSpan({ cls: `atb-chip ${cls}` });
  chip.setText(text);
  return chip;
}
function containsTag(raw, tag) {
  return new RegExp(`(^|\\s)${escapeReg(prefixHash(tag))}(?=\\s|$)`, "i").test(raw);
}
function removeTag(line, tag) {
  return line.replace(new RegExp(`\\s*${escapeReg(prefixHash(tag))}(?=\\s|$)`, "ig"), "");
}
function removeValue(values, value) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}
function prefixHash(tag) {
  const trimmed = tag.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}
function normalizePath(path) {
  return path.trim().replace(/^\/+/, "");
}
function squashSpaces(value) {
  return value.replace(/\s{2,}/g, " ").trim();
}
function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function getTagColorIndex(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash << 5) - hash + tag.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) % 8;
}
//# sourceMappingURL=main.js.map
