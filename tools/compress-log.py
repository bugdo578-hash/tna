"""Compress a saved development log locally, preserving the original file."""
import argparse
import os
from pathlib import Path
import sys

os.environ["HEADROOM_OFFLINE"] = "1"

from headroom import compress

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("log", type=Path)
args = parser.parse_args()
original = args.log.read_text(encoding="utf-8", errors="replace")
messages = [
    {"role": "user", "content": "Inspect this development log, preserving errors and diagnostics."},
    {"role": "assistant", "content": None, "tool_calls": [
        {"id": "log", "type": "function", "function": {"name": "read_log", "arguments": "{}"}}
    ]},
    {"role": "tool", "tool_call_id": "log", "content": original},
]
result = compress(messages, model="gpt-4o")
print(f"tokens: {result.tokens_before} -> {result.tokens_after}", file=sys.stderr)
for message in result.messages:
    if message.get("role") == "tool":
        print(message.get("content", ""))
