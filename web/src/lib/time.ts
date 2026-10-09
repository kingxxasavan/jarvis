// Wall-clock time in the owner's timezone. The server runs in UTC, so anything
// a person reads ("today", "3 PM", a repeating task's day) goes through here.

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function zonedParts(ms: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

function offset(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// The instant at which the clock in `tz` reads the given wall time. Month and
// day may overflow (day 32 rolls into the next month), like Date.UTC.
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offset(guess, tz);
  const second = guess - offset(first, tz);
  return second;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function startOfDay(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
}

export function addDays(ms: number, n: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return zonedToUtc(p.y, p.m, p.d + n, p.h, p.mi, tz);
}

export function weekday(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

export function formatWhen(ms: number, tz: string, allDay = false): string {
  const opts: Intl.DateTimeFormatOptions = allDay
    ? { timeZone: tz, weekday: "short", month: "short", day: "numeric" }
    : { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(ms)) + (allDay ? " (all day)" : "");
}

export function describeNow(tz: string, now = Date.now()): string {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(now));
  return `${s} (${tz})`;
}

export function partOfDay(tz: string, now = Date.now()): "morning" | "afternoon" | "evening" {
  const h = zonedParts(now, tz).h;
  return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}

// "2026-10-09" or "2026-10-09T15:30" (owner's wall time) or a full ISO string.
export function parseWhen(input: string, tz: string): number | null {
  const s = String(input || "").trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, m, d, h, mi] = local;
    return zonedToUtc(+y, +m, +d, h ? +h : 0, mi ? +mi : 0, tz);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
