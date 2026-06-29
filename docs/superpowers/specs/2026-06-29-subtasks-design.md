# Subtasks Design

## Goal

Add first-class subtasks to Agent Task Board so a parent task can represent dependent or decomposed work while still appearing as one todo item on the board.

## Storage Format

Subtasks are stored as native nested Markdown checkbox items inside the parent task block:

```md
- [ ] A task #inqueue
  - [ ] B subtask
  - [x] C subtask
  - Attachment: https://example.com
```

Rules:

- Top-level unchecked checkbox lines remain board tasks.
- Indented checkbox lines inside a task block are parsed as subtasks.
- Indented non-checkbox lines remain attachment or note lines.
- Subtasks support one level only. Nested subtasks under subtasks are out of scope.
- Existing tasks without nested checkbox lines require no migration.

## Data Model

`TaskItem` gains a `subtasks` array. Each subtask records:

- `text`: cleaned display text.
- `completed`: whether the nested checkbox is checked.
- `lineOffset`: the subtask line index relative to the parent task block.
- `originalLine`: the exact Markdown line used for write-back.

The parser separates parent block children into `subtasks` and `attachmentLines`. Links continue to be extracted from the parent raw text plus attachment lines only.

## Board Interaction

Cards use a separate subtask control:

- If a task has subtasks, the footer shows a `子任务 n/m` button.
- The existing `附件 n` button remains dedicated to attachments.
- Clicking the subtask button expands an inline checklist.
- Each subtask checkbox toggles only its corresponding nested Markdown line.
- Parent task checkbox is disabled when any subtask is incomplete and shows a tooltip explaining that subtasks must be completed first.
- When all subtasks are complete, the parent task checkbox becomes available.
- Completing the parent task archives or updates the whole Markdown block using the existing completion behavior.

## Create And Edit

The create task modal gains a `子任务` textarea. Each non-empty line becomes an unchecked nested checkbox.

The edit task modal also gains a `子任务` textarea. It renders existing subtasks as Markdown checkbox lines:

```md
[ ] Unfinished subtask
[x] Finished subtask
```

Saving preserves checked state for lines written with `[x]` and writes unchecked state for plain lines or `[ ]` lines. Attachments remain in their own textarea.

## Error Handling

- If a subtask toggle cannot find the current parent task line, show the existing write-back style notice and leave the file unchanged.
- If the parent completion is requested while subtasks are incomplete, show a notice and do not modify the file.
- If edit input leaves the parent task text empty, keep the current validation behavior.

## Testing And Verification

Verification should cover:

- Parse parent tasks, subtasks, and attachments without cross-contamination.
- Ensure nested checkbox lines do not appear as standalone board tasks.
- Toggle a subtask and verify only that nested line changes.
- Block parent completion while any subtask is incomplete.
- Allow parent completion after all subtasks are complete and preserve the full block in archive/update behavior.
- Create and edit tasks with subtasks without losing attachments.
- Confirm tasks without subtasks keep existing behavior.
