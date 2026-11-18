#!/usr/bin/env python3
"""Run a command on a pseudo-terminal and type answers to its prompts.

The aquaman CLI reads secrets differently when stdin is a terminal (raw mode,
no echo, one key at a time). This gives a test a terminal without a person:

    python3 cov-cli-hosts-pty.py SPEC.json

SPEC: {"argv": [...], "answers": [[prompt, keys], ...], "timeout": seconds}
Each answer is typed one key at a time once its prompt has appeared in the
output, the way a person types; a final "\\r" is sent after a pause so it
always arrives as a key of its own. Everything the terminal showed is written
to stdout as JSON: {"output": str, "code": int}.
"""
import json
import os
import pty
import select
import sys
import time


def main() -> int:
    with open(sys.argv[1], encoding="utf-8") as f:
        spec = json.load(f)
    answers = list(spec.get("answers", []))
    deadline = time.time() + float(spec.get("timeout", 60))

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(spec["argv"][0], spec["argv"])

    output = b""
    seen = 0
    code = None
    while True:
        if time.time() > deadline:
            os.kill(pid, 9)
            break
        try:
            ready, _, _ = select.select([fd], [], [], 0.1)
        except OSError:
            break
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                break
            output += chunk
        while answers:
            prompt = answers[0][0].encode()
            at = output.find(prompt, seen)
            if at == -1:
                break
            seen = at + len(prompt)
            keys = answers.pop(0)[1]
            time.sleep(0.3)  # let the program switch the terminal to raw mode
            for i, key in enumerate(keys):
                if key == "\r" and i == len(keys) - 1:
                    time.sleep(0.4)
                os.write(fd, key.encode())
                time.sleep(0.08)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    sys.stdout.write(json.dumps({"output": output.decode("utf-8", "replace"), "code": code}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
