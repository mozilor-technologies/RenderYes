"""Health check and warm-up for the System One container.

Sends the same request shape `@renderyes/server` sends — a prompt, the model
name `renderyes`, and a `questions` block with one `choice` question over
capability ids plus `none`, and one `noul` in-scope question — and checks that
the answer names one of the offered choices.

    python probe.py             one request; exit 0 when the model answered
    python probe.py --warm-up   wait for the server, then send the request and
                                log load time and the first-request latency

Standard library only: the slim image has no curl.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

PORT = os.environ.get("LAYA_PORT", "8000").strip() or "8000"
BASE = f"http://127.0.0.1:{PORT}"
MODEL = "renderyes"

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from anywhere, with -I too
from systemone_questions import build_questions

# The site name and the two capabilities are illustrative; what matters is
# that the question block is built by the same code the training data uses.
REQUEST = {
    "model": MODEL,
    "state": {"request": "show me the politics coverage"},
    "questions": build_questions(
        "The Bharat Times, a newsroom",
        [
            (
                "bharat-times.posts.list",
                "Published news articles. Use for latest stories, articles on a topic, "
                "coverage in a section.",
            ),
            (
                "bharat-times.posts.count",
                "How many articles have been published in total. A single count.",
            ),
        ],
    ),
}


def headers() -> dict[str, str]:
    out = {"content-type": "application/json"}
    key = os.environ.get("LAYA_API_KEY")
    if key:
        out["authorization"] = f"Bearer {key}"
    return out


def classify(timeout: float) -> tuple[dict, float]:
    """One decision request. Returns the answers block and the round trip in seconds."""
    body = json.dumps(REQUEST).encode()
    request = urllib.request.Request(
        f"{BASE}/v1/systemone", data=body, headers=headers(), method="POST"
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    elapsed = time.monotonic() - started
    answers = payload.get("answers") if isinstance(payload, dict) else None
    if not isinstance(answers, dict):
        raise RuntimeError(f"no answers block in response: {payload!r}")
    choice = answers.get("capability", {}).get("choice")
    offered = REQUEST["questions"]["capability"]["criteria"]
    if choice not in offered:
        raise RuntimeError(f"choice {choice!r} is not one of the offered capabilities")
    return answers, elapsed


def check() -> int:
    try:
        answers, elapsed = classify(timeout=12.0)
    except Exception as error:  # noqa: BLE001 - any failure is "unhealthy"
        print(f"unhealthy: {error}", file=sys.stderr)
        return 1
    print(
        f"healthy: {answers['capability']['choice']} "
        f"({answers['capability'].get('confidence')}) in {elapsed * 1000:.0f} ms"
    )
    return 0


def warm_up() -> int:
    deadline = time.monotonic() + float(os.environ.get("LAYA_WARMUP_TIMEOUT", "900"))
    started = time.monotonic()
    while True:
        try:
            with urllib.request.urlopen(f"{BASE}/health", timeout=5) as response:
                if response.status == 200:
                    break
        except (urllib.error.URLError, OSError, TimeoutError):
            pass
        if time.monotonic() > deadline:
            print("warm-up: server did not come up in time", file=sys.stderr)
            return 1
        time.sleep(0.5)
    loaded = time.monotonic() - started
    print(f"warm-up: server answering after {loaded:.1f} s (checkpoint loaded)")
    try:
        answers, first = classify(timeout=120.0)
        _, second = classify(timeout=120.0)
    except Exception as error:  # noqa: BLE001
        print(f"warm-up: first request failed: {error}", file=sys.stderr)
        return 1
    print(
        f"warm-up: first request {first * 1000:.0f} ms, second {second * 1000:.0f} ms; "
        f"chose {answers['capability']['choice']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(warm_up() if "--warm-up" in sys.argv[1:] else check())
