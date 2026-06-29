import {
  App,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  TFile,
  WorkspaceLeaf,
  moment
} from "obsidian";

const VIEW_TYPE_AGENT_TASK_BOARD = "agent-task-board-view";

type Category = "foreground" | "agent" | "collab" | "inqueue" | "pool";
type BoardCategory = Category | "completed";
type FilterMode = "AND" | "OR";
type CompletedFilter = "today" | "7d" | "30d" | "all";
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
  sshRemotePathPrefixes: string[];
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
  sshRemotePathPrefixes: [],
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
  category: BoardCategory;
  tags: string[];
  collaborators: string[];
  links: TaskLink[];
  subtasks: SubtaskItem[];
  attachmentLines: string[];
  created?: Date;
  due?: Date;
  start?: Date;
  completed?: Date;
  originalLine: string;
  originalBlock: string[];
}

interface SubtaskItem {
  text: string;
  completed: boolean;
  lineOffset: number;
  originalLine: string;
}

interface DragPayload {
  id: string;
  filePath: string;
  line: number;
  originalLine: string;
  originalBlock: string[];
  category: BoardCategory;
}

interface FocusPlannerTaskPayload {
  raw: string;
  title: string;
  status: "todo" | "done" | "in_progress" | "cancelled" | "deferred";
  priority: "highest" | "high" | "normal" | "low";
  dueDate: string | null;
  scheduledDate: string | null;
  pomodoros: number;
  pomodorosDone: number;
  tags: string[];
  sourcePath: string;
  lineNumber: number;
}

interface TaskLink {
  label: string;
  url: string;
  type: "url" | "file" | "remote";
}

const CATEGORY_LABELS: Record<BoardCategory, string> = {
  foreground: "前台任务",
  agent: "Agent 任务",
  collab: "协作任务",
  inqueue: "入队任务",
  pool: "任务池",
  completed: "已完成"
};

