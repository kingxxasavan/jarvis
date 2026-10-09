// Turns an "about me" export (about_me_complete.json) into memories. Facts the
// owner stated directly get high confidence; summaries written by another
// assistant are kept as lower-confidence candidates that Jarvis treats as
// possibly outdated and confirms naturally when they matter.
import type { NewMemory } from "./store.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

// Never imported: export bookkeeping, archived instructions, and contact details
// that add nothing to personalisation but would be sent to the model every turn.
const SKIP_TOP = new Set([
  "schema_version", "export_metadata", "sources", "source_material", "conflicts_and_questions", "jarvis_import_guidance",
]);
const SKIP_KEYS = new Set([
  "email_primary", "email_additional", "phone", "postal_code", "street_address", "source_ids", "status", "notes",
  "thread_id", "message_id", "completeness", "applications_reported", "relationship_gaps", "coverage_limits", "user_spelling_variants",
]);

const SECTION_KIND: Record<string, NewMemory["kind"]> = {
  identity: "identity", location: "identity", contact_and_online_presence: "identity", education: "fact",
  employment: "fact", relationships: "person", skills: "fact", preferences: "preference",
  interests_and_lifestyle: "preference", devices: "fact", projects: "project", goals: "goal", life_story: "event",
};
const SECTION_IMPORTANCE: Record<string, number> = {
  identity: 5, preferences: 4, education: 4, employment: 4, relationships: 4, projects: 4, goals: 4,
  skills: 3, interests_and_lifestyle: 3, location: 3, devices: 3, contact_and_online_presence: 2, life_story: 3,
};

const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const human = (k: string) => k.replace(/_/g, " ").replace(/\bai\b/g, "AI");

function render(v: Json | undefined): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(render).filter(Boolean).join(", ");
  if (isObj(v)) {
    if ("value" in v) return render(v.value);
    return Object.entries(v)
      .filter(([k, x]) => !SKIP_KEYS.has(k) && render(x))
      .map(([k, x]) => `${human(k)}: ${render(x)}`)
      .join("; ");
  }
  return String(v);
}

function confidenceOf(status: Json | undefined): number {
  if (status === "user_stated" || status === "User selected") return 0.9;
  if (status === "provided_by_client_context") return 0.85;
  return 0.6;
}

function fact(path: string[], value: Json | undefined, status: Json | undefined): NewMemory | null {
  const text = render(value).trim();
  if (!text) return null;
  const section = path[0];
  const label = path.slice(1).map(human).join(" > ") || human(section);
  return {
    content: `${human(section)} > ${label}: ${text}`.slice(0, 900),
    kind: SECTION_KIND[section] ?? "fact",
    importance: SECTION_IMPORTANCE[section] ?? 3,
    confidence: confidenceOf(status),
    source: "about_me",
  };
}

// A record in a list (a project, a friend, a job) becomes one memory.
function record(section: string, list: string, item: Obj): NewMemory | null {
  const name = item.name ?? item.employer ?? item.event ?? item.id;
  const rest = Object.fromEntries(Object.entries(item).filter(([k]) => !["name", "id", "employer", "event"].includes(k)));
  const body = render(rest);
  if (!body && !name) return null;
  const head = name ? String(name) : human(section);
  return {
    content: `${human(list)} > ${head}${body ? ": " + body : ""}`.slice(0, 900),
    kind: SECTION_KIND[section] ?? "fact",
    importance: SECTION_IMPORTANCE[section] ?? 3,
    confidence: confidenceOf(item.status),
    source: "about_me",
  };
}

function walk(path: string[], node: Json, out: NewMemory[]) {
  const key = path[path.length - 1];
  if (SKIP_KEYS.has(key)) return;
  if (Array.isArray(node)) {
    if (!node.some(isObj)) {
      const m = fact(path, node, null);
      if (m) out.push(m);
    } else {
      for (const x of node) {
        if (!isObj(x)) continue;
        const m = record(path[0], key, x);
        if (m) out.push(m);
      }
    }
    return;
  }
  if (!isObj(node)) {
    const m = fact(path, node, null);
    if (m) out.push(m);
    return;
  }
  if ("value" in node) {
    const m = fact(path, node.value, node.status);
    if (m) out.push(m);
    return;
  }
  for (const [k, v] of Object.entries(node)) walk([...path, k], v, out);
}

export function profileToMemories(doc: unknown): NewMemory[] {
  if (!isObj(doc as Json)) throw new Error("That file is not a JSON object.");
  const out: NewMemory[] = [];
  for (const [section, node] of Object.entries(doc as Obj)) {
    if (SKIP_TOP.has(section)) continue;
    walk([section], node, out);
  }
  const seen = new Set<string>();
  return out.filter((m) => {
    if (seen.has(m.content)) return false;
    seen.add(m.content);
    return true;
  });
}
