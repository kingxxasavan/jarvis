import { HttpError, readJson, route } from "@/lib/auth.ts";
import { profileToMemories } from "@/lib/memory/profileImport.ts";
import { addMemories } from "@/lib/memory/store.ts";

export const runtime = "nodejs";
export const maxDuration = 120;

// Imports an "about me" export. Re-importing replaces the previous import, so
// running it twice never duplicates anything; memories learned in chat stay.
export const POST = route(async ({ sb }, req) => {
  const doc = await readJson(req, 3_000_000);
  let items;
  try {
    items = profileToMemories(doc);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "Unreadable file.");
  }
  if (!items.length) throw new HttpError(400, "Found nothing to import in that file.");
  const { error } = await sb.from("memories").delete().eq("source", "about_me");
  if (error) throw new Error(error.message);
  const added = await addMemories(sb, items);
  return { added };
});