const ACTIVE_CATEGORIES: Category[] = ["foreground", "agent", "collab", "inqueue", "pool"];
const FOCUS_PLANNER_TASK_MIME = "application/x-focus-planner-task";

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
    this.settings.sshRemotePathPrefixes = normalizeRemotePathPrefixes(this.settings.sshRemotePathPrefixes);
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
        const { subtasks, attachmentLines } = splitTaskBlockChildren(originalBlock);
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
          links: extractLinks([raw, ...attachmentLines], this.settings.sshRemotePathPrefixes),
          subtasks,
          attachmentLines,
          created: created ?? undefined,
          start: start ?? undefined,
          due: due ?? undefined,
          originalLine: line,
          originalBlock
        });
        i = blockRange.end;
      }
    }

    return tasks;
  }

  async collectCompletedTasks(): Promise<TaskItem[]> {
    const completedPath = normalizePath(this.settings.completedTaskFile);
    if (!completedPath) return [];

    const file = this.app.vault.getAbstractFileByPath(completedPath);
    if (!(file instanceof TFile)) return [];

    const tasks: TaskItem[] = [];
    const categoryTags = this.getCategoryTags();
    const content = await this.app.vault.cachedRead(file);
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = /^(\s*[-*]\s+\[[xX]\]\s+)(.*)$/.exec(line);
      if (!match) continue;

      const raw = match[2];
      const blockRange = getTaskBlockRange(lines, i);
      const originalBlock = lines.slice(i, blockRange.end + 1);
      const { subtasks, attachmentLines } = splitTaskBlockChildren(originalBlock);
      const tags = extractTags(raw);
      const collaborators = extractCollaborators(raw);
      const completed = extractCompletedDate(raw);
      const created = extractDate(raw, "created", ["📋"]);
      const start = extractDate(raw, "start", ["🛫", "⏳"]);
      const due = extractDate(raw, "due", ["📅"]);
      const text = cleanupTaskText(stripCompletionMetadata(raw));

      if (!text) continue;
      tasks.push({
        id: buildTaskId(file.path, i, raw, categoryTags),
        text,
        rawText: raw,
        file,
        line: i,
        blockEndLine: blockRange.end,
        category: "completed",
        tags,
        collaborators,
        links: extractLinks([raw, ...attachmentLines], this.settings.sshRemotePathPrefixes),
        subtasks,
        attachmentLines,
        created: created ?? undefined,
        start: start ?? undefined,
        due: due ?? undefined,
        completed: completed ?? undefined,
        originalLine: line,
        originalBlock
      });
      i = blockRange.end;
    }

    return tasks;
  }

  async createTask(text: string, category: Category, targetFilePath?: string, subtaskText = "", attachmentText = "", tagText = "") {
    const cleaned = applyTaskTags(text, tagText).trim();
    if (!cleaned) return;

    const path = normalizePath(targetFilePath || this.settings.inboxFile);
    if (!path) {
      new Notice("请先设置默认 Inbox 文件");
      return;
    }

    const block = [
      buildTaskLine(cleaned, category, this.getCategoryTags()),
      ...normalizeSubtaskInput(subtaskText),
      ...normalizeAttachmentInput(attachmentText)
    ];
    const file = await this.ensureMarkdownFile(path);
    await this.app.vault.process(file, (data) => prependBlock(data, block));
    this.refreshView();
    new Notice("已创建任务");
  }

  async updateTask(task: TaskItem, rawText: string, subtaskText: string, attachmentText: string, tagText = "") {
    const categoryTags = this.getCategoryTags();
    const nextRaw = replaceTaskTags(rawText, tagText, categoryTags).trim();
    if (!nextRaw) {
      new Notice("任务内容不能为空");
      return;
    }

    const nextBlock = [
      buildTaskHeaderLine(task, nextRaw, categoryTags),
      ...normalizeSubtaskInput(subtaskText),
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
      buildTaskHeaderLine(task, task.rawText, this.getCategoryTags()),
      ...task.subtasks.map((subtask) => subtask.originalLine),
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
      buildTaskHeaderLine(task, task.rawText, this.getCategoryTags()),
      ...task.subtasks.map((subtask) => subtask.originalLine),
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

  async toggleSubtask(task: TaskItem, subtask: SubtaskItem, completed: boolean) {
    await this.app.vault.process(task.file, (data) => {
      const lines = data.split(/\r?\n/);
      const idx = findCurrentTaskLine(lines, task);
      if (idx < 0) {
        new Notice("任务源行已变化，未写回子任务");
        return data;
      }

      const targetIdx = idx + subtask.lineOffset;
      if (targetIdx < 0 || targetIdx >= lines.length || !/^(\s*[-*]\s+\[[ xX]\]\s+)/.test(lines[targetIdx])) {
        new Notice("子任务源行已变化，未写回");
        return data;
      }

      lines[targetIdx] = lines[targetIdx].replace(/^(\s*[-*]\s+\[)[ xX](\]\s+)/, `$1${completed ? "x" : " "}$2`);
      return lines.join("\n");
    });
    this.refreshView();
  }

  async completeTask(task: TaskItem) {
    if (task.subtasks.some((subtask) => !subtask.completed)) {
      new Notice("请先完成所有子任务");
      return;
    }

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
      next[0] = setCategoryTag(restoreIncompleteTaskLine(next[0]), category, categoryTags);
      return next;
    };

    if (targetTask && task.id === targetTask.id) return;

    if (!targetTask) {
      if (task.category === "completed") {
        const nextBlock = rewriteBlock(task.originalBlock);
        const inboxFile = await this.ensureMarkdownFile(normalizePath(this.settings.inboxFile));
        await this.removeTaskBlock(task);
        await this.app.vault.process(inboxFile, (data) => appendBlock(data, nextBlock));
        this.refreshView();
        new Notice(`已恢复到${CATEGORY_LABELS[category]}`);
        return;
      }
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

    for (const category of ACTIVE_CATEGORIES) {
      const before = this.settings.taskOrder[category] ?? [];
      const after = before.filter((id) => presentIds.has(id));
      if (after.length !== before.length) changed = true;
      this.settings.taskOrder[category] = after;
    }

    for (const task of tasks) {
      if (!isActiveCategory(task.category)) continue;
      const order = this.settings.taskOrder[task.category];
      if (!order.includes(task.id)) {
        order.push(task.id);
        changed = true;
      }
    }

    if (changed) void this.saveData(this.settings);
  }

  private setOrderPosition(taskId: string, category: Category, targetId: string | null, position: InsertPosition) {
    for (const key of ACTIVE_CATEGORIES) {
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
  private filterMode: FilterMode = "AND";
  private completedFilter: CompletedFilter = "7d";
  private expandedTaskIds = new Set<string>();
  private expandedSubtaskIds = new Set<string>();

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
    let completedTasks = await this.plugin.collectCompletedTasks();
    tasks.sort(compareTasks);
    completedTasks.sort(compareCompletedTasks);

    this.renderFilterToolbar(outer, [...tasks, ...completedTasks]);
    tasks = this.applyFilters(tasks);
    completedTasks = this.applyCompletedFilter(this.applyFilters(completedTasks));

    const grid = outer.createDiv({ cls: "atb-board" });
    const panels: Record<BoardCategory, { el: HTMLElement; list: HTMLElement; countEl: HTMLElement }> = {
      foreground: this.createPanel(grid, "前台任务", "atb-q-foreground", "foreground"),
      agent: this.createPanel(grid, "Agent 任务", "atb-q-agent", "agent"),
      collab: this.createPanel(grid, "协作任务", "atb-q-collab", "collab"),
      inqueue: this.createPanel(grid, "入队任务", "atb-q-inqueue", "inqueue"),
      pool: this.createPanel(grid, "任务池", "atb-q-pool", "pool"),
      completed: this.createPanel(grid, "已完成", "atb-q-completed")
    };

    const counters: Record<BoardCategory, number> = { foreground: 0, agent: 0, collab: 0, inqueue: 0, pool: 0, completed: 0 };
    const tasksByCategory: Record<BoardCategory, TaskItem[]> = { foreground: [], agent: [], collab: [], inqueue: [], pool: [], completed: [] };
    for (const task of [...tasks, ...completedTasks]) {
      counters[task.category]++;
      tasksByCategory[task.category].push(task);
      panels[task.category].list.appendChild(this.renderTaskCard(task));
    }
    (Object.keys(panels) as BoardCategory[]).forEach((category) => panels[category].countEl.setText(String(counters[category])));

    for (const category of ["foreground", "agent", "collab", "inqueue", "pool"] as Category[]) {
      const panel = panels[category];
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
            subtasks: [],
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

  private createPanel(container: HTMLElement, title: string, cls: string, category?: Category) {
    const panel = container.createDiv({ cls: `atb-panel ${cls}` });
    const header = panel.createDiv({ cls: "atb-panel-header" });
    header.createDiv({ cls: "atb-panel-title", text: title });
    const actions = header.createDiv({ cls: "atb-panel-actions" });
    if (category) {
      const addButton = actions.createEl("button", { cls: "atb-panel-add", text: "+" });
      addButton.setAttribute("title", `新增${title}`);
      addButton.addEventListener("click", () => new CreateTaskModal(this.app, this.plugin, category).open());
    }
    const countEl = actions.createDiv({ cls: "atb-count" });
    const list = panel.createDiv({ cls: "atb-list" });
    return { el: panel, list, countEl };
  }

  private renderTaskCard(task: TaskItem): HTMLElement {
    const tooltipParts = [
      task.file.path,
      `行 ${task.line + 1}`,
      task.due ? `截止 ${moment(task.due).format(this.plugin.settings.dateFormat)}` : "",
      task.completed ? `完成 ${moment(task.completed).format(this.plugin.settings.dateFormat)}` : "",
      task.created ? `创建 ${moment(task.created).format(this.plugin.settings.dateFormat)}` : ""
    ].filter(Boolean);

    const isExpanded = this.expandedTaskIds.has(task.id);
    const isSubtasksExpanded = this.expandedSubtaskIds.has(task.id);
    const incompleteSubtasks = task.subtasks.filter((subtask) => !subtask.completed).length;
    const isCompletionBlocked = task.category !== "completed" && incompleteSubtasks > 0;
    const card = createDiv({ cls: `atb-card ${task.category === "completed" ? "is-completed" : ""} ${isExpanded || isSubtasksExpanded ? "is-expanded" : ""}`, attr: { draggable: "true", title: tooltipParts.join(" · ") } });
    card.addEventListener("dragstart", (ev: DragEvent) => {
      ev.dataTransfer?.setData("application/json", JSON.stringify({
        id: task.id,
        filePath: task.file.path,
        line: task.line,
        originalLine: task.originalLine,
        originalBlock: task.originalBlock,
        category: task.category
      } satisfies DragPayload));
      ev.dataTransfer?.setData(FOCUS_PLANNER_TASK_MIME, JSON.stringify(buildFocusPlannerTaskPayload(task)));
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
        if (!isActiveCategory(task.category)) return;
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
          subtasks: [],
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
    checkbox.checked = task.category === "completed";
    checkbox.disabled = task.category === "completed" || isCompletionBlocked;
    if (isCompletionBlocked) checkbox.setAttribute("title", "先完成所有子任务");
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", async () => {
      if (task.category === "completed") return;
      await this.plugin.completeTask(task);
      await this.renderTasks();
    });

    const title = top.createDiv({ cls: "atb-task-title", text: task.text });
    const editButton = top.createEl("button", { cls: "atb-card-edit" });
    editButton.setAttribute("aria-label", "编辑任务");
    editButton.setAttribute("title", "编辑任务");
    setIcon(editButton, "pencil");
    editButton.addEventListener("click", (event) => {
      event.stopPropagation();
      new EditTaskModal(this.app, this.plugin, task).open();
    });

    const chips = card.createDiv({ cls: "atb-chips" });
    if (task.collaborators.length > 0) {
      for (const collaborator of task.collaborators) {
        const chip = createChip(`@${collaborator}`, "atb-chip-collab");
        chip.addClass("atb-clickable-chip");
        chip.setAttribute("title", `筛选 @${collaborator}`);
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          this.addFilterValue(this.filterCollabs, collaborator);
        });
        chips.appendChild(chip);
      }
    }
    if (task.tags.length > 0) {
      for (const tag of task.tags) {
        const chip = createChip(`#${tag}`, "atb-chip-tag");
        chip.setAttribute("data-tag-color", String(getTagColorIndex(tag)));
        chip.addClass("atb-clickable-chip");
        chip.setAttribute("title", `筛选 #${tag}`);
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          this.addFilterValue(this.filterTags, tag);
        });
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
    if (task.completed) {
      chips.appendChild(createChip(`完成 ${moment(task.completed).format(this.plugin.settings.dateFormat)}`, "atb-chip-date"));
    }

    const footer = card.createDiv({ cls: "atb-card-footer" });
    const source = footer.createDiv({ cls: "atb-source", text: `${task.file.basename}:${task.line + 1}` });
    source.setAttribute("title", "打开源文件");
    source.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.openTaskSource(task);
    });

    if (task.subtasks.length > 0) {
      const completedSubtasks = task.subtasks.length - incompleteSubtasks;
      const subtaskIndicator = footer.createEl("button", {
        cls: `atb-subtask-indicator ${incompleteSubtasks === 0 ? "is-complete" : ""}`,
        text: `子任务 ${completedSubtasks}/${task.subtasks.length}`
      });
      subtaskIndicator.setAttribute("title", isSubtasksExpanded ? "收起子任务" : "展开子任务");
      subtaskIndicator.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.expandedSubtaskIds.has(task.id)) this.expandedSubtaskIds.delete(task.id);
        else this.expandedSubtaskIds.add(task.id);
        void this.renderTasks();
      });
    }

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

    if (isSubtasksExpanded) this.renderSubtaskDetails(card, task);
    if (isExpanded) this.renderTaskDetails(card, task);
    return card;
  }

  private renderSubtaskDetails(card: HTMLElement, task: TaskItem) {
    const details = card.createDiv({ cls: "atb-subtask-details" });
    for (const subtask of task.subtasks) {
      const row = details.createDiv({ cls: "atb-subtask-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.addClass("atb-subtask-box");
      checkbox.checked = subtask.completed;
      checkbox.disabled = task.category === "completed";
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", async () => {
        await this.plugin.toggleSubtask(task, subtask, checkbox.checked);
        await this.renderTasks();
      });
      const title = row.createDiv({ cls: "atb-subtask-title", text: subtask.text });
      title.toggleClass("is-complete", subtask.completed);
    }
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

    const modeSelect = toolbar.createEl("select", { cls: "atb-filter-mode" });
    modeSelect.createEl("option", { value: "AND", text: "过滤：AND" });
    modeSelect.createEl("option", { value: "OR", text: "过滤：OR" });
    modeSelect.value = this.filterMode;
    modeSelect.setAttribute("title", this.filterMode === "AND" ? "所有标签都匹配" : "任一标签匹配");
    modeSelect.addEventListener("change", () => {
      this.filterMode = modeSelect.value as FilterMode;
      void this.renderTasks();
    });

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

    const completedSelect = toolbar.createEl("select", { cls: "atb-completed-filter" });
    completedSelect.createEl("option", { value: "today", text: "完成：今天" });
    completedSelect.createEl("option", { value: "7d", text: "完成：7天" });
    completedSelect.createEl("option", { value: "30d", text: "完成：30天" });
    completedSelect.createEl("option", { value: "all", text: "完成：全部" });
    completedSelect.value = this.completedFilter;
    completedSelect.addEventListener("change", () => {
      this.completedFilter = completedSelect.value as CompletedFilter;
      void this.renderTasks();
    });

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

  private addFilterValue(values: string[], value: string) {
    if (!values.includes(value)) values.push(value);
    void this.renderTasks();
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

  private applyCompletedFilter(tasks: TaskItem[]) {
    if (this.completedFilter === "all") return tasks;

    const now = moment().startOf("day");
    return tasks.filter((task) => {
      if (!task.completed) return this.completedFilter === "all";
      const completed = moment(task.completed).startOf("day");
      if (this.completedFilter === "today") return completed.isSame(now, "day");
      const days = this.completedFilter === "7d" ? 7 : 30;
      return !completed.isBefore(now.clone().subtract(days - 1, "days"), "day");
    });
  }
}

class CreateTaskModal extends Modal {
  plugin: AgentTaskBoardPlugin;
  initialCategory: Category;
  taskText = "";
  subtaskText = "";
  tagText = "";
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
      .setName("子任务")
      .setDesc("每行一个子任务；也支持写 [x] 已完成 / [ ] 未完成。")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.setValue(this.subtaskText);
        text.setPlaceholder("调研方案\n实现写回\n验证归档");
        text.onChange((value) => this.subtaskText = value);
      });

    new Setting(contentEl)
      .setName("标签")
      .setDesc("空格分隔，支持写 #tag；分类标签由象限自动维护。")
      .addText((text) => {
        text.setValue(this.tagText);
        text.setPlaceholder("#today #important");
        text.onChange((value) => this.tagText = value);
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
      await this.plugin.createTask(this.taskText, this.category, this.targetFile, this.subtaskText, this.attachmentText, this.tagText);
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
  subtaskText: string;
  tagText: string;
  attachmentText: string;

  constructor(app: App, plugin: AgentTaskBoardPlugin, task: TaskItem) {
    super(app);
    this.plugin = plugin;
    this.task = task;
    this.rawText = task.rawText;
    this.subtaskText = serializeSubtasksForEdit(task.subtasks);
    this.tagText = getEditableTaskTags(task, plugin.getCategoryTags()).map((tag) => `#${tag}`).join(" ");
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
      .setName("子任务")
      .setDesc("每行一个子任务；支持 [x] 已完成 / [ ] 未完成。")
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.setValue(this.subtaskText);
        text.onChange((value) => this.subtaskText = value);
      });

    new Setting(contentEl)
      .setName("标签")
      .setDesc("空格分隔，支持写 #tag；保存时替换任务里的普通标签。")
      .addText((text) => {
        text.setValue(this.tagText);
        text.setPlaceholder("#today #important");
        text.onChange((value) => this.tagText = value);
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

    const buttons = contentEl.createDiv({ cls: "atb-modal-buttons atb-modal-buttons-split" });
    const deleteButton = buttons.createEl("button", { cls: "mod-warning", text: "删除" });
    deleteButton.addEventListener("click", async () => {
      if (!window.confirm("确定删除这个任务吗？")) return;

      await this.plugin.deleteTask(this.task);
      this.close();
    });

    const actionButtons = buttons.createDiv({ cls: "atb-modal-action-buttons" });
    const saveButton = actionButtons.createEl("button", { cls: "mod-cta", text: "保存" });
    saveButton.addEventListener("click", async () => {
      await this.plugin.updateTask(this.task, this.rawText, this.subtaskText, this.attachmentText, this.tagText);
      this.close();
    });
    const cancelButton = actionButtons.createEl("button", { text: "取消" });
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
      .setName("SSH 远端路径前缀")
      .setDesc("每行一个路径前缀。附件以这些前缀开头时，会作为服务器路径识别，点击后复制路径。")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.setValue(this.plugin.settings.sshRemotePathPrefixes.join("\n"));
        text.onChange(async (value) => {
          this.plugin.settings.sshRemotePathPrefixes = normalizeRemotePathPrefixes(value.split(/\r?\n/));
          await this.plugin.saveSettings();
        });
      });

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

function buildTaskHeaderLine(task: TaskItem, rawText: string, tags: Record<Exclude<Category, "pool">, string>) {
  if (task.category === "completed") {
    const prefix = /^(\s*[-*]\s+\[[xX]\]\s+)/.exec(task.originalLine)?.[1] ?? "- [x] ";
    return `${prefix}${rawText.trim()}`;
  }
  return buildTaskLine(rawText, task.category, tags);
}

function restoreIncompleteTaskLine(line: string) {
  return stripCompletionMetadata(line)
    .replace(/^(\s*[-*]\s+\[)[xX](\]\s+)/, "$1 $2")
    .trimEnd();
}

function stripCompletionMetadata(raw: string) {
  return raw
    .replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/\s*<!--\s*from:\s*.*?-->/g, "")
    .trim();
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

function prependBlock(data: string, block: string[]) {
  if (!data.trim()) return `${block.join("\n")}\n`;

  const lines = data.split(/\r?\n/);
  let insertIdx = 0;

  if (lines[0]?.trim() === "---") {
    const endIdx = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (endIdx >= 0) insertIdx = endIdx + 1;
  }

  while (insertIdx < lines.length && lines[insertIdx].trim() === "") insertIdx++;
  lines.splice(insertIdx, 0, ...block, "");
  return lines.join("\n");
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

function normalizeSubtaskInput(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^\[([ xX])\]\s+(.*)$/.exec(line);
      const completed = match?.[1]?.toLowerCase() === "x";
      const text = (match ? match[2] : line).trim();
      return `  - [${completed ? "x" : " "}] ${text}`;
    });
}

