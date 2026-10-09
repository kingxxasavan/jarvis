// Pure-logic tests: node --test --experimental-strip-types tests/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { allBetween, occurrences, type ArkiaItem } from "../src/lib/arkia/calendar.ts";
import { decrypt, encrypt } from "../src/lib/crypto.ts";
import { parseOps } from "../src/lib/memory/adapt.ts";
import { profileToMemories } from "../src/lib/memory/profileImport.ts";
import { addDays, dayKey, parseWhen, zonedParts, zonedToUtc } from "../src/lib/time.ts";
import { parseTakeout } from "../src/lib/youtube/takeout.ts";

const TZ = "America/New_York";

test("wall time converts both ways, across daylight saving", () => {
  const summer = zonedToUtc(2026, 7, 4, 15, 30, TZ);
  assert.equal(new Date(summer).toISOString(), "2026-07-04T19:30:00.000Z");
  const winter = zonedToUtc(2026, 12, 25, 9, 0, TZ);
  assert.equal(new Date(winter).toISOString(), "2026-12-25T14:00:00.000Z");
  assert.deepEqual(zonedParts(winter, TZ), { y: 2026, m: 12, d: 25, h: 9, mi: 0, s: 0 });
});

test("adding days keeps the wall-clock time over the DST change", () => {
  const before = zonedToUtc(2026, 10, 31, 8, 0, TZ); // EDT
  const after = addDays(before, 2, TZ); // Nov 2, EST
  assert.equal(zonedParts(after, TZ).h, 8);
  assert.equal(dayKey(after, TZ), "2026-11-02");
});

test("parseWhen reads local dates and times", () => {
  assert.equal(parseWhen("2026-10-14", TZ), zonedToUtc(2026, 10, 14, 0, 0, TZ));
  assert.equal(parseWhen("2026-10-14T15:30", TZ), zonedToUtc(2026, 10, 14, 15, 30, TZ));
  assert.equal(parseWhen("next tuesday", TZ), null);
});

test("weekday repeats skip weekends; done days are per occurrence", () => {
  const mon = zonedToUtc(2026, 10, 5, 16, 0, TZ);
  const item: ArkiaItem = { id: "a", type: "task", title: "Practice", start: mon, repeat: "weekdays", doneDates: { "2026-10-06": true } };
  const occ = occurrences(item, mon, addDays(mon, 7, TZ), TZ);
  assert.deepEqual(occ.map((o) => dayKey(o.start, TZ)), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.deepEqual(occ.map((o) => o.done), [false, true, false, false, false]);
});

test("monthly repeats skip months without that day, like arkia", () => {
  const jan31 = zonedToUtc(2026, 1, 31, 12, 0, TZ);
  const item: ArkiaItem = { id: "m", type: "event", title: "Pay", start: jan31, repeat: "monthly" };
  const occ = occurrences(item, jan31, zonedToUtc(2026, 6, 1, 0, 0, TZ), TZ);
  assert.deepEqual(occ.map((o) => dayKey(o.start, TZ)), ["2026-01-31", "2026-03-31", "2026-05-31"]);
});

test("until ends a repeat; allBetween sorts", () => {
  const d = zonedToUtc(2026, 10, 1, 9, 0, TZ);
  const a: ArkiaItem = { id: "a", start: d, repeat: "daily", until: addDays(d, 2, TZ) };
  const b: ArkiaItem = { id: "b", start: addDays(d, 1, TZ) - 3_600_000 };
  const all = allBetween([a, b], d, addDays(d, 10, TZ), TZ);
  assert.equal(all.filter((o) => o.item.id === "a").length, 3);
  assert.deepEqual(all.map((o) => o.item.id), ["a", "b", "a", "a"]);
});

test("secrets round-trip and tampering is detected", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const sealed = encrypt("refresh-token", key);
  assert.equal(decrypt(sealed, key), "refresh-token");
  const parts = sealed.split(".");
  parts[3] = Buffer.from("tampered!!").toString("base64");
  assert.throws(() => decrypt(parts.join("."), key));
});

test("memory operations are parsed defensively", () => {
  assert.deepEqual(parseOps('Sure! {"ops":[{"op":"add","content":"Likes chess","kind":"preference"}]}'), [
    { op: "add", content: "Likes chess", kind: "preference" },
  ]);
  assert.deepEqual(parseOps('{"ops":[{"op":"delete"},{"op":"update","id":"x","content":"y"}]}'), [{ op: "update", id: "x", content: "y" }]);
  assert.deepEqual(parseOps("no json here"), []);
});

test("profile import skips contact details and keeps confidence", () => {
  const mems = profileToMemories({
    export_metadata: { title: "x" },
    identity: { age: { value: 17, status: "user_stated" }, pronouns: { value: null, status: "unknown" } },
    contact_and_online_presence: { phone: { value: "555", status: "x" }, github: { value: "https://github.com/me", status: "x" } },
    projects: [{ id: "p", name: "Poly OS", status: "Planned", description: "Linux desktop" }],
  });
  const text = mems.map((m) => m.content).join("\n");
  assert.ok(text.includes("identity > age: 17"));
  assert.ok(!text.includes("555") && !text.includes("pronouns"));
  assert.equal(mems.find((m) => m.content.includes("age"))?.confidence, 0.9);
  assert.equal(mems.find((m) => m.content.includes("github"))?.confidence, 0.6);
  assert.ok(mems.some((m) => m.kind === "project" && m.content.startsWith("projects > Poly OS")));
});

test("takeout history keeps only real video entries", () => {
  const rows = parseTakeout([
    { title: "Watched Cool Video", titleUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", time: "2026-09-01T10:00:00Z", subtitles: [{ name: "Chan" }] },
    { title: "Visited YouTube Music", time: "2026-09-01T10:00:00Z" },
    { title: "Watched a removed video", titleUrl: "https://www.youtube.com/watch?v=bad", time: "2026-09-01T10:00:00Z" },
  ]);
  assert.deepEqual(rows, [{ v: "dQw4w9WgXcQ", t: "Cool Video", c: "Chan", w: "2026-09-01T10:00:00.000Z" }]);
  assert.throws(() => parseTakeout({}));
});
