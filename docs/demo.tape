# Counterstep demo — the 30-second session from the README.
#
# Render from the repository root:  vhs docs/demo.tape
# Requires `counterstep` on PATH (npm i -g counterstep, or npm link in a
# checkout) plus vhs + ttyd + ffmpeg. Output lands in docs/demo.gif.

Output docs/demo.gif

Set FontSize 18
Set Width 1000
Set Height 620
Set Framerate 15
Set Shell bash
Set Padding 24
Set TypingSpeed 10ms
Set Theme { "background": "#0d1117", "foreground": "#e6edf3", "cursor": "#3fb950", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#6e7681", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#f0f6fc" }

# --- setup: a scratch repo wired to a bare remote; the counterstep checkout
# root is captured so the hook-driver script ships along. Everything the
# viewer sees runs the real binary; only this setup is hidden.
Hide
Type 'export CS_ROOT=$PWD' Enter
Type 'rm -rf /tmp/counterstep-demo && mkdir -p /tmp/counterstep-demo/remote.git /tmp/counterstep-demo/app' Enter
Type 'cd /tmp/counterstep-demo && git init -q --bare remote.git' Enter
Type 'cd app && git init -q -b main' Enter
Type 'git config user.email demo@example.com && git config user.name demo' Enter
Type 'git remote add origin ../remote.git' Enter
Type 'mkdir -p src/legacy && echo legacy helper v1 > src/legacy/util.js && echo scratch notes > src/legacy/notes.md' Enter
Type 'echo # demo app > README.md' Enter
Type 'git add -A && git commit -qm seed && git push -q -u origin main' Enter
Type 'cp "$CS_ROOT/examples/agent-call.sh" .' Enter
Show

# --- scene 1: arm the file inverse, let the wipe run, fire the undo
Ctrl+L
Type 'ls src/legacy' Enter
Sleep 900ms
Type 'counterstep init' Enter
Sleep 800ms
Type './agent-call.sh Bash "rm -rf src/legacy"' Enter
Sleep 1500ms
Type 'counterstep ledger' Enter
Sleep 1100ms
Type 'rm -rf src/legacy' Enter
Sleep 400ms
Type 'ls src/legacy' Enter
Sleep 900ms
Type 'counterstep fire --last' Enter
Sleep 1300ms
Type 'ls src/legacy' Enter
Sleep 1100ms

# --- scene 2: arm the remote-ref inverse, let the force-push land, fire the undo
Ctrl+L
Type 'git rm -q src/legacy/util.js && git commit -qm remove-legacy-util' Enter
Sleep 700ms
Type './agent-call.sh Bash "git push --force origin main"' Enter
Sleep 1900ms
Type 'git push --force origin main' Enter
Sleep 900ms
Type 'git ls-remote origin refs/heads/main' Enter
Sleep 1100ms
Type 'counterstep fire --last' Enter
Sleep 1400ms
Type 'git ls-remote origin refs/heads/main' Enter
Sleep 1500ms
