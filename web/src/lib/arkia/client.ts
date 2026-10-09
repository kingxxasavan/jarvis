// arkia.buzz, read and written as the owner's own arkia account through the
// Firebase REST APIs. Jarvis keeps only an encrypted refresh token; the
// password (if one is used to connect) is exchanged once and never stored.
import { env } from "../env.ts";
import { decrypt, encrypt } from "../crypto.ts";
import { HttpError } from "../auth.ts";
import type { Supa } from "../supabase/server.ts";
import type { ArkiaItem } from "./calendar.ts";

type Session = { idToken: string; uid: string; expires: number };
const sessions = new Map<string, Session>();

function friendly(code: string): string {
  if (/INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD|EMAIL_NOT_FOUND/.test(code)) return "arkia rejected that email or password.";
  if (/TOO_MANY_ATTEMPTS/.test(code)) return "arkia is rate-limiting sign-ins. Try again in a few minutes.";
  if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_NOT_FOUND|USER_DISABLED/.test(code)) {
    return "The arkia connection has expired. Reconnect it in Settings.";
  }
  if (/REFERER|referer|API_KEY_HTTP_REFERRER_BLOCKED/.test(code)) {
    return "arkia's Firebase key only accepts requests from the arkia website. Add an unrestricted key for Jarvis in Google Cloud and set NEXT_PUBLIC_ARKIA_API_KEY.";
  }
  return `arkia sign-in failed (${code}).`;
}

async function googleJson(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(400, friendly(String(data?.error?.message || res.status)));
  return data;
}

async function refresh(refreshToken: string) {
  const data = await googleJson(`https://securetoken.googleapis.com/v1/token?key=${env.arkiaApiKey()}`, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return {
    idToken: String(data.id_token),
    refreshToken: String(data.refresh_token),
    uid: String(data.user_id),
    expires: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
}

export async function connectWithPassword(sb: Supa, email: string, password: string) {
  const data = await googleJson(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.arkiaApiKey()}`,
    { email, password, returnSecureToken: true },
  );
  return saveConnection(sb, String(data.refreshToken), String(data.email || email));
}

// Used by the Google sign-in path: the browser signs in to arkia with
// Firebase, hands over the refresh token, and signs straight back out.
export async function connectWithRefreshToken(sb: Supa, refreshToken: string, email: string) {
  return saveConnection(sb, refreshToken, email);
}

async function saveConnection(sb: Supa, refreshToken: string, email: string) {
  const s = await refresh(refreshToken); // proves the token works before keeping it
  const { error } = await sb.from("integrations").upsert({
    arkia_uid: s.uid,
    arkia_email: email.slice(0, 200),
    arkia_token_enc: encrypt(s.refreshToken, env.encryptionKey()),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return { uid: s.uid, email };
}

export async function disconnect(sb: Supa, ownerId: string) {
  sessions.delete(ownerId);
  const { error } = await sb.from("integrations")
    .update({ arkia_uid: null, arkia_email: null, arkia_token_enc: null })
    .eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
}

export async function connection(sb: Supa): Promise<{ uid: string; email: string } | null> {
  const { data } = await sb.from("integrations").select("arkia_uid, arkia_email, arkia_token_enc").maybeSingle();
  return data?.arkia_token_enc ? { uid: String(data.arkia_uid), email: String(data.arkia_email || "") } : null;
}

async function session(sb: Supa, ownerId: string): Promise<Session> {
  const cached = sessions.get(ownerId);
  if (cached && cached.expires - 60_000 > Date.now()) return cached;
  const { data } = await sb.from("integrations").select("arkia_token_enc").maybeSingle();
  if (!data?.arkia_token_enc) throw new HttpError(409, "arkia.buzz is not connected. Connect it in Settings.");
  const stored = decrypt(String(data.arkia_token_enc), env.encryptionKey());
  const s = await refresh(stored);
  if (s.refreshToken && s.refreshToken !== stored) {
    await sb.from("integrations").update({ arkia_token_enc: encrypt(s.refreshToken, env.encryptionKey()) }).eq("owner_id", ownerId);
  }
  const out = { idToken: s.idToken, uid: s.uid, expires: s.expires };
  sessions.set(ownerId, out);
  return out;
}

async function rtdb<T>(s: Session, method: "GET" | "POST" | "PATCH", path: string, body?: unknown, query = ""): Promise<T> {
  const url = `${env.arkiaDatabaseUrl()}/${path}.json?auth=${encodeURIComponent(s.idToken)}${query}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  });
  if (res.status === 401 || res.status === 403) throw new HttpError(403, "arkia's database refused access to " + path.split("/")[0] + ".");
  if (!res.ok) throw new Error(`arkia database error ${res.status}`);
  return (await res.json()) as T;
}

