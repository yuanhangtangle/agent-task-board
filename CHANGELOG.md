# Changelog

## 0.4.0

- Added the default `做 / 推 / 收` and `Agent / 队列 / 任务池` workflow, with a settings toggle for the legacy board.
- Added the `#review` category for acceptance work.
- Added Beijing-time `#YYYYMMDD` task dates and today/overdue filters.
- Added subtask collaborator mentions and made collapsed subtask completion reversible.
- Made task cards start as numbered compact one-line summaries with click-to-expand details.
- Added previous/next buttons to the right of the subtask description for browsing subtasks in expanded cards.
- Preserved expanded cards, attachment panels, subtask panels, and selected subtasks when task line numbers shift after creating a task.

## 0.3.0

- Added collaboration tasks via `#collab`.
- Added link extraction from task text and indented child lines.
- Added task expansion details with link buttons, edit, and delete actions.
- Added task creation and editing with attachment lines.
- Moved completed task blocks, including indented child lines, to the done file.
- Reworked drag sorting to write task order back to Markdown files.
