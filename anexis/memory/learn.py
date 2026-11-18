"""Learning: after each exchange, work out what is worth keeping. Plus the
upkeep that runs every hour: summaries, vectors, merging twins, decay.

A small model proposes changes as JSON. This code decides what actually
happens, so a confused model can never wreck the memory: unknown ids are
ignored, repeats reinforce instead of piling up, and anything unreadable is
dropped.
"""

from __future__ import annotations

import json

from anexis.memory.store import KINDS, Memory, words
from anexis.memory.style import distill_style

PROMPT = """You keep the long term memory of a personal assistant. Read the exchange below and decide what is worth remembering about the owner for future conversations.

Keep: lasting facts about the owner, preferences, habits, classes and schedule, work, projects, people in their life, standing tasks, and corrections of how the assistant should behave (those are kind "lesson").
Skip: small talk, one time questions, things only true right now, general knowledge, and anything the assistant said that the owner did not say or confirm.

Memories that already exist and may be related:
{related}

Reply with JSON only, in this shape: {{"ops": [ ... ]}}
Each op is one of:
{{"op": "add", "kind": "{kinds}", "text": "one clear sentence about the owner", "importance": 0.0 to 1.0}}
{{"op": "reinforce", "id": N}}   when an existing memory was confirmed again
{{"op": "replace", "id": N, "text": "the new truth"}}   when an existing memory changed
Use an empty list when nothing is worth keeping. Most exchanges have nothing."""


def parse_json(raw: str):
    """Pulls the first JSON object out of a model reply, ignoring chatter and code fences."""
    start = raw.find("{")
    while start >= 0:
        depth, in_string, escaped = 0, False, False
        for i in range(start, len(raw)):
            ch = raw[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
            elif ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(raw[start : i + 1])
                    except ValueError:
                        break
        start = raw.find("{", start + 1)
    return None


class Learner:
    MAX_OPS = 6

    def __init__(self, memory: Memory, router):
        self.memory = memory
        self.router = router

    async def _embed(self, texts: list[str], kind: str = "passage"):
        try:
            return await self.router.embed(texts, kind)
        except Exception:
            return None

    async def learn(self, user_text: str, assistant_text: str) -> list[dict]:
        """Returns the list of changes made, each also written to the event log."""
        if len(words(user_text)) < 4:
            return []
        query = await self._embed([user_text], "query")
        tag, query_vec = (query[0], query[1][0]) if query else (None, None)
        related = self.memory.search(user_text, k=6, query_vec=query_vec, model=tag)
        shown = {m.id for m in related}
        listing = "\n".join(f"#{m.id} [{m.kind}] {m.text}" for m in related) or "(none)"
        messages = [
            {"role": "system", "content": PROMPT.format(related=listing, kinds="|".join(KINDS))},
            {"role": "user", "content": f"Owner said:\n{user_text[:4000]}\n\nAssistant replied:\n{assistant_text[:2000]}\n\nExisting memories:\n{listing}"},
        ]
        try:
            reply = await self.router.chat("small", messages)
        except Exception as e:
            self.memory.log("learn_failed", {"error": str(e)[:200]})
            return []
        data = parse_json(reply.content)
        ops = data.get("ops") if isinstance(data, dict) else None
        if not isinstance(ops, list):
            return []

        done: list[dict] = []
        fresh: list[int] = []
        for op in ops[: self.MAX_OPS]:
            if not isinstance(op, dict):
                continue
            change = self._apply(op, shown, fresh)
            if change:
                self.memory.log("learn", change)
                done.append(change)

        if fresh:
            texts = [self.memory.get(i).text for i in fresh]
            vectors = await self._embed(texts)
            if vectors:
                for memory_id, vec in zip(fresh, vectors[1]):
                    self.memory.set_vector(memory_id, vectors[0], vec)
        return done

    def _apply(self, op: dict, shown: set[int], fresh: list[int]) -> dict | None:
        action = op.get("op")
        target = op.get("id") if isinstance(op.get("id"), int) else None
        body = str(op.get("text") or "").strip()

        if action == "reinforce":
            if target in shown:
                self.memory.reinforce(target)
                return {"op": "reinforce", "id": target}
            return None

        if action not in ("add", "replace") or not 5 <= len(body) <= 400:
            return None

        if action == "replace" and target in shown:
            new_id = self.memory.supersede(target, body, op.get("kind") if op.get("kind") in KINDS else None)
            fresh.append(new_id)
            return {"op": "replace", "id": new_id, "old": target, "text": body}

        # A plain add, or a replace that named a memory the model was never shown.
        duplicate = self.memory.find_duplicate(body)
        if duplicate:
            self.memory.reinforce(duplicate)
            return {"op": "reinforce", "id": duplicate}
        kind = op.get("kind") if op.get("kind") in KINDS else "fact"
        try:
            importance = float(op.get("importance", 0.5))
        except (TypeError, ValueError):
            importance = 0.5
        new_id = self.memory.add(
            kind, body, confidence=0.85 if kind == "lesson" else 0.6,
            importance=max(importance, 0.8) if kind == "lesson" else importance,
        )
        fresh.append(new_id)
        return {"op": "add", "id": new_id, "memory_kind": kind, "text": body}


# ---- hourly upkeep ----------------------------------------------------------

SUMMARY_PROMPT = (
    "Summarize this conversation between the owner and their assistant in at most four "
    "sentences. Keep decisions, plans, open questions and anything the owner will want "
    "picked up later. Reply with the summary only."
)


async def consolidate(memory: Memory, router) -> dict:
    report = {"summaries": 0, "embedded": 0, "merged": 0, "decayed": 0, "style": 0}
    report["style"] = int(await distill_style(memory, router))

    for session in memory.sessions_needing_summary():
        fresh = memory.history(session["id"], limit=60, after_id=session["summarized_upto"])
        transcript = "\n".join(f"{m['role']}: {m['content'][:800]}" for m in fresh)
        if session["summary"]:
            transcript = f"Summary so far: {session['summary']}\n\n{transcript}"
        try:
            reply = await router.chat(
                "small",
                [{"role": "system", "content": SUMMARY_PROMPT}, {"role": "user", "content": transcript}],
            )
        except Exception:
            break  # no model right now, try again next round
        if reply.content.strip():
            memory.set_summary(session["id"], reply.content.strip(), fresh[-1]["id"])
            report["summaries"] += 1

    # Give vectors to memories that have none for the current embedding model.
    try:
        probe = await router.embed(["probe"])
    except Exception:
        probe = None
    if probe:
        tag = probe[0]
        while True:
            missing = memory.missing_vectors(tag)
            if not missing:
                break
            result = await router.embed([m.text for m in missing])
            if not result or result[0] != tag:
                break
            for row, vec in zip(missing, result[1]):
                memory.set_vector(row.id, tag, vec)
            report["embedded"] += len(missing)

    for row in memory.list(limit=500):
        current = memory.get(row.id)
        if current is None or current.superseded_by is not None:
            continue  # already folded into another one this round
        twin_id = memory.find_duplicate(current.text, exclude=current.id)
        if twin_id is None:
            continue
        twin = memory.get(twin_id)
        weak, strong = sorted((current, twin), key=lambda m: (m.pinned, m.confidence, m.use_count))
        memory.merge(weak.id, strong.id)
        memory.log("merge", {"kept": strong.id, "folded": weak.id})
        report["merged"] += 1

    report["decayed"] = memory.decay()
    return report
