# Agent Task Board

Agent Task Board is an Obsidian plugin for managing your own work, work delegated to people or agents, and work that has not started, with deadline reminders and filters.

The plugin scans Markdown tasks from configured files, classifies tasks by tags, and lets you manage the board without constantly opening the source note.

## Features

- Four groups: `我做 / 别人做 / agent做 / 还没有做`.
- Configurable category tags: `#foreground`, `#collab`, and `#agent`. Untagged and legacy `#inqueue` tasks appear in `还没有做`; legacy `#review` tasks appear in `别人做`. Existing source files do not require bulk migration.
- Priority-based classification when multiple category tags exist on the same task.
- Path-pattern based Markdown scanning.
- Quick task creation into a configured inbox file.
- Edit and delete tasks from the board.
- Drag tasks within a column or across columns; task order is written back to Markdown.
- Collapsed cards show title, deadline, people, and tags in one horizontally scrolling row. Category tags are hidden from cards. Expand a card to see all subtasks and attachments directly, without extra toggle buttons or a source-file row. Check or uncheck any subtask independently. Click the expanded title row to collapse the card; the checkbox and edit button keep their own actions.
- Create tasks with a group's plus button to place them in that group. The global plus button and creation command default to `我做`; the creation dialog has no category selector.
- Complete tasks into a separate done file, including indented child lines.
- Attachment-style child lines under tasks, with URL extraction and link buttons.
- Filter by `#tag` and `@person`.
- Enter tags, people, and deadlines in the first task field, e.g. `Ship release #project @alice #20261018` or `Ship release @alice due::2026-10-18`. There is no separate tag field.
- Deadlines support `#YYYYMMDD`, `due::YYYY-MM-DD`, and `📅 YYYY-MM-DD`. An explicit deadline takes precedence over a date tag. Dates use Asia/Shanghai.
- Overdue cards have red accents; cards due today have orange accents, including when collapsed. Reminders refresh across midnight.
- Filter by `最紧急` (overdue plus today), `今天到期`, `已逾期`, `本周到期` (Sunday through Saturday), or `未来7天` (today through six days from today). Date-filtered results show earlier deadlines first; unfiltered tasks retain manual order.
- All unfinished subtasks' `@person` mentions contribute to the card and person filter. Mentions are preserved when editing the parent task.

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

Undated tasks are omitted from deadline filters. Click an active date filter again, or clear the filters, to return to all tasks. Completed tasks continue to be archived in the configured done file.
