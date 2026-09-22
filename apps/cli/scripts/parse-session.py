#!/usr/bin/env python3
"""Reconstruct a readable conversation from a Codex CLI session rollout (.jsonl).

Usage:
    scripts/parse-session.py old.txt                    # markdown, messages only
    scripts/parse-session.py old.txt --tools            # include tool calls + output
    scripts/parse-session.py old.txt --reasoning        # include reasoning summaries
    scripts/parse-session.py old.txt -f json -o out.json
    scripts/parse-session.py old.txt --raw              # don't strip injected context

Each line is {timestamp, ordinal, type, payload}. The real conversation lives in
`response_item` records; `event_msg` / `token_usage_record` are UI + accounting
duplicates and are ignored.
"""

import argparse
import json
import re
import sys

SYNTHETIC = [
    (re.compile(r"^# AGENTS\.md instructions"), "agents.md"),
    (re.compile(r"^<user_instructions>"), "user-instructions"),
    (re.compile(r"^<environment_context>"), "environment"),
    (re.compile(r"^<codex_internal_context"), "codex-internal"),
]
OBJECTIVE = re.compile(r"<objective>\s*(.*?)\s*</objective>", re.S)


def text_of(content):
    """Flatten a content list (or bare string) into plain text."""
    if isinstance(content, str):
        return content
    out = []
    for part in content or []:
        if isinstance(part, str):
            out.append(part)
        elif isinstance(part, dict):
            out.append(part.get("text") or part.get("output") or "")
    return "\n".join(p for p in out if p)


def classify(body):
    for pattern, kind in SYNTHETIC:
        if pattern.search(body.lstrip()):
            return kind
    return None


def walk(items, events, seq=0):
    """Yield normalized events from a list of response_item payloads."""
    for p in items:
        if not isinstance(p, dict):
            continue
        kind = p.get("type")

        if kind == "message":
            body = text_of(p.get("content"))
            role = p.get("role", "unknown")
            # Developer-role turns are the harness preamble, never conversation.
            synthetic = "developer-preamble" if role == "developer" else classify(body)
            goal = OBJECTIVE.search(body) if synthetic == "codex-internal" else None
            events.append({
                "kind": "message",
                "role": role,
                "text": goal.group(1) if goal else body,
                "synthetic": synthetic,
                "goal": bool(goal),
            })

        elif kind in ("custom_tool_call", "function_call"):
            events.append({
                "kind": "tool_call",
                "role": "assistant",
                "name": p.get("name", "?"),
                "call_id": p.get("call_id"),
                "text": p.get("input") or p.get("arguments") or "",
            })

        elif kind in ("custom_tool_call_output", "function_call_output"):
            events.append({
                "kind": "tool_output",
                "role": "tool",
                "call_id": p.get("call_id"),
                "text": text_of(p.get("output")),
            })

        elif kind == "reasoning":
            summary = text_of(p.get("summary")) or ""
            events.append({
                "kind": "reasoning",
                "role": "assistant",
                "text": summary,
                "encrypted": not summary,
            })
    return events


def load(path):
    events, meta, bad = [], {}, 0
    fh = sys.stdin if path == "-" else open(path, encoding="utf-8", errors="replace")
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            payload = rec.get("payload")
            if not isinstance(payload, dict):
                continue
            rtype = rec.get("type")

            if rtype == "session_meta":
                meta = {k: payload.get(k) for k in ("session_id", "cwd", "cli_version", "originator", "model_provider")}
                meta["started"] = rec.get("timestamp")
            elif rtype == "response_item":
                before = len(events)
                walk([payload], events)
                for e in events[before:]:
                    e["ts"] = rec.get("timestamp")
            elif rtype == "compacted":
                # A compaction replaced history; splice the replacement back in.
                before = len(events)
                walk(payload.get("replacement_history") or [], events)
                for e in events[before:]:
                    e.setdefault("ts", rec.get("timestamp"))
                    e["compacted"] = True
    return meta, events, bad


def clip(text, limit):
    text = (text or "").rstrip()
    if limit and len(text) > limit:
        return text[:limit] + f"\n... [+{len(text) - limit} chars truncated]"
    return text


def render(meta, events, args):
    md = args.format == "md"
    out = []
    if meta:
        head = [f"{k}: {v}" for k, v in meta.items() if v]
        out.append(("# Session\n\n" if md else "SESSION\n") + "\n".join(head) + "\n")

    for e in events:
        kind, role = e["kind"], e["role"]
        if kind == "reasoning" and not args.reasoning:
            continue
        if kind in ("tool_call", "tool_output") and not args.tools:
            continue
        if e.get("synthetic") and not args.raw and not e.get("goal"):
            continue
        body = clip(e["text"], args.max_chars)
        if not body and kind != "reasoning":
            continue

        tag = role.upper()
        if kind == "tool_call":
            tag = f"TOOL CALL {e['name']}"
        elif kind == "tool_output":
            tag = "TOOL OUTPUT"
        elif kind == "reasoning":
            tag = "REASONING"
            body = body or "(encrypted, not stored in plaintext)"
        elif e.get("goal"):
            tag = "USER (thread goal)"
        elif e.get("synthetic"):
            tag = f"{tag} (injected: {e['synthetic']})"
        if e.get("compacted"):
            tag += " [pre-compaction]"

        if md:
            out.append(f"## {tag}  \n`{e.get('ts','')}`\n")
            if kind in ("tool_call", "tool_output"):
                out.append("```\n" + body.replace("```", "``​`") + "\n```\n")
            else:
                out.append(body + "\n")
        else:
            out.append(f"----- {tag}  {e.get('ts','')}\n{body}\n")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="session .jsonl file, or - for stdin")
    ap.add_argument("-f", "--format", choices=["md", "txt", "json"], default="md")
    ap.add_argument("-o", "--output", help="write here instead of stdout")
    ap.add_argument("--tools", action="store_true", help="include tool calls and their output")
    ap.add_argument("--reasoning", action="store_true", help="include reasoning items")
    ap.add_argument("--raw", action="store_true", help="keep injected/system context messages")
    ap.add_argument("--max-chars", type=int, default=2000, help="truncate each block (0 = no limit)")
    ap.add_argument("--stats", action="store_true", help="print a counts summary to stderr")
    args = ap.parse_args()

    meta, events, bad = load(args.path)

    if args.format == "json":
        text = json.dumps({"meta": meta, "events": events}, indent=2)
    else:
        text = render(meta, events, args)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"wrote {args.output} ({len(text)} chars, {len(events)} events)", file=sys.stderr)
    else:
        sys.stdout.write(text)

    if args.stats or bad:
        counts = {}
        for e in events:
            key = e["kind"] if e["kind"] != "message" else f"message:{e['role']}"
            counts[key] = counts.get(key, 0) + 1
        print(f"\n[stats] {counts}" + (f" unparseable_lines={bad}" if bad else ""), file=sys.stderr)


if __name__ == "__main__":
    main()
