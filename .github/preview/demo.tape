# VHS tape for .github/preview.mp4 — the pi.dev gallery card video.
# Render with: .github/preview/regen.sh video
#
# The frame settings below MIRROR .github/preview/freeze.json (1280x720,
# #171717, 18px JetBrains Mono, line-height 1.3, 40px padding). The
# gallery video and the two README screenshots are meant to read as one
# set — if you change one, change the other in the same commit.
#
# One unavoidable difference: freeze pads 40 vertical / 60 horizontal,
# VHS's Padding is a single uniform value. 40 matches the vertical
# rhythm, which is the one that governs how many rows fit.
#
# Nothing here is staged. `demo-cli.ts` runs the real websearch and
# webfetch implementations against the real network; the aliases exist
# only so the command you see typed is the tool's actual name rather
# than an `npx -y tsx …` incantation.

Require npx

Output .github/preview.mp4

Set Shell bash
# freeze.json asks for "JetBrains Mono" and fetches the webfont itself.
# VHS renders through a real browser and can only use *installed*
# families, so this names the JetBrains Mono build people actually have
# on disk. Same typeface, same metrics — the Nerd Font patch only adds
# glyphs. If the family is missing, VHS silently falls back to a
# proportional font and the render comes out grotesquely letter-spaced;
# regen.sh checks for it up front so that failure is loud.
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 18
Set LineHeight 1.3
Set Width 1280
Set Height 720
Set Padding 40
Set Framerate 24
# Brisk but still legible as typing. Much below ~35ms it stops reading
# as a person at a keyboard and starts looking like a paste.
Set TypingSpeed 40ms
Set WaitTimeout 60s
# `Wait` defaults to matching />$/, which never fires against the custom
# prompt set below. Match the prompt glyph instead.
Set WaitPattern /❯ ?$/

# Only background/foreground matter here. Both formatters emit 256-color
# SGR codes (38;5;39 and friends), which bypass the 16-color palette
# below and resolve to the same xterm values freeze renders.
Set Theme { "background": "#171717", "foreground": "#d4d4d4", "cursor": "#d4d4d4" }

Hide
  # Clean prompt — the default `bash-3.2$` is noise on a gallery card.
  # \[…\] brackets the non-printing SGR bytes so bash doesn't miscount
  # the prompt width and garble long typed lines.
  Type "export PS1='\[\033[38;5;42m\]❯\[\033[0m\] '" Enter
  Type "alias websearch='npx -y tsx .github/preview/demo-cli.ts websearch'" Enter
  Type "alias webfetch='npx -y tsx .github/preview/demo-cli.ts webfetch'" Enter
  # Pay the npx/tsx cold start now so the first visible command doesn't
  # sit on a blank frame while the toolchain boots.
  Type "npx -y tsx .github/preview/demo-cli.ts warm" Enter
  Wait
  Type "clear" Enter
Show

# `--limit` and `--max-chars` are real parameters of the two tools, and
# they're here for a real reason: at 1280x720 with this font the frame
# holds ~21 rows, and the tools' defaults overflow that. Rather than
# letting the ✓ header scroll off the top — the one line that identifies
# what the card is showing — the video asks for output that fits.
#
# regen.sh enforces this budget. Its preflight reads the two `Type …
# Enter` lines below, runs them, and counts the wrapped rows. The budget
# itself lives in one place — `row_budget` in regen.sh — so it isn't
# restated here. Lower these flags if the check fails. The preflight also
# asserts the frame settings above (font size, line height, width,
# height, padding), because the budget applies only to that frame.
Sleep 1s
Type `websearch "pi coding agent" --limit 2` Enter
# Wait for the shell prompt to come back rather than guessing at a fixed
# duration — ddgr latency varies and a fixed Sleep either truncates the
# results or leaves dead air.
Wait
# Dwell beats are the whole time budget of this card. Long enough to
# scan the results, short enough that a hover loop doesn't feel slow.
Sleep 3s

Type "clear" Enter
Sleep 500ms
Type "webfetch https://en.wikipedia.org/wiki/Unix_philosophy --max-chars 900" Enter
Wait
# Slightly longer than the websearch beat: this is the last frame before
# the loop restarts, and it's a wall of prose rather than a scannable list.
Sleep 4s
