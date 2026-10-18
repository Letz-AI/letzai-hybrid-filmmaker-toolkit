#!/usr/bin/env sh
# LetzAI Hybrid Filmmaker Kit - macOS launcher (double-click in Finder).
# If macOS refuses to open it the first time: right-click, Open.
cd "$(dirname "$0")" || exit 1
exec sh ./start-kit.sh "$@"
