#!/usr/bin/env bash
# Setup script to symlink the job-callback extension into ~/.pi/agent/extensions/
# This allows Pi to automatically report job results back to pi-remote-web.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
EXT_SOURCE="$PROJECT_ROOT/extensions/job-callback.ts"
EXT_DIR="$HOME/.pi/agent/extensions"
EXT_LINK="$EXT_DIR/job-callback.ts"

if [ ! -f "$EXT_SOURCE" ]; then
	echo "Error: Extension source not found at $EXT_SOURCE"
	exit 1
fi

mkdir -p "$EXT_DIR"

if [ -L "$EXT_LINK" ]; then
	echo "Removing existing symlink at $EXT_LINK"
	rm "$EXT_LINK"
elif [ -f "$EXT_LINK" ]; then
	echo "Warning: $EXT_LINK exists as a regular file. Backing up to ${EXT_LINK}.bak"
	mv "$EXT_LINK" "${EXT_LINK}.bak"
fi

ln -s "$EXT_SOURCE" "$EXT_LINK"
echo "Symlinked $EXT_SOURCE → $EXT_LINK"
echo "Done! The job-callback extension is now active for all Pi sessions."
