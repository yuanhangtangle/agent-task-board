export interface SubtaskSummaryInput {
  text: string;
  completed: boolean;
}

export interface CurrentSubtaskSummary {
  index: number;
  text: string;
  completed: boolean;
  completedCount: number;
  totalCount: number;
}

export function getCurrentSubtaskSummary(subtasks: SubtaskSummaryInput[]): CurrentSubtaskSummary | null {
  if (subtasks.length === 0) return null;

  const completedCount = subtasks.filter((subtask) => subtask.completed).length;
  const incompleteIndex = subtasks.findIndex((subtask) => !subtask.completed);
  const currentIndex = incompleteIndex >= 0 ? incompleteIndex : subtasks.length - 1;
  const current = subtasks[currentIndex];

  return {
    index: currentIndex,
    text: current.text,
    completed: current.completed,
    completedCount,
    totalCount: subtasks.length
  };
}
