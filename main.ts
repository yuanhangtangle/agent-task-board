import {
  App,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  moment
} from "obsidian";

const VIEW_TYPE_AGENT_TASK_BOARD = "agent-task-board-view";

type Category = "foreground" | "agent" | "collab" | "inqueue" | "pool";
type FilterMode = "AND" | "OR";
type InsertPosition = "before" | "after" | "end";

interface AgentTaskBoardSettings {
  scanPathPatterns: string[];
  inboxFile: string;
  completedTaskFile: string;
  foregroundTag: string;
  agentTag: string;
  collabTag: string;
  inqueueTag: string;
  dateFormat: string;
  density: "comfortable" | "compact";
  moveCompletedTasks: boolean;
  taskOrder: Record<Category, string[]>;
}

const DEFAULT_SETTINGS: AgentTaskBoardSettings = {
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

interface TaskItem {
  id: string;
  text: string;
  rawText: string;
  file: TFile;
  line: number;
  blockEndLine: number;
  category: Category;
  tags: string[];
  collaborators: string[];
  links: TaskLink[];
  attachmentLines: string[];
  created?: Date;
  due?: Date;
  start?: Date;
  originalLine: string;
  originalBlock: string[];
}

interface DragPayload {
  id: string;
  filePath: string;
  line: number;
  originalLine: string;
  originalBlock: string[];
  category: Category;
}

interface TaskLink {
  label: string;
  url: string;
  type: "url" | "file";
}

const CATEGORY_LABELS: Record<Category, string> = {
  foreground: "前台任务",
  agent: "Agent 任务",
  collab: "协作任务",
  inqueue: "入队任务",
  pool: "任务池"
};

export default class AgentTaskBoardPlugin extends Plugin {
  settings: AgentTaskBoardSettings;

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

  getCategoryTags(): Record<Exclude<Category, "pool">, string> {
    return {
      foreground: prefixHash(this.settings.foregroundTag),
      agent: prefixHash(this.settings.agentTag),
      collab: prefixHash(this.settings.collabTag),
      inqueue: prefixHash(this.settings.inqueueTag)
    };
  }

  async collectTasks(): Promise<TaskItem[]> {
    const tasks: TaskItem[] = [];
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
        const created = extractDate(raw, "created", ["📋"]);
        const start = extractDate(raw, "start", ["🛫", "⏳"]);
        const due = extractDate(raw, "due", ["📅"]);
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
          created: created ?? undefined,
          start: start ?? undefined,
          due: due ?? undefined,
          originalLine: line,
          originalBlock
        });
      }
    }

    return tasks;
  }

  async createTask(text: string, category: Category, targetFilePath?: string, attachmentText = "") {
    const cleaned = text.trim();
    if (!cleaned) return;

    const path = normalizePath(targetFilePath || this.settings.inboxFile);
    if (!path) {
      new Notice("请先设置默认 Inbox 文件");
      return;
    }

    const block = [
      buildTaskLine(cleaned, category, this.getCategoryTags()),
      ...normalizeAttachmentInput(attachmentText)
    ];
    const file = await this.ensureMarkdownFile(path);
    await this.app.vault.process(file, (data) => appendBlock(data, block));
    this.refreshView();
    new Notice("已创建任务");
  }

  async updateTask(task: TaskItem, rawText: string, attachmentText: string) {
    const categoryTags = this.getCategoryTags();
    const nextRaw = rawText.trim();
    if (!nextRaw) {
      new Notice("任务内容不能为空");
      return;
    }

    const nextBlock = [
      buildTaskLine(nextRaw, task.category, categoryTags),
      ...attachmentText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `  - ${line.replace(/^[-*]\s+/, "")}`)
    ];

    await this.replaceTaskBlock(task, nextBlock);
    this.refreshView();
    new Notice("已更新任务");
  }

  async appendTaskAttachments(task: TaskItem, attachmentLines: string[]) {
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
    new Notice(`已添加 ${attachmentLines.length} 个附件`);
  }

  async deleteTaskAttachment(task: TaskItem, link: TaskLink) {
    const nextAttachments = removeMatchingAttachment(task.attachmentLines, link);
    if (nextAttachments.length === task.attachmentLines.length) {
      new Notice("未找到对应附件行");
      return;
    }

    const nextBlock = [
      buildTaskLine(task.rawText, task.category, this.getCategoryTags()),
      ...normalizeAttachmentInput(nextAttachments.join("\n"))
    ];

    await this.replaceTaskBlock(task, nextBlock);
    this.refreshView();
    new Notice("已删除附件");
  }

  async deleteTask(task: TaskItem) {
    await this.removeTaskBlock(task);
    this.refreshView();
    new Notice("已删除任务");
  }

  async completeTask(task: TaskItem) {
    const today = moment().format(this.settings.dateFormat);
    const completedBlock = [...task.originalBlock];
    let completedLine = completedBlock[0].replace(/^(\s*[-*]\s+\[)\s(\]\s+)/, "$1x$2");
    completedLine = completedLine.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/, "");
    completedBlock[0] = `${completedLine} ✅ ${today} <!-- from: ${task.file.path}:${task.line + 1} -->`;

    if (this.settings.moveCompletedTasks && this.settings.completedTaskFile.trim()) {
      const completedFile = await this.ensureMarkdownFile(normalizePath(this.settings.completedTaskFile));
      await this.removeTaskBlock(task);
      await this.app.vault.process(completedFile, (data) => appendBlock(data, completedBlock));
      new Notice("已完成并移动到归档文件");
    } else {
      await this.replaceTaskBlock(task, completedBlock);
      new Notice("已标记完成");
    }
    this.refreshView();
  }

  async setTaskCategory(task: TaskItem, category: Category) {
    const categoryTags = this.getCategoryTags();
    await this.transformTaskLine(task, (line) => setCategoryTag(line, category, categoryTags));
    this.refreshView();
    new Notice(`已移动到${CATEGORY_LABELS[category]}`);
  }

  async moveTask(task: TaskItem, category: Category, targetId: string | null, position: InsertPosition) {
    const categoryTags = this.getCategoryTags();
    if (task.category !== category) {
      await this.transformTaskLine(task, (line) => setCategoryTag(line, category, categoryTags));
    }
    this.setOrderPosition(task.id, category, targetId, position);
    await this.saveSettings();
    new Notice(`已移动到${CATEGORY_LABELS[category]}`);
  }

  async moveTaskLine(task: TaskItem, category: Category, targetTask: TaskItem | null, position: InsertPosition) {
    const categoryTags = this.getCategoryTags();
    const rewriteBlock = (block: string[]) => {
      const next = [...block];
      next[0] = setCategoryTag(next[0], category, categoryTags);
      return next;
    };

    if (targetTask && task.id === targetTask.id) return;

    if (!targetTask) {
      await this.replaceTaskBlock(task, rewriteBlock(task.originalBlock));
      this.refreshView();
      new Notice(`已移动到${CATEGORY_LABELS[category]}`);
      return;
    }

    if (task.file.path === targetTask.file.path) {
      await this.app.vault.process(task.file, (data) => {
        const lines = data.split(/\r?\n/);
        const sourceIdx = findCurrentTaskLine(lines, task);
        if (sourceIdx < 0) {
          new Notice("任务源行已变化，未移动");
          return data;
        }

        const sourceRange = getTaskBlockRange(lines, sourceIdx);
        const sourceBlock = lines.splice(sourceIdx, sourceRange.end - sourceIdx + 1);
        const targetIdx = findCurrentTaskLine(lines, targetTask);
        if (targetIdx < 0) {
          new Notice("目标任务源行已变化，未移动");
          lines.splice(sourceIdx, 0, ...sourceBlock);
          return lines.join("\n");
        }
        const targetRange = getTaskBlockRange(lines, targetIdx);
        const insertIdx = position === "before" ? targetIdx : targetRange.end + 1;
        lines.splice(insertIdx, 0, ...rewriteBlock(sourceBlock));
        return lines.join("\n");
      });
    } else {
      let movedBlock: string[] | null = null;

      await this.app.vault.process(task.file, (data) => {
        const lines = data.split(/\r?\n/);
        const sourceIdx = findCurrentTaskLine(lines, task);
        if (sourceIdx < 0) {
          new Notice("任务源行已变化，未移动");
          return data;
        }
        const sourceRange = getTaskBlockRange(lines, sourceIdx);
        movedBlock = rewriteBlock(lines.splice(sourceIdx, sourceRange.end - sourceIdx + 1));
        return lines.join("\n");
      });

      if (!movedBlock) return;
      const blockToInsert = movedBlock as string[];

      await this.app.vault.process(targetTask.file, (data) => {
        const lines = data.split(/\r?\n/);
        const targetIdx = findCurrentTaskLine(lines, targetTask);
        if (targetIdx < 0) {
          new Notice("目标任务源行已变化，未插入");
          return appendBlock(data, blockToInsert);
        }
        const targetRange = getTaskBlockRange(lines, targetIdx);
        const insertIdx = position === "before" ? targetIdx : targetRange.end + 1;
        lines.splice(insertIdx, 0, ...blockToInsert);
        return lines.join("\n");
      });
    }

    this.refreshView();
    new Notice(`已移动到${CATEGORY_LABELS[category]}`);
  }

  syncTaskOrder(tasks: TaskItem[]) {
    const presentIds = new Set(tasks.map((task) => task.id));
    let changed = false;

    for (const category of Object.keys(CATEGORY_LABELS) as Category[]) {
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

  private setOrderPosition(taskId: string, category: Category, targetId: string | null, position: InsertPosition) {
    for (const key of Object.keys(CATEGORY_LABELS) as Category[]) {
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

  private async transformTaskLine(task: TaskItem, replacer: (line: string) => string) {
    await this.app.vault.process(task.file, (data) => {
      const lines = data.split(/\r?\n/);
      const idx = findCurrentTaskLine(lines, task);
      if (idx < 0) {
        new Notice("任务源行已变化，未写回");
        return data;
      }
      lines[idx] = replacer(lines[idx]);
      return lines.join("\n");
    });
  }

  private async removeOriginalLine(task: TaskItem) {
    await this.removeTaskBlock(task);
  }

  private async replaceTaskBlock(task: TaskItem, nextBlock: string[]) {
    await this.app.vault.process(task.file, (data) => {
      const lines = data.split(/\r?\n/);
      const idx = findCurrentTaskLine(lines, task);
      if (idx < 0) {
        new Notice("任务源行已变化，未写回");
        return data;
      }
      const range = getTaskBlockRange(lines, idx);
      lines.splice(idx, range.end - idx + 1, ...nextBlock);
      return lines.join("\n");
    });
  }

  private async removeTaskBlock(task: TaskItem) {
    await this.app.vault.process(task.file, (data) => {
      const lines = data.split(/\r?\n/);
      const idx = findCurrentTaskLine(lines, task);
      if (idx < 0) {
        new Notice("任务源行已变化，未删除原任务");
        return data;
      }
      const range = getTaskBlockRange(lines, idx);
      lines.splice(idx, range.end - idx + 1);
      return lines.join("\n");
    });
  }

  private async ensureMarkdownFile(path: string): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;

    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await ensureFolder(this.app, parent);
    return await this.app.vault.create(path, "");
  }
}

class AgentTaskBoardView extends ItemView {
  plugin: AgentTaskBoardPlugin;
  private filterTags: string[] = [];
  private excludeTags: string[] = [];
  private filterCollabs: string[] = [];
  private excludeCollabs: string[] = [];
  private filterMode: FilterMode = "OR";
  private expandedTaskIds = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: AgentTaskBoardPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_AGENT_TASK_BOARD; }
  getDisplayText(): string { return "Agent Task Board"; }
  getIcon(): string { return "list-checks"; }

  async onOpen() { await this.renderTasks(); }
  async onClose() {}

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
    const panels: Record<Category, { el: HTMLElement; list: HTMLElement; countEl: HTMLElement }> = {
      foreground: this.createPanel(grid, "前台任务", "atb-q-foreground", "foreground"),
      agent: this.createPanel(grid, "Agent 任务", "atb-q-agent", "agent"),
      collab: this.createPanel(grid, "协作任务", "atb-q-collab", "collab"),
      inqueue: this.createPanel(grid, "入队任务", "atb-q-inqueue", "inqueue"),
      pool: this.createPanel(grid, "任务池", "atb-q-pool", "pool")
    };

    const counters: Record<Category, number> = { foreground: 0, agent: 0, collab: 0, inqueue: 0, pool: 0 };
    const tasksByCategory: Record<Category, TaskItem[]> = { foreground: [], agent: [], collab: [], inqueue: [], pool: [] };
    for (const task of tasks) {
      counters[task.category]++;
      tasksByCategory[task.category].push(task);
      panels[task.category].list.appendChild(this.renderTaskCard(task));
    }
    (Object.keys(panels) as Category[]).forEach((category) => panels[category].countEl.setText(String(counters[category])));

    for (const [category, panel] of Object.entries(panels) as [Category, { el: HTMLElement; list: HTMLElement }][]) {
      panel.list.addEventListener("dragover", (ev: DragEvent) => {
        if ((ev.target as HTMLElement).closest(".atb-card")) return;
        ev.preventDefault();
        panel.el.addClass("drop-target");
      });
      panel.list.addEventListener("dragleave", () => panel.el.removeClass("drop-target"));
      panel.list.addEventListener("drop", async (ev: DragEvent) => {
        if ((ev.target as HTMLElement).closest(".atb-card")) return;
        ev.preventDefault();
        panel.el.removeClass("drop-target");
        const payload = ev.dataTransfer?.getData("application/json");
        if (!payload) return;

        try {
          const data = JSON.parse(payload) as DragPayload;
          const file = this.plugin.app.vault.getAbstractFileByPath(data.filePath);
          if (!(file instanceof TFile)) return;
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
          new Notice("拖拽写回失败");
        }
      });
    }
  }

  private renderTopbar(container: HTMLElement) {
    const topbar = container.createDiv({ cls: "atb-topbar" });
    topbar.createDiv({ cls: "atb-view-title", text: "Agent Task Board" });

    const addButton = topbar.createEl("button", { cls: "atb-primary-btn", text: "+" });
    addButton.setAttribute("aria-label", "新增任务");
    addButton.setAttribute("title", "新增任务");
    addButton.addEventListener("click", () => new CreateTaskModal(this.app, this.plugin).open());

    const refreshButton = topbar.createEl("button", { cls: "atb-icon-btn", text: "↻" });
    refreshButton.setAttribute("aria-label", "刷新");
    refreshButton.setAttribute("title", "刷新");
    refreshButton.addEventListener("click", () => this.renderTasks());
  }

  private createPanel(container: HTMLElement, title: string, cls: string, category: Category) {
    const panel = container.createDiv({ cls: `atb-panel ${cls}` });
    const header = panel.createDiv({ cls: "atb-panel-header" });
    header.createDiv({ cls: "atb-panel-title", text: title });
    const actions = header.createDiv({ cls: "atb-panel-actions" });
    const addButton = actions.createEl("button", { cls: "atb-panel-add", text: "+" });
    addButton.setAttribute("title", `新增${title}`);
    addButton.addEventListener("click", () => new CreateTaskModal(this.app, this.plugin, category).open());
    const countEl = actions.createDiv({ cls: "atb-count" });
    const list = panel.createDiv({ cls: "atb-list" });
    return { el: panel, list, countEl };
  }

  private renderTaskCard(task: TaskItem): HTMLElement {
    const tooltipParts = [
      task.file.path,
      `行 ${task.line + 1}`,
      task.due ? `截止 ${moment(task.due).format(this.plugin.settings.dateFormat)}` : "",
      task.created ? `创建 ${moment(task.created).format(this.plugin.settings.dateFormat)}` : ""
    ].filter(Boolean);

    const isExpanded = this.expandedTaskIds.has(task.id);
    const card = createDiv({ cls: `atb-card ${isExpanded ? "is-expanded" : ""}`, attr: { draggable: "true", title: tooltipParts.join(" · ") } });
    card.addEventListener("dragstart", (ev: DragEvent) => {
      ev.dataTransfer?.setData("application/json", JSON.stringify({
        id: task.id,
        filePath: task.file.path,
        line: task.line,
        originalLine: task.originalLine,
        originalBlock: task.originalBlock,
        category: task.category
      } satisfies DragPayload));
      ev.dataTransfer?.setData("text/plain", task.text);
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => {
      card.removeClass("is-dragging");
      card.removeClass("insert-before");
      card.removeClass("insert-after");
    });
    card.addEventListener("dragover", (ev: DragEvent) => {
      ev.preventDefault();
      const position = getInsertPosition(card, ev);
      card.toggleClass("insert-before", position === "before");
      card.toggleClass("insert-after", position === "after");
    });
    card.addEventListener("dragleave", () => {
      card.removeClass("insert-before");
      card.removeClass("insert-after");
    });
    card.addEventListener("drop", async (ev: DragEvent) => {
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
        const data = JSON.parse(payload) as DragPayload;
        if (data.id === task.id) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(data.filePath);
        if (!(file instanceof TFile)) return;
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
        new Notice("拖拽排序失败");
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
      const today = moment().startOf("day");
      const due = moment(task.due).startOf("day");
      const diff = due.diff(today, "days");
      const chip = createChip(diff < 0 ? `逾期${Math.abs(diff)}天` : diff === 0 ? "今天到期" : `${diff}天后到期`, diff <= 0 ? "atb-chip-danger" : "atb-chip-date");
      chips.appendChild(chip);
    }

    const footer = card.createDiv({ cls: "atb-card-footer" });
    const source = footer.createDiv({ cls: "atb-source", text: `${task.file.basename}:${task.line + 1}` });
    source.setAttribute("title", "打开源文件");
    source.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.openTaskSource(task);
    });
    const linkIndicator = footer.createEl("button", {
      cls: `atb-link-indicator ${task.links.length === 0 ? "is-empty" : ""}`,
      text: `附件 ${task.links.length}`
    });
    linkIndicator.setAttribute("title", isExpanded ? "收起附件" : "展开附件");
    linkIndicator.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.expandedTaskIds.has(task.id)) this.expandedTaskIds.delete(task.id);
      else this.expandedTaskIds.add(task.id);
      void this.renderTasks();
    });

    if (isExpanded) this.renderTaskDetails(card, task);
    return card;
  }

  private renderTaskDetails(card: HTMLElement, task: TaskItem) {
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
        const remove = row.createEl("button", { cls: "atb-link-remove", text: "×" });
        remove.setAttribute("title", "删除附件");
        remove.addEventListener("click", async (event) => {
          event.stopPropagation();
          await this.plugin.deleteTaskAttachment(task, link);
          await this.renderTasks();
        });
      }
    } else {
      details.createDiv({ cls: "atb-detail-empty", text: "无附件" });
    }

    const actions = details.createDiv({ cls: "atb-detail-actions" });
    const editButton = actions.createEl("button", { text: "编辑" });
    editButton.addEventListener("click", (event) => {
      event.stopPropagation();
      new EditTaskModal(this.app, this.plugin, task).open();
    });

  }

  private async openTaskSource(task: TaskItem) {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(task.file);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    view.editor.setCursor({ line: task.line, ch: 0 });
    view.editor.scrollIntoView({ from: { line: task.line, ch: 0 }, to: { line: task.line + 1, ch: 0 } }, true);
  }

  private renderFilterToolbar(container: HTMLElement, allTasks: TaskItem[]) {
    const tags = Array.from(new Set(allTasks.flatMap((task) => task.tags))).sort();
    const collaborators = Array.from(new Set(allTasks.flatMap((task) => task.collaborators))).sort();

    const toolbar = container.createDiv({ cls: "atb-filter-toolbar" });
    const activeFilters = this.filterTags.length + this.excludeTags.length + this.filterCollabs.length + this.excludeCollabs.length;

    if (this.filterTags.length >= 2) {
      const modeButton = toolbar.createEl("button", { cls: "atb-filter-mode", text: this.filterMode });
      modeButton.setAttribute("title", this.filterMode === "AND" ? "所有标签都匹配" : "任一标签匹配");
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
      const clearButton = toolbar.createEl("button", { cls: "atb-clear-filter", text: "清除" });
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

  private renderFilterChip(container: HTMLElement, name: string, prefix: "#" | "@", isExclude: boolean, includeList: string[], excludeList: string[], type: "tag" | "collab") {
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
    const remove = chip.createSpan({ cls: "atb-chip-remove", text: "×" });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeValue(isExclude ? excludeList : includeList, name);
      void this.renderTasks();
    });
  }

  private renderFilterInput(container: HTMLElement, allTags: string[], allCollaborators: string[]) {
    const wrapper = container.createDiv({ cls: "atb-filter-input-wrap" });
    const input = wrapper.createEl("input", {
      cls: "atb-filter-input",
      attr: { type: "text", placeholder: "筛选 #tag / @who" }
    });
    const dropdown = wrapper.createDiv({ cls: "atb-filter-dropdown" });
    dropdown.style.display = "none";

    type Suggestion = { type: "tag" | "collab"; name: string };
    let selectedIndex = -1;
    let suggestions: Suggestion[] = [];

    const select = (suggestion: Suggestion) => {
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
        ...allTags
          .filter((tag) => !this.filterTags.includes(tag) && !this.excludeTags.includes(tag))
          .filter((tag) => tag.toLowerCase().includes(query))
          .map((name): Suggestion => ({ type: "tag", name })),
        ...allCollaborators
          .filter((collab) => !this.filterCollabs.includes(collab) && !this.excludeCollabs.includes(collab))
          .filter((collab) => collab.toLowerCase().includes(query))
          .map((name): Suggestion => ({ type: "collab", name }))
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

  private applyFilters(tasks: TaskItem[]) {
    const hasFilter = this.filterTags.length > 0 || this.excludeTags.length > 0 || this.filterCollabs.length > 0 || this.excludeCollabs.length > 0;
    if (!hasFilter) return tasks;

    return tasks.filter((task) => {
      if (this.excludeTags.some((tag) => task.tags.includes(tag))) return false;
      if (this.excludeCollabs.some((collab) => task.collaborators.includes(collab))) return false;

      const tagPass = this.filterTags.length === 0
        ? true
        : this.filterMode === "AND"
          ? this.filterTags.every((tag) => task.tags.includes(tag))
          : this.filterTags.some((tag) => task.tags.includes(tag));
      const collabPass = this.filterCollabs.length === 0
        ? true
        : this.filterCollabs.some((collab) => task.collaborators.includes(collab));

      return tagPass && collabPass;
    });
  }
}

class CreateTaskModal extends Modal {
  plugin: AgentTaskBoardPlugin;
  initialCategory: Category;
  taskText = "";
  attachmentText = "";
  category: Category;
  targetFile: string;

  constructor(app: App, plugin: AgentTaskBoardPlugin, initialCategory: Category = "foreground") {
    super(app);
    this.plugin = plugin;
    this.initialCategory = initialCategory;
    this.category = initialCategory;
    this.targetFile = plugin.settings.inboxFile;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("atb-create-modal");
    contentEl.createEl("h2", { text: "新增任务" });

    new Setting(contentEl)
      .setName("任务")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.setValue(this.taskText);
        text.setPlaceholder("写下要处理的 TODO，可包含 #tag 和 @who");
        text.onChange((value) => this.taskText = value);
        window.setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .setName("附件")
      .setDesc("每行一个链接、本机文件或说明，会写成任务下方的缩进子项。")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.setValue(this.attachmentText);
        text.setPlaceholder("PR: https://...\n本机文件: file:///Users/...");
        text.onChange((value) => this.attachmentText = value);
      });

    addLocalFilePicker(contentEl, (paths) => {
      this.attachmentText = appendAttachmentText(this.attachmentText, paths);
      this.onOpen();
    });

    new Setting(contentEl)
      .setName("分类")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("foreground", "前台任务")
          .addOption("agent", "Agent 任务")
          .addOption("collab", "协作任务")
          .addOption("inqueue", "入队任务")
          .addOption("pool", "任务池")
          .setValue(this.category)
          .onChange((value: Category) => this.category = value);
      });

    new Setting(contentEl)
      .setName("目标文件")
      .addText((text) => {
        text.setValue(this.targetFile);
        text.onChange((value) => this.targetFile = value.trim());
      });

    const buttons = contentEl.createDiv({ cls: "atb-modal-buttons" });
    const createButton = buttons.createEl("button", { cls: "mod-cta", text: "创建" });
    createButton.addEventListener("click", async () => {
      await this.plugin.createTask(this.taskText, this.category, this.targetFile, this.attachmentText);
      this.close();
    });
    const cancelButton = buttons.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class EditTaskModal extends Modal {
  plugin: AgentTaskBoardPlugin;
  task: TaskItem;
  rawText: string;
  attachmentText: string;

  constructor(app: App, plugin: AgentTaskBoardPlugin, task: TaskItem) {
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
    contentEl.createEl("h2", { text: "编辑任务" });

    new Setting(contentEl)
      .setName("任务")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.setValue(this.rawText);
        text.onChange((value) => this.rawText = value);
        window.setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .setName("附件")
      .setDesc("每行一个链接、本机文件或说明，会写成任务下方的缩进子项。")
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.setValue(this.attachmentText);
        text.onChange((value) => this.attachmentText = value);
      });

    addLocalFilePicker(contentEl, (paths) => {
      this.attachmentText = appendAttachmentText(this.attachmentText, paths);
      this.onOpen();
    });

    const buttons = contentEl.createDiv({ cls: "atb-modal-buttons" });
    const saveButton = buttons.createEl("button", { cls: "mod-cta", text: "保存" });
    saveButton.addEventListener("click", async () => {
      await this.plugin.updateTask(this.task, this.rawText, this.attachmentText);
      this.close();
    });
    const cancelButton = buttons.createEl("button", { text: "取消" });
    cancelButton.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AgentTaskBoardSettingTab extends PluginSettingTab {
  plugin: AgentTaskBoardPlugin;

  constructor(app: App, plugin: AgentTaskBoardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Agent Task Board 设置" });

    new Setting(containerEl)
      .setName("扫描路径正则")
      .setDesc("每行一个 vault 相对路径正则。留空表示扫描所有 Markdown 文件。")
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.setValue(this.plugin.settings.scanPathPatterns.join("\n"));
        text.onChange(async (value) => {
          this.plugin.settings.scanPathPatterns = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("默认 Inbox 文件")
      .setDesc("插件中新建任务时默认追加到这里。")
      .addText((text) => text
        .setValue(this.plugin.settings.inboxFile)
        .onChange(async (value) => {
          this.plugin.settings.inboxFile = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("完成任务文件")
      .setDesc("勾选完成后移动到这里。")
      .addText((text) => text
        .setValue(this.plugin.settings.completedTaskFile)
        .onChange(async (value) => {
          this.plugin.settings.completedTaskFile = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("完成后移动")
      .setDesc("关闭后只在原文件标记为完成。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.moveCompletedTasks)
        .onChange(async (value) => {
          this.plugin.settings.moveCompletedTasks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("前台任务标签")
      .addText((text) => text
        .setValue(this.plugin.settings.foregroundTag)
        .onChange(async (value) => {
          this.plugin.settings.foregroundTag = value.trim() || "#foreground";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Agent 任务标签")
      .addText((text) => text
        .setValue(this.plugin.settings.agentTag)
        .onChange(async (value) => {
          this.plugin.settings.agentTag = value.trim() || "#agent";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("协作任务标签")
      .addText((text) => text
        .setValue(this.plugin.settings.collabTag)
        .onChange(async (value) => {
          this.plugin.settings.collabTag = value.trim() || "#collab";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("入队任务标签")
      .addText((text) => text
        .setValue(this.plugin.settings.inqueueTag)
        .onChange(async (value) => {
          this.plugin.settings.inqueueTag = value.trim() || "#inqueue";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("日期格式")
      .addText((text) => text
        .setValue(this.plugin.settings.dateFormat)
        .onChange(async (value) => {
          this.plugin.settings.dateFormat = value.trim() || "YYYY-MM-DD";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("显示密度")
      .addDropdown((dropdown) => dropdown
        .addOption("comfortable", "舒适")
        .addOption("compact", "紧凑")
        .setValue(this.plugin.settings.density)
        .onChange(async (value: "comfortable" | "compact") => {
          this.plugin.settings.density = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "分类冲突优先级固定为：#foreground > #agent > #collab > #inqueue > 无标签。拖拽会先移除四个分类标签，再写入目标分类标签。"
    });
  }
}

const DATE_TIME_REGEX_FRAGMENT = "\\d{4}-\\d{2}-\\d{2}(?:[ T]\\d{2}:\\d{2}(?::\\d{2})?)?";
const STRICT_DATE_FORMATS = [
  "YYYY-MM-DD",
  "YYYY-MM-DD HH:mm",
  "YYYY-MM-DD HH:mm:ss",
  "YYYY-MM-DDTHH:mm",
  "YYYY-MM-DDTHH:mm:ss"
];

function compilePathMatchers(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern);
    } catch {
      new Notice(`无效路径正则：${pattern}`);
      return null;
    }
  }).filter((re): re is RegExp => re !== null);
}

function classifyTask(raw: string, tags: Record<Exclude<Category, "pool">, string>): Category {
  if (containsTag(raw, tags.foreground)) return "foreground";
  if (containsTag(raw, tags.agent)) return "agent";
  if (containsTag(raw, tags.collab)) return "collab";
  if (containsTag(raw, tags.inqueue)) return "inqueue";
  return "pool";
}

function setCategoryTag(line: string, category: Category, tags: Record<Exclude<Category, "pool">, string>) {
  let next = removeCategoryTags(line, tags);
  if (category !== "pool") next = `${next.trim()} ${tags[category]}`;
  return squashSpaces(next);
}

function buildTaskLine(text: string, category: Category, tags: Record<Exclude<Category, "pool">, string>) {
  let line = text.replace(/^[-*]\s+\[[ xX]\]\s+/, "").trim();
  line = setCategoryTag(`- [ ] ${line}`, category, tags);
  return line;
}

function findCurrentTaskLine(lines: string[], task: TaskItem) {
  if (lines[task.line] === task.originalLine) return task.line;
  const start = Math.max(0, task.line - 5);
  const end = Math.min(lines.length, task.line + 6);
  for (let i = start; i < end; i++) {
    if (lines[i] === task.originalLine) return i;
  }
  return lines.findIndex((line) => line === task.originalLine);
}

function appendLine(data: string, line: string) {
  const trimmedEnd = data.replace(/\s*$/, "");
  return trimmedEnd ? `${trimmedEnd}\n${line}\n` : `${line}\n`;
}

function appendBlock(data: string, block: string[]) {
  return appendLine(data, block.join("\n"));
}

function getTaskBlockRange(lines: string[], startIdx: number) {
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

function getIndentLength(line: string) {
  return /^(\s*)/.exec(line)?.[1].length ?? 0;
}

function normalizeAttachmentInput(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `  - ${line.replace(/^[-*]\s+/, "")}`);
}

function cleanupAttachmentLine(line: string) {
  return line.trim().replace(/^[-*]\s+/, "").trim();
}

function addLocalFilePicker(container: HTMLElement, onSelect: (paths: string[]) => void) {
  const wrapper = container.createDiv({ cls: "atb-file-picker" });
  const button = wrapper.createEl("button", { type: "button", text: "添加本机文件" });
  const hint = wrapper.createSpan({ text: "也可以把文件拖到任务卡片上" });
  const input = wrapper.createEl("input", { type: "file" });
  input.multiple = true;
  input.style.display = "none";

  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const paths = collectFileInputPaths(input.files);
    if (paths.length === 0) {
      new Notice("没有读取到本机文件路径");
      return;
    }
    onSelect(paths);
    input.value = "";
  });
}

function collectFileInputPaths(files: FileList | null) {
  if (!files) return [];
  return Array.from(files)
    .map((file) => getFilePath(file))
    .filter((path): path is string => Boolean(path))
    .map((path) => pathToFileUrl(path));
}

function collectDroppedFileAttachments(dataTransfer: DataTransfer | null | undefined) {
  if (!dataTransfer) return [];

  const paths = collectFileInputPaths(dataTransfer.files);
  const uriList = dataTransfer.getData("text/uri-list")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && isFileAttachmentUrl(line));
  const plainTextPaths = dataTransfer.getData("text/plain")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => parseLocalFilePath(line));

  return Array.from(new Set([...paths, ...uriList, ...plainTextPaths]));
}

function getFilePath(file: File) {
  const maybePath = (file as File & { path?: string }).path;
  return typeof maybePath === "string" && maybePath.trim() ? maybePath.trim() : null;
}

function appendAttachmentText(current: string, additions: string[]) {
  const next = additions.map((line) => line.trim()).filter(Boolean).join("\n");
  return [current.trim(), next].filter(Boolean).join("\n");
}

function removeMatchingAttachment(attachmentLines: string[], link: TaskLink) {
  const next: string[] = [];
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

function attachmentLineMatchesLink(line: string, link: TaskLink) {
  const candidates = new Set<string>([link.url]);
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

async function ensureFolder(app: App, folderPath: string) {
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}

function compareTasks(a: TaskItem, b: TaskItem) {
  return a.file.path.localeCompare(b.file.path) || a.line - b.line;
}

function findLastDifferentTask(tasks: TaskItem[], taskId: string): TaskItem | null {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].id !== taskId) return tasks[i];
  }
  return null;
}

function getInsertPosition(card: HTMLElement, event: DragEvent): Exclude<InsertPosition, "end"> {
  const rect = card.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function normalizeTaskOrder(order: Partial<Record<Category, string[]>> | undefined): Record<Category, string[]> {
  return {
    foreground: Array.isArray(order?.foreground) ? order.foreground : [],
    agent: Array.isArray(order?.agent) ? order.agent : [],
    collab: Array.isArray(order?.collab) ? order.collab : [],
    inqueue: Array.isArray(order?.inqueue) ? order.inqueue : [],
    pool: Array.isArray(order?.pool) ? order.pool : []
  };
}

function buildTaskId(filePath: string, line: number, raw: string, categoryTags: Record<Exclude<Category, "pool">, string>) {
  const stableRaw = removeCategoryTags(raw, categoryTags)
    .replace(/\s{2,}/g, " ")
    .trim();
  return `${filePath}:${line + 1}:${hashString(stableRaw)}`;
}

function removeCategoryTags(line: string, tags: Record<Exclude<Category, "pool">, string>) {
  return removeTag(removeTag(removeTag(removeTag(line, tags.foreground), tags.agent), tags.collab), tags.inqueue);
}

function hashString(value: string) {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function extractTags(raw: string): string[] {
  const tags: string[] = [];
  const re = /#([a-zA-Z0-9_/\-\u4e00-\u9fff]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) tags.push(match[1]);
  return Array.from(new Set(tags));
}

function extractCollaborators(raw: string): string[] {
  const collaborators: string[] = [];
  const re = /@([a-zA-Z0-9_\-\u4e00-\u9fff]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) collaborators.push(match[1]);
  return Array.from(new Set(collaborators));
}

function extractLinks(lines: string[]): TaskLink[] {
  const links: TaskLink[] = [];
  const seen = new Set<string>();
  const markdownLinkRe = /\[([^\]]+)\]((?:\((https?:\/\/[^\s)]+|obsidian:\/\/[^\s)]+|file:\/\/[^\s)]+)\)))/g;
  const urlRe = /(https?:\/\/[^\s<>)\]]+|obsidian:\/\/[^\s<>)\]]+|file:\/\/[^\s<>)\]]+)/g;

  for (const line of lines) {
    let markdownMatch: RegExpExecArray | null;
    while ((markdownMatch = markdownLinkRe.exec(line)) !== null) {
      const url = trimUrl(markdownMatch[3]);
      if (!seen.has(url)) {
        links.push({ label: markdownMatch[1].trim() || linkFallbackLabel(url), url, type: isFileAttachmentUrl(url) ? "file" : "url" });
        seen.add(url);
      }
    }

    let urlMatch: RegExpExecArray | null;
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

function extractLocalFileAttachment(line: string): TaskLink | null {
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

function parseLocalFilePath(value: string) {
  const cleaned = trimUrl(value.trim());
  if (isFileAttachmentUrl(cleaned)) return cleaned;
  return null;
}

function stripAttachmentLabel(value: string) {
  if (hasUrlScheme(value)) return value;
  return value.replace(/^[^:：]{1,40}[:：]\s*/, "");
}

function inferLocalFileLabel(line: string, path: string) {
  const beforePath = line.includes(path) ? line.slice(0, line.indexOf(path)) : "";
  const cleaned = cleanupAttachmentLine(beforePath).replace(/[:：-]\s*$/, "").trim();
  return cleaned || linkFallbackLabel(path);
}

async function openAttachment(link: TaskLink) {
  if (link.type !== "file") {
    window.open(link.url, "_blank");
    return;
  }

  const shell = getElectronShell();
  if (shell) {
    const target = fileUrlToPath(link.url);
    const error = await shell.openPath(target);
    if (error) new Notice(`无法打开附件：${error}`);
    return;
  }

  window.open(isFileAttachmentUrl(link.url) ? link.url : pathToFileUrl(link.url), "_blank");
}

function getElectronShell(): { openPath: (path: string) => Promise<string> } | null {
  const req = (window as Window & { require?: (id: string) => unknown }).require;
  if (!req) return null;
  try {
    const electron = req("electron") as { shell?: { openPath: (path: string) => Promise<string> } };
    return electron.shell ?? null;
  } catch {
    return null;
  }
}

function inferLinkLabel(line: string, url: string) {
  const beforeUrl = line.slice(0, line.indexOf(url));
  const cleaned = cleanupAttachmentLine(beforeUrl)
    .replace(/\[[^\]]+\]\($/, "")
    .replace(/[:：-]\s*$/, "")
    .trim();
  return cleaned || linkFallbackLabel(url);
}

function linkFallbackLabel(url: string) {
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

function trimUrl(url: string) {
  return url.replace(/[.,;，。；]+$/, "");
}

function isFileAttachmentUrl(value: string) {
  return /^file:\/\//i.test(value);
}

function hasUrlScheme(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function fileUrlToPath(value: string) {
  if (!isFileAttachmentUrl(value)) return value;
  try {
    const parsed = new URL(value);
    return decodeURIComponent(parsed.pathname.replace(/^\/([a-zA-Z]:[\\/])/, "$1"));
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
}

function pathToFileUrl(path: string) {
  if (isFileAttachmentUrl(path)) return path;
  const normalized = path.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`;
  return `file://${encodeURI(normalized)}`;
}

function extractDate(raw: string, key: string, icons: string[]): Date | null {
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

function parseDateString(value: string): Date | null {
  const parsed = moment(value.trim(), STRICT_DATE_FORMATS, true);
  if (parsed.isValid()) return parsed.toDate();
  const iso = moment(value.trim(), moment.ISO_8601, true);
  return iso.isValid() ? iso.toDate() : null;
}

function cleanupTaskText(raw: string) {
  return raw
    .replace(new RegExp(`\\b(?:created|start|due)::?\\s*(?:\\[\\[\\s*)?${DATE_TIME_REGEX_FRAGMENT}(?:\\s*\\]\\])?`, "ig"), "")
    .replace(new RegExp(`[📋🛫⏳📅]\\s*(?:\\[\\[\\s*)?${DATE_TIME_REGEX_FRAGMENT}(?:\\s*\\]\\])?`, "ig"), "")
    .replace(/#([a-zA-Z0-9_/\-\u4e00-\u9fff]+)/g, "")
    .replace(/@[a-zA-Z0-9_\-\u4e00-\u9fff]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function createChip(text: string, cls: string) {
  const chip = createSpan({ cls: `atb-chip ${cls}` });
  chip.setText(text);
  return chip;
}

function containsTag(raw: string, tag: string) {
  return new RegExp(`(^|\\s)${escapeReg(prefixHash(tag))}(?=\\s|$)`, "i").test(raw);
}

function removeTag(line: string, tag: string) {
  return line.replace(new RegExp(`\\s*${escapeReg(prefixHash(tag))}(?=\\s|$)`, "ig"), "");
}

function removeValue(values: string[], value: string) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function prefixHash(tag: string) {
  const trimmed = tag.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function normalizePath(path: string) {
  return path.trim().replace(/^\/+/, "");
}

function squashSpaces(value: string) {
  return value.replace(/\s{2,}/g, " ").trim();
}

function escapeReg(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTagColorIndex(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = ((hash << 5) - hash) + tag.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) % 8;
}
