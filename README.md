# Agent Task Board

Agent Task Board is an Obsidian plugin for managing TODOs when one person coordinates their own work, active follow-ups, acceptance work, agent work, queued work, and a general task pool.

The plugin scans Markdown tasks from configured files, classifies tasks by tags, and lets you manage the board without constantly opening the source note.

## Features

- The default six-column workflow is `做 / 推 / 收` over `Agent / 队列 / 任务池`.
- A settings toggle restores the legacy `前台 / Agent / 协作 / 入队 / 任务池 / 已完成` board.
- Configurable category tags, defaulting to `#foreground` (做), `#collab` (推), `#review` (收), `#agent`, and `#inqueue`.
- Priority-based classification when multiple category tags exist on the same task.
- Path-pattern based Markdown scanning.
- Quick task creation into a configured inbox file.
- Edit and delete tasks from the board.
- Drag tasks within a column or across columns; task order is written back to Markdown.
- Task cards start as compact one-line summaries showing an automatically generated per-column sequence number, the title, active `@person` mentions, and subtask progress; click a card to expand its full details, or drag the collapsed row to reorder it.
- Complete tasks into a separate done file, including indented child lines.
- Attachment-style child lines under tasks, with URL extraction and link buttons.
- Filter by `#tag` and `@person`.
- Add a Beijing-time task date with `#YYYYMMDD`, then filter the board to today's or overdue tasks.
- Subtasks also support `@person`; only the current unfinished subtask's mentions contribute to the task card and collaborator filter. After it is completed, the next unfinished subtask's mentions become active. Mentions are preserved when editing the parent task.
- Subtask checkboxes can be checked or unchecked from both the summary and expanded views.
- In an expanded card, use the previous/next buttons in the current-subtask row to browse subtasks. Checking the displayed subtask automatically advances to the next one.

## Install With BRAT

This is the easiest way to install the plugin before it is accepted into the Obsidian community plugin directory.

1. Install the Obsidian plugin **BRAT**.
2. Open BRAT settings.
3. Choose **Add Beta plugin**.
4. Paste this repository URL.
5. Enable **Agent Task Board** in Obsidian community plugins.

## Manual Install

Download these files from a release:

- `main.js`
- `manifest.json`
- `styles.css`

Place them in:

```text
<vault>/.obsidian/plugins/agent-task-board/
```

Then reload Obsidian and enable the plugin.

## Development

```bash
npm install
npm run build
```

For watch mode:

```bash
npm run dev
```

Type-check without emitting files:

```bash
npm run typecheck
```

## Release

Build and create an installable zip:

```bash
npm run build
npm run package
```

Attach the generated `agent-task-board-<version>.zip` to a GitHub release. For BRAT and manual installation, the release should include:

- `main.js`
- `manifest.json`
- `styles.css`

## Task Format

Tasks are normal Markdown checklist items:

```markdown
- [ ] Follow up with team #collab #20260730 @someone
  - [ ] Prepare the agenda @alice
  - [ ] Review the draft @bob
  - https://example.com/doc
  - [Issue](https://example.com/issue/1)
```

Indented checklist lines are treated as subtasks; other indented child lines are attachments. Both move together with the parent task.

`#YYYYMMDD` uses the Asia/Shanghai calendar date. “当天任务” matches today's tag, while “过期任务” matches earlier tagged dates; undated tasks are omitted from both filters.
