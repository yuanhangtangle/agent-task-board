export function getTaskViewStateKey(filePath: string, taskId: string): string {
  const hashSeparator = taskId.lastIndexOf(":");
  const stableTaskHash = hashSeparator >= 0 ? taskId.slice(hashSeparator + 1) : taskId;
  return `${filePath}:${stableTaskHash}`;
}
