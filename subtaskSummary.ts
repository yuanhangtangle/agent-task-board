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

export function getAdjacentSubtaskIndex(currentIndex: number, direction: -1 | 1, totalCount: number): number {
  if (totalCount <= 0) return -1;
  return Math.max(0, Math.min(currentIndex + direction, totalCount - 1));
}

export function getSubtaskIndexAfterToggle(currentIndex: number, completed: boolean, totalCount: number): number {
  if (!completed) return currentIndex;
  return getAdjacentSubtaskIndex(currentIndex, 1, totalCount);
}

export function getCurrentSubtaskSummary(subtasks: SubtaskSummaryInput[], preferredIndex?: number): CurrentSubtaskSummary | null {
  if (subtasks.length === 0) return null;

  const completedCount = subtasks.filter((subtask) => subtask.completed).length;
  const incompleteIndex = subtasks.findIndex((subtask) => !subtask.completed);
  const defaultIndex = incompleteIndex >= 0 ? incompleteIndex : subtasks.length - 1;
  const currentIndex = preferredIndex === undefined
    ? defaultIndex
    : Math.max(0, Math.min(preferredIndex, subtasks.length - 1));
  const current = subtasks[currentIndex];

  return {
    index: currentIndex,
    text: current.text,
    completed: current.completed,
    completedCount,
    totalCount: subtasks.length
  };
}
