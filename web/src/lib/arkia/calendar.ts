// arkia.buzz calendar items and their occurrences. A port of arkia's own
// lib/reminders.js so Jarvis and the arkia site agree on what is due when,
// computed in the owner's timezone instead of the browser's.
import { addDays, dayKey, weekday, zonedParts, zonedToUtc } from "../time.ts";

export type ArkiaItem = {
  id: string;
  type?: "event" | "task" | "reminder";
  title?: string;
  notes?: string;
  location?: string;
  start: number;
  end?: number | null;
  allDay?: boolean;
  repeat?: "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
  until?: number;
  done?: boolean;
  doneDates?: Record<string, boolean>;
  remind?: number;
};

export type Occurrence = { item: ArkiaItem; start: number; end: number; done: boolean };

const DAY = 86_400_000;

function durationOf(item: ArkiaItem): number {
  if (item.allDay) return item.end && item.end > item.start ? Math.max(DAY, item.end - item.start) : DAY;
  if ((item.type || "event") === "event") return item.end && item.end > item.start ? item.end - item.start : 3_600_000;
  return 0;
}

export function isDone(item: ArkiaItem, start: number, tz: string): boolean {
  if ((item.repeat || "none") === "none") return !!item.done;
  return !!item.doneDates?.[dayKey(start, tz)];
}

function addMonths(start: number, n: number, tz: string): number | null {
  const p = zonedParts(start, tz);
  const total = p.m - 1 + n;
  const y = p.y + Math.floor(total / 12);
  const m = (((total % 12) + 12) % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (p.d > last) return null; // no 31st this month: arkia skips it too
  return zonedToUtc(y, m, p.d, p.h, p.mi, tz);
}

// Every occurrence of `item` that overlaps [from, to).
export function occurrences(item: ArkiaItem, from: number, to: number, tz: string): Occurrence[] {
  const out: Occurrence[] = [];
  if (!Number.isFinite(item.start)) return out;
  const dur = durationOf(item);
  const push = (start: number) => {
    if (item.until && start > item.until) return;
    const end = start + dur;
    if (start < to && (end > from || (dur === 0 && start >= from))) {
      out.push({ item, start, end, done: isDone(item, start, tz) });
    }
  };
  const repeat = item.repeat || "none";
  if (repeat === "none") {
    push(item.start);
    return out;
  }
  if (repeat === "daily" || repeat === "weekly" || repeat === "weekdays") {
    const stepDays = repeat === "weekly" ? 7 : 1;
    let n = Math.max(0, Math.floor((from - dur - item.start) / (stepDays * DAY)) - 1);
    for (let guard = 0; guard < 800; guard++, n++) {
      const t = addDays(item.start, n * stepDays, tz);
      if (t >= to) break;
      const wd = weekday(t, tz);
      if (repeat === "weekdays" && (wd === 0 || wd === 6)) continue;
      push(t);
    }
    return out;
  }
  const months = repeat === "yearly" ? 12 : 1;
  const a = zonedParts(item.start, tz);
  const b = zonedParts(from, tz);
  const gap = (b.y - a.y) * 12 + b.m - a.m;
  let n = Math.max(0, Math.floor(gap / months) - 1);
  for (let guard = 0; guard < 400; guard++, n++) {
    const t = addMonths(item.start, n * months, tz);
    if (t === null) continue;
    if (t >= to) break;
    push(t);
  }
  return out;
}

export function allBetween(items: ArkiaItem[], from: number, to: number, tz: string): Occurrence[] {
  return items.flatMap((it) => occurrences(it, from, to, tz)).sort((x, y) => x.start - y.start);
}