function serializeSubtasksForEdit(subtasks: SubtaskItem[]) {
  return subtasks.map((subtask) => `[${subtask.completed ? "x" : " "}] ${subtask.text}`).join("\n");
}

function cleanupAttachmentLine(line: string) {
  return line.trim().replace(/^[-*]\s+/, "").trim();
}

function splitTaskBlockChildren(originalBlock: string[]) {
  const subtasks: SubtaskItem[] = [];
  const attachmentLines: string[] = [];

  for (let offset = 1; offset < originalBlock.length; offset++) {
    const line = originalBlock[offset];
    const subtask = parseSubtaskLine(line, offset);
    if (subtask) subtasks.push(subtask);
    else attachmentLines.push(line);
  }

  return { subtasks, attachmentLines };
}

function parseSubtaskLine(line: string, lineOffset: number): SubtaskItem | null {
  const match = /^(\s*[-*]\s+\[([ xX])\]\s+)(.*)$/.exec(line);
  if (!match) return null;
  return {
    text: cleanupTaskText(stripCompletionMetadata(match[3])),
    completed: match[2].toLowerCase() === "x",
    lineOffset,
    originalLine: line
  };
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

function compareCompletedTasks(a: TaskItem, b: TaskItem) {
  return b.file.path.localeCompare(a.file.path) || b.line - a.line;
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

function normalizeRemotePathPrefixes(prefixes: string[] | undefined) {
  return Array.from(new Set((Array.isArray(prefixes) ? prefixes : [])
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.startsWith("/"))
    .map((prefix) => prefix.replace(/\/+$/, "") || "/")));
}

function remotePathMatchesPrefix(path: string, prefix: string) {
  if (prefix === "/") return path.startsWith("/");
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isActiveCategory(category: BoardCategory): category is Category {
  return category !== "completed";
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

function normalizeTagInput(value: string) {
  return Array.from(new Set(value
    .split(/[\s,，]+/)
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter((tag) => /^[a-zA-Z0-9_/\-\u4e00-\u9fff]+$/.test(tag))));
}

function applyTaskTags(rawText: string, tagText: string) {
  const inputTags = normalizeTagInput(tagText);
  if (inputTags.length === 0) return rawText.trim();

  const existingTags = extractTags(rawText);
  const nextTags = Array.from(new Set([...existingTags, ...inputTags]));
  return appendTags(removeAllTaskTags(rawText), nextTags);
}

function replaceTaskTags(rawText: string, tagText: string, categoryTags: Record<Exclude<Category, "pool">, string>) {
  const categoryNames = new Set(Object.values(categoryTags).map((tag) => tag.replace(/^#/, "").toLowerCase()));
  const nextTags = normalizeTagInput(tagText).filter((tag) => !categoryNames.has(tag.toLowerCase()));
  return appendTags(removeAllTaskTags(rawText), nextTags);
}

function removeAllTaskTags(rawText: string) {
  return rawText
    .replace(/#([a-zA-Z0-9_/\-\u4e00-\u9fff]+)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function appendTags(rawText: string, tags: string[]) {
  const cleaned = rawText.trim();
  const suffix = tags.map((tag) => `#${tag}`).join(" ");
  return [cleaned, suffix].filter(Boolean).join(" ");
}

function getEditableTaskTags(task: TaskItem, categoryTags: Record<Exclude<Category, "pool">, string>) {
  const categoryNames = new Set(Object.values(categoryTags).map((tag) => tag.replace(/^#/, "").toLowerCase()));
  return task.tags.filter((tag) => !categoryNames.has(tag.toLowerCase()));
}

function extractCollaborators(raw: string): string[] {
  const collaborators: string[] = [];
  const re = /@([a-zA-Z0-9_\-\u4e00-\u9fff]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) collaborators.push(match[1]);
  return Array.from(new Set(collaborators));
}

function extractLinks(lines: string[], sshRemotePathPrefixes: string[] = []): TaskLink[] {
  const links: TaskLink[] = [];
  const seen = new Set<string>();
  const markdownLinkRe = /\[([^\]]+)\]((?:\((https?:\/\/[^\s)]+|obsidian:\/\/[^\s)]+|file:\/\/[^\s)]+|ssh:\/\/[^\s)]+)\)))/g;
  const urlRe = /(https?:\/\/[^\s<>)\]]+|obsidian:\/\/[^\s<>)\]]+|file:\/\/[^\s<>)\]]+|ssh:\/\/[^\s<>)\]]+)/g;

  for (const line of lines) {
    let markdownMatch: RegExpExecArray | null;
    while ((markdownMatch = markdownLinkRe.exec(line)) !== null) {
      const url = trimUrl(markdownMatch[3]);
      if (!seen.has(url)) {
        links.push({ label: markdownMatch[1].trim() || linkFallbackLabel(url), url, type: getLinkType(url) });
        seen.add(url);
      }
    }

    let urlMatch: RegExpExecArray | null;
    while ((urlMatch = urlRe.exec(line)) !== null) {
      const url = trimUrl(urlMatch[1]);
      if (!seen.has(url)) {
        links.push({ label: inferLinkLabel(line, url), url, type: getLinkType(url) });
        seen.add(url);
      }
    }

    const localFile = extractLocalFileAttachment(line, sshRemotePathPrefixes);
    if (localFile && !seen.has(localFile.url)) {
      links.push(localFile);
      seen.add(localFile.url);
    }
  }

  return links;
}

