// The heartbeat the HUD polls every 30 seconds: system status, unread arkia
// messages, reminders that are due, recent tasks, and (on first load) a short
// spoken greeting. No model call, so it is fast and free.
import { allBetween } from "@/lib/arkia/calendar.ts";
import { calendarItems, connection, inbox, type InboxMessage } from "@/lib/arkia/client.ts";
import { providerSummary } from "@/lib/ai/providers.ts";
import { route } from "@/lib/auth.ts";
import { isOnline, listDevices } from "@/lib/devices.ts";
import { env } from "@/lib/env.ts";
import { addDays, formatWhen, partOfDay, startOfDay } from "@/lib/time.ts";
import { toolbox } from "@/lib/tools/index.ts";

export const runtime = "nodejs";

type Due = { key: string; title: string; type: string; when: string; start: number };

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

export const GET = route(async ({ sb, userId }, req) => {
  const wantBrief = new URL(req.url).searchParams.get("brief") === "1";
  const tz = env.timezone();
  const now = Date.now();

  const [devices, memoryCount, jobs, arkia] = await Promise.all([
    listDevices(sb),
    sb.from("memories").select("id", { count: "exact", head: true }).then((r) => r.count ?? 0),
    sb.from("jobs").select("id, title, tool, status, updated_at").order("updated_at", { ascending: false }).limit(8).then((r) => r.data || []),
    connection(sb).catch(() => null),
  ]);

  let messages: InboxMessage[] = [];
  let today: Due[] = [];
  let reminders: Due[] = [];
  let overdue = 0;
  let arkiaError: string | undefined;
  if (arkia) {
    try {
      const [items, box] = await Promise.all([calendarItems(sb, userId), inbox(sb, userId, { unreadOnly: true, limit: 15 })]);
      messages = box.messages;
      const dayStart = startOfDay(now, tz);
      const shape = (o: ReturnType<typeof allBetween>[number]): Due => ({
        key: `${o.item.id}@${o.start}`, title: o.item.title || "(untitled)", type: o.item.type || "event",
        when: formatWhen(o.start, tz, !!o.item.allDay), start: o.start,
      });
      const occ = allBetween(items, dayStart, addDays(dayStart, 2, tz), tz).filter((o) => !o.done);
      today = occ.filter((o) => o.start < addDays(dayStart, 1, tz) && (o.end > now || o.item.allDay || (o.item.type || "event") !== "event")).map(shape);
      // A reminder is due from its remind time until its start.
      reminders = occ.filter((o) => {
        const lead = Number(o.item.remind ?? -1);
        return lead >= 0 && now >= o.start - lead * 60_000 && now <= o.start + 60_000;
      }).map(shape);
      overdue = allBetween(items, addDays(dayStart, -14, tz), dayStart, tz)
        .filter((o) => (o.item.type || "event") === "task" && !o.done).length;
    } catch (err) {
      arkiaError = err instanceof Error ? err.message : "arkia is unreachable.";
    }
  }

  let brief: string | undefined;
  if (wantBrief) {
    const parts = [`Good ${partOfDay(tz, now)}, Sir.`];
    if (today.length) {
      const first = today.slice(0, 3).map((d) => d.title);
      parts.push(`You have ${today.length} ${today.length === 1 ? "item" : "items"} left today: ${listNames(first)}${today.length > 3 ? ", and more" : ""}.`);
    } else if (arkia && !arkiaError) {
      parts.push("Your calendar is clear for the rest of today.");
    }
    if (overdue) parts.push(`${overdue} ${overdue === 1 ? "task is" : "tasks are"} overdue.`);
    if (messages.length) {
      const who = [...new Set(messages.map((m) => m.from))];
      parts.push(`${messages.length} unread ${messages.length === 1 ? "message" : "messages"} from ${listNames(who.slice(0, 3))}.`);
    }
    if (parts.length === 1) parts.push("All systems are standing by.");
    brief = parts.join(" ");
  }

  return {
    providers: providerSummary(),
    devices: devices.map((d) => ({ id: d.id, name: d.name, online: isOnline(d), platform: d.platform })),
    memoryCount,
    toolCount: toolbox(devices, { arkia: !!arkia }).specs.length,
    arkia: { connected: !!arkia, error: arkiaError },
    messages, today, reminders, overdue,
    jobs,
    brief,
    serverTime: now,
  };
});
