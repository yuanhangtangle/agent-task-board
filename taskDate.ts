export type TaskDateFilter = "all" | "today" | "overdue" | "urgent" | "week" | "7d";

const BEIJING_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export function getTaskDateTag(tags: string[]): string | undefined {
  return tags.find((tag) => isValidTaskDateKey(tag));
}

export function getBeijingDateKey(now = new Date()): string {
  const parts = BEIJING_DATE_FORMATTER.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("无法获取北京时间");
  return `${year}${month}${day}`;
}

export function matchesTaskDateFilter(taskDate: string | undefined, filter: TaskDateFilter, today: string): boolean {
  if (filter === "all") return true;
  if (!taskDate) return false;
  if (filter === "today") return taskDate === today;
  if (filter === "overdue") return taskDate < today;
  if (filter === "urgent") return taskDate <= today;
  const date = new Date(`${formatTaskDateKey(today)}T00:00:00Z`);
  const start = new Date(date);
  if (filter === "week") start.setUTCDate(date.getUTCDate() - date.getUTCDay());
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const key = (value: Date) => value.toISOString().slice(0, 10).replace(/-/g, "");
  return taskDate >= key(start) && taskDate <= key(end);
}

export function getDeadlineKey(due: Date | undefined, taskDate: string | undefined): string | undefined {
  return due ? getBeijingDateKey(due) : taskDate;
}

export function formatTaskDateKey(taskDate: string): string {
  return `${taskDate.slice(0, 4)}-${taskDate.slice(4, 6)}-${taskDate.slice(6, 8)}`;
}

function isValidTaskDateKey(value: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day <= daysInMonth[month - 1];
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