function extractLocalFileAttachment(line: string, sshRemotePathPrefixes: string[] = []): TaskLink | null {
  const cleaned = cleanupAttachmentLine(line);
  if (hasUrlScheme(cleaned) && !isFileAttachmentUrl(cleaned)) return null;

  const stripped = stripAttachmentLabel(cleaned);
  const path = parseLocalFilePath(cleaned) ?? (stripped === cleaned ? null : parseLocalFilePath(stripped));
  if (path) {
    return {
      label: inferLocalFileLabel(cleaned, path),
      url: path,
      type: "file"
    };
  }

  const remotePath = parseConfiguredRemotePath(cleaned, sshRemotePathPrefixes)
    ?? (stripped === cleaned ? null : parseConfiguredRemotePath(stripped, sshRemotePathPrefixes));
  if (!remotePath) return null;
  return {
    label: inferLocalFileLabel(cleaned, remotePath),
    url: remotePath,
    type: "remote"
  };
}

function parseLocalFilePath(value: string) {
  const cleaned = trimUrl(value.trim());
  if (isFileAttachmentUrl(cleaned)) return cleaned;
  return null;
}

function parseConfiguredRemotePath(value: string, prefixes: string[]) {
  const cleaned = trimUrl(value.trim());
  if (!cleaned || hasUrlScheme(cleaned)) return null;

  return normalizeRemotePathPrefixes(prefixes).some((prefix) => remotePathMatchesPrefix(cleaned, prefix))
    ? cleaned
    : null;
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
  if (link.type === "remote") {
    await copyTextToClipboard(sshUrlToPath(link.url));
    new Notice("已复制服务器路径");
    return;
  }

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
  if (isSshAttachmentUrl(url)) {
    const path = sshUrlToPath(url);
    return path.split(/[\\/]/).filter(Boolean).pop() || path.slice(0, 60);
  }
  if (url.startsWith("/")) {
    return url.split(/[\\/]/).filter(Boolean).pop() || url.slice(0, 60);
  }
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

function isSshAttachmentUrl(value: string) {
  return /^ssh:\/\//i.test(value);
}

function getLinkType(url: string): TaskLink["type"] {
  if (isFileAttachmentUrl(url)) return "file";
  if (isSshAttachmentUrl(url)) return "remote";
  return "url";
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

function sshUrlToPath(value: string) {
  const withoutScheme = value.replace(/^ssh:\/\//i, "");
  const pathStart = withoutScheme.indexOf("/");
  const path = withoutScheme.startsWith("/")
    ? withoutScheme
    : pathStart >= 0 ? withoutScheme.slice(pathStart) : "";

  if (!path) return value;

  try {
    return decodeURIComponent(path).replace(/^\/+/, "/");
  } catch {
    return path.replace(/^\/+/, "/");
  }
}

async function copyTextToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function buildFocusPlannerTaskPayload(task: TaskItem): FocusPlannerTaskPayload {
  return {
    raw: task.originalLine,
    title: task.text,
    status: task.category === "completed" ? "done" : "todo",
    priority: extractTaskPriority(task.rawText),
    dueDate: task.due ? task.due.toISOString() : null,
    scheduledDate: task.start ? task.start.toISOString() : null,
    pomodoros: extractNumberMetadata(task.rawText, "pomo") ?? extractTomatoCount(task.rawText) ?? 0,
    pomodorosDone: extractNumberMetadata(task.rawText, "done") ?? 0,
    tags: task.tags,
    sourcePath: task.file.path,
    lineNumber: task.line + 1
  };
}

function extractTaskPriority(raw: string): FocusPlannerTaskPayload["priority"] {
  if (raw.includes("⏫")) return "highest";
  if (raw.includes("🔺")) return "high";
  if (raw.includes("🔽")) return "low";
  return "normal";
}

function extractNumberMetadata(raw: string, key: string) {
  const match = new RegExp(`\\[${escapeReg(key)}::\\s*(\\d+)\\]`, "i").exec(raw);
  return match ? Number(match[1]) : null;
}

function extractTomatoCount(raw: string) {
  const match = /(\d+)🍅/.exec(raw);
  return match ? Number(match[1]) : null;
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

function extractCompletedDate(raw: string): Date | null {
  const doneMatch = /✅\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(raw);
  if (doneMatch) return parseDateString(doneMatch[1]);
  return extractDate(raw, "completed", []);
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
