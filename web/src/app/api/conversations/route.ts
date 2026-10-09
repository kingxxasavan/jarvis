import { route } from "@/lib/auth.ts";

export const runtime = "nodejs";

// The most recent conversation (or a given one) with its last 40 messages.
export const GET = route(async ({ sb }, req) => {
  const wanted = new URL(req.url).searchParams.get("id");
  const q = sb.from("conversations").select("id, title, updated_at");
  const { data: conv } = wanted
    ? await q.eq("id", wanted).maybeSingle()
    : await q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (!conv) return { conversation: null, messages: [] };
  const { data: messages } = await sb.from("messages").select("id, role, content, meta, created_at")
    .eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(40);
  return { conversation: conv, messages: (messages || []).reverse() };
});
