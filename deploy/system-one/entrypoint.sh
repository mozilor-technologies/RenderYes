#!/bin/sh
# Starts laya-serve, then warms it with one real classification request so the
# first visitor does not pay for the first inference. Signals are forwarded to
# the server so `docker stop` ends it cleanly.
set -eu

laya-serve &
server=$!

trap 'kill -TERM "$server" 2>/dev/null' TERM INT

python /app/probe.py --warm-up &

wait "$server"