export async function calendarItems(sb: Supa, ownerId: string): Promise<ArkiaItem[]> {
  const s = await session(sb, ownerId);
  const raw = (await rtdb<Record<string, Omit<ArkiaItem, "id">> | null>(s, "GET", `calendar/${s.uid}/items`)) || {};
  return Object.entries(raw)
    .filter(([, v]) => v && Number.isFinite(Number(v.start)))
    .map(([id, v]) => ({ ...v, id, start: Number(v.start) }));
}

export async function addCalendarItem(sb: Supa, ownerId: string, item: {
  type: "event" | "task" | "reminder"; title: string; start: number; end?: number | null;
  allDay?: boolean; notes?: string; location?: string; remind?: number;
}) {
  const s = await session(sb, ownerId);
  const stamp = { ".sv": "timestamp" };
  const row = {
    type: item.type, title: item.title.trim().slice(0, 200), notes: (item.notes || "").slice(0, 20000),
    location: (item.location || "").slice(0, 300), start: item.start,
    end: item.end && item.end > item.start ? item.end : null, allDay: !!item.allDay,
    remind: Number.isFinite(item.remind) ? Math.max(-1, Math.min(40320, Number(item.remind))) : 15,
    repeat: "none", color: "", done: false, doneAt: null, atts: [], source: "Jarvis",
    createdAt: stamp, updatedAt: stamp,
  };
  const res = await rtdb<{ name: string }>(s, "POST", `calendar/${s.uid}/items`, row);
  return res.name;
}

export async function setItemDone(sb: Supa, ownerId: string, id: string, done: boolean, dayKeyForRepeat?: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, "Unknown calendar item.");
  const s = await session(sb, ownerId);
  const patch = dayKeyForRepeat
    ? { [`doneDates/${dayKeyForRepeat}`]: done ? true : null }
    : { done, doneAt: done ? Date.now() : null };
  await rtdb(s, "PATCH", `calendar/${s.uid}/items/${id}`, patch);
}

export type InboxMessage = { id: string; conversationId: string; conversation: string; from: string; text: string; at: number };
export type InboxThread = { id: string; name: string; unread: number; lastText: string; lastFrom: string; updatedAt: number };

type Convo = {
  type?: string; name?: string; names?: Record<string, string>; members?: Record<string, boolean>;
  lastText?: string; lastFrom?: string; updatedAt?: number; reads?: Record<string, number>;
};
type Msg = { from?: string; fromName?: string; text?: string; createdAt?: number; atts?: unknown[] };

function threadName(c: Convo, me: string): string {
  if (c.type === "group" && c.name) return c.name;
  const other = Object.keys(c.members || {}).find((u) => u !== me);
  return (other && c.names?.[other]) || c.name || "a conversation";
}

// Conversations, newest first, with the unread messages of each.
export async function inbox(sb: Supa, ownerId: string, opts: { limit?: number; unreadOnly?: boolean } = {}) {
  const s = await session(sb, ownerId);
  const ids = Object.keys((await rtdb<Record<string, boolean> | null>(s, "GET", `userConversations/${s.uid}`)) || {}).slice(0, 40);
  const convos = await Promise.all(ids.map(async (id) => {
    const c = await rtdb<Convo | null>(s, "GET", `conversations/${id}`).catch(() => null);
    return c ? { id, c } : null;
  }));
  const threads: InboxThread[] = [];
  const messages: InboxMessage[] = [];
  const live = convos.filter(Boolean) as { id: string; c: Convo }[];
  live.sort((a, b) => (b.c.updatedAt || 0) - (a.c.updatedAt || 0));
  for (const { id, c } of live.slice(0, opts.limit ?? 15)) {
    const readAt = c.reads?.[s.uid] || 0;
    const hasUnread = !!c.lastFrom && c.lastFrom !== s.uid && (c.updatedAt || 0) > readAt;
    if (opts.unreadOnly && !hasUnread) continue;
    let unread = 0;
    if (hasUnread) {
      // Push keys sort by time, so $key ordering needs no database index.
      const recent = (await rtdb<Record<string, Msg> | null>(s, "GET", `messages/${id}`, undefined,
        `&orderBy=${encodeURIComponent('"$key"')}&limitToLast=15`).catch(() => null)) || {};
      for (const [mid, m] of Object.entries(recent)) {
        if (!m || m.from === s.uid || (m.createdAt || 0) <= readAt) continue;
        unread++;
        messages.push({
          id: mid, conversationId: id, conversation: threadName(c, s.uid),
          from: m.fromName || c.names?.[m.from || ""] || "Someone",
          text: (m.text || (m.atts?.length ? "[attachment]" : "")).slice(0, 500), at: m.createdAt || 0,
        });
      }
    }
    threads.push({
      id, name: threadName(c, s.uid), unread, lastText: (c.lastText || "").slice(0, 200),
      lastFrom: c.lastFrom === s.uid ? "you" : (c.names?.[c.lastFrom || ""] || "them"), updatedAt: c.updatedAt || 0,
    });
  }
  messages.sort((a, b) => a.at - b.at);
  return { threads, messages };
}
