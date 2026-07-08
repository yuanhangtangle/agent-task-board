export function setCheckboxCompletion(line: string, completed: boolean, completedDate: string) {
  const checkedLine = stripCompletionMetadata(line)
    .replace(/^(\s*[-*]\s+\[)[ xX](\]\s+)/, `$1${completed ? "x" : " "}$2`);

  return completed ? `${checkedLine} ✅ ${completedDate}` : checkedLine;
}

export function stripCompletionMetadata(raw: string) {
  return raw
    .replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/\s*<!--\s*from:\s*.*?-->/g, "")
    .trimEnd();
}
