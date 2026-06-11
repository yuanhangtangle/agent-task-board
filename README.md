# Agent Task Board

Agent Task Board is an Obsidian plugin for managing TODOs when one person coordinates foreground work, agent work, queued work, collaboration follow-ups, and a general task pool.

The plugin scans Markdown tasks from configured files, classifies tasks by tags, and lets you manage the board without constantly opening the source note.

## Features

- Board columns for foreground tasks, agent tasks, collaboration tasks, queued tasks, and task pool.
- Configurable category tags, defaulting to `#foreground`, `#agent`, `#collab`, and `#inqueue`.
- Priority-based classification when multiple category tags exist on the same task.
- Path-pattern based Markdown scanning.
- Quick task creation into a configured inbox file.
- Edit and delete tasks from the board.
- Drag tasks within a column or across columns; task order is written back to Markdown.
- Complete tasks into a separate done file, including indented child lines.
- Attachment-style child lines under tasks, with URL extraction and link buttons.
- Filter by `#tag` and `@person`.

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
- [ ] Follow up with team #collab @someone
  - https://example.com/doc
  - [Issue](https://example.com/issue/1)
```

Indented child lines are treated as task attachments and move together with the parent task.
