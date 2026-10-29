"""Turn an owner's labelled prompts into Laya training data for System One.

    python prepare_training_data.py --catalog catalog.json --prompts prompts.csv --out data/

`catalog.json` is the approved capability catalog (the file the review UI
downloads; it has `description` and `capabilities[].{id,purpose}`).
`prompts.csv` has a header row and two columns:

    prompt,capability
    show me the politics coverage,bharat-times.posts.list
    delete my account,none

`capability` is an id from the catalog, or `none` for a prompt the catalog
must refuse (an action, someone else's data, external data, an instruction
override). `in_scope` is derived: true for a capability, false for `none`.

Writes `train.jsonl` and `test.jsonl` in the record shape `laya-train` reads,
split per label so every capability with at least two prompts is represented
in the held-out set. Each record carries the same `questions` block the server
sends at inference time, built by `systemone_questions.py` from the catalog.

Options:
    --test-fraction 0.15   share of each label held out (0 writes no test set)
    --seed 0               shuffle seed
    --capabilities a,b     restrict the choices to these ids, the way the server
                           advertises only capabilities a component can render
    --mix general.jsonl    append records from a general training set to
                           train.jsonl only, to keep the model's breadth

Standard library only.
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # run from anywhere, with -I too
from systemone_questions import NONE_ID, questions_from_catalog

MIN_PROMPTS_PER_LABEL = 10


def read_prompts(path: Path) -> list[tuple[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None or {"prompt", "capability"} - set(reader.fieldnames):
            raise SystemExit("prompts.csv needs a header with `prompt` and `capability` columns")
        rows = []
        for number, row in enumerate(reader, start=2):
            prompt = (row.get("prompt") or "").strip()
            label = (row.get("capability") or "").strip()
            if not prompt or not label:
                print(f"warning: line {number}: empty prompt or capability, skipped", file=sys.stderr)
                continue
            rows.append((prompt, label))
    return rows


def dedupe(rows: list[tuple[str, str]]) -> list[tuple[str, str]]:
    seen: dict[str, str] = {}
    out = []
    for prompt, label in rows:
        key = " ".join(prompt.lower().split())
        if key in seen:
            if seen[key] != label:
                print(
                    f"warning: {prompt!r} appears with two labels ({seen[key]}, {label}); "
                    "keeping the first",
                    file=sys.stderr,
                )
            continue
        seen[key] = label
        out.append((prompt, label))
    return out


def split(
    rows: list[tuple[str, str]], fraction: float, seed: int
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    by_label: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for row in rows:
        by_label[row[1]].append(row)
    rng = random.Random(seed)
    train, test = [], []
    for label in sorted(by_label):
        group = by_label[label]
        rng.shuffle(group)
        held = round(len(group) * fraction) if fraction > 0 else 0
        if fraction > 0 and len(group) >= 2:
            held = max(1, held)
        held = min(held, len(group) - 1) if len(group) > 1 else 0
        test.extend(group[:held])
        train.extend(group[held:])
    rng.shuffle(train)
    rng.shuffle(test)
    return train, test


def record(prompt: str, label: str, questions: dict) -> dict:
    return {
        "state": {"request": prompt},
        "questions": questions,
        "expected": {"capability": label, "in_scope": label != NONE_ID},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--prompts", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--test-fraction", type=float, default=0.15)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--capabilities", default=None, help="comma-separated ids to offer")
    parser.add_argument("--mix", type=Path, default=None)
    args = parser.parse_args()
    if not 0 <= args.test_fraction < 1:
        raise SystemExit("--test-fraction must be in [0, 1)")

    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    offered = [c.strip() for c in args.capabilities.split(",")] if args.capabilities else None
    questions = questions_from_catalog(catalog, offered)
    choices = set(questions["capability"]["criteria"])

    rows = dedupe(read_prompts(args.prompts))
    bad = sorted({label for _, label in rows if label not in choices})
    if bad:
        raise SystemExit(
            "these labels are not capabilities the catalog offers (or `none`): " + ", ".join(bad)
        )

    counts = Counter(label for _, label in rows)
    for label in sorted(choices - {NONE_ID}):
        if counts[label] == 0:
            print(f"warning: no prompts for {label}; the model will not learn it", file=sys.stderr)
        elif counts[label] < MIN_PROMPTS_PER_LABEL:
            print(
                f"warning: only {counts[label]} prompts for {label}; aim for at least "
                f"{MIN_PROMPTS_PER_LABEL} in varied styles",
                file=sys.stderr,
            )
    if counts[NONE_ID] == 0:
        print(
            "warning: no `none` prompts; add refusals (actions, other people's data, external "
            "data, instruction overrides) or the model will never learn to say no",
            file=sys.stderr,
        )

    train, test = split(rows, args.test_fraction, args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    with (args.out / "train.jsonl").open("w", encoding="utf-8") as handle:
        for prompt, label in train:
            handle.write(json.dumps(record(prompt, label, questions)) + "\n")
        mixed = 0
        if args.mix:
            with args.mix.open(encoding="utf-8") as general:
                for line in general:
                    if line.strip():
                        json.loads(line)  # fail early on a broken line
                        handle.write(line.rstrip("\n") + "\n")
                        mixed += 1
    if test:
        with (args.out / "test.jsonl").open("w", encoding="utf-8") as handle:
            for prompt, label in test:
                handle.write(json.dumps(record(prompt, label, questions)) + "\n")

    width = max(len(label) for label in choices)
    print(f"{'label'.ljust(width)}  train  test")
    train_counts = Counter(label for _, label in train)
    test_counts = Counter(label for _, label in test)
    for label in sorted(choices):
        print(f"{label.ljust(width)}  {train_counts[label]:5d}  {test_counts[label]:4d}")
    print(f"{'total'.ljust(width)}  {len(train):5d}  {len(test):4d}")
    if args.mix:
        print(f"plus {mixed} general records appended to train.jsonl")
    print(f"wrote {args.out / 'train.jsonl'}" + (f" and {args.out / 'test.jsonl'}" if test else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
