#!/bin/sh
# Fine-tune the RenderYes System One checkpoint on an owner's prompts.
#
#   ./train.sh <base-checkpoint-dir> <data-dir> <out-dir>
#
# <base-checkpoint-dir>  the RenderYes checkpoint (what you mount at /models/renderyes)
# <data-dir>             where prepare_training_data.py wrote train.jsonl and test.jsonl
# <out-dir>              where the new checkpoint is written; mount this afterwards
#
# Environment overrides, all optional:
#   DEVICE=auto|cpu|cuda|mps   EPOCHS=2   MICRO_BATCH=2   GRAD_ACCUM=16
#
# The flags are the ones the RenderYes checkpoint itself was trained with:
# soft cross-entropy and shuffled option order. micro-batch 2 with 16
# accumulation steps fits the 421M-parameter model in 16 GB of unified
# memory; raise MICRO_BATCH on a GPU with more. Runs in a Python environment
# with `pip install laya==0.4.12` and a torch build for your device, not in
# the serving container (its torch is CPU-only).
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <base-checkpoint-dir> <data-dir> <out-dir>" >&2
  exit 2
fi
BASE=$1
DATA=$2
OUT=$3

EVAL=""
if [ -f "$DATA/test.jsonl" ]; then
  EVAL="--eval $DATA/test.jsonl"
fi

exec laya-train \
  --data "$DATA/train.jsonl" $EVAL --out "$OUT" --base "$BASE" \
  --loss soft-ce --shuffle-options \
  --epochs "${EPOCHS:-2}" --micro-batch "${MICRO_BATCH:-2}" --grad-accum "${GRAD_ACCUM:-16}" \
  --max-len 512 --head-max-len 256 --device "${DEVICE:-auto}" --seed 0
