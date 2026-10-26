#!/usr/bin/env bash
# Records the README GIFs in a throwaway Obsidian (own profile and vault), dark and light, into docs/.
# Needs the Obsidian snap, ffmpeg, Node 20+ and playwright-core (the npx cache of @playwright/mcp has it).
# An Obsidian window opens while it runs.
set -euo pipefail
cd "$(dirname "$0")"
export PLAYWRIGHT_CORE=${PLAYWRIGHT_CORE:-$(ls -d ~/.npm/_npx/*/node_modules/playwright-core | head -1)}
for theme in dark light; do THEME=$theme node demo-gifs.cjs; done
