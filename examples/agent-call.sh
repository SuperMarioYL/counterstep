#!/bin/sh
# Pipe one tool call through the counterstep PreToolUse hook — the same
# payload Claude Code sends, so the interception is visible without an agent
# session.
#
#   ./agent-call.sh Bash "rm -rf src/legacy"
#   ./agent-call.sh Bash "git push --force origin main"
#
# stdout carries the hook decision JSON; a deny exits 2, like Claude Code.
tool="$1"
command="$2"
escaped=$(printf '%s' "$command" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '{"tool_name":"%s","tool_input":{"command":"%s"}}\n' "$tool" "$escaped" | counterstep hook
