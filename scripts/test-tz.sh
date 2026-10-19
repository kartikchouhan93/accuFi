#!/bin/sh
# Run the whole suite twice: east of UTC (Asia/Kolkata, the app's default zone) and west of it
# (America/New_York). Date handling that only works in one hemisphere must fail here. Extra arguments
# (e.g. a test file path) are forwarded to both runs; the script stops with the first failing run's code.
set -e
TZ=Asia/Kolkata vitest run "$@"
TZ=America/New_York vitest run "$@"
