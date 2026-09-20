#!/usr/bin/env bash
# Assembles docs/design.html from the fragments in docs/design-parts/0*.html.
set -euo pipefail
cd "$(dirname "$0")"
out=../design-new.html
{
cat <<'HEAD'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rumi — UI design directions</title>
<style>
  html { box-sizing: border-box; }
  body { margin: 0; background: #e9e8e4; color: #1d1d1b; font: 15px/1.5 -apple-system, "Segoe UI", Helvetica, sans-serif; }
  .shell-nav { position: sticky; top: 0; z-index: 10; display: flex; gap: 4px; align-items: center; padding: 10px 20px; background: #f7f6f3; border-bottom: 1px solid #d3d1cb; }
  .shell-nav strong { margin-right: 14px; font-weight: 600; }
  .shell-nav a { color: inherit; text-decoration: none; padding: 6px 12px; border-radius: 6px; }
  .shell-nav a:hover, .shell-nav a:focus-visible { background: #e2e0da; outline: none; }
  .shell-nav a.current { background: #1d1d1b; color: #fff; }
  .shell-intro { max-width: 68ch; padding: 40px 20px 8px; }
  .shell-intro h1 { font-size: 24px; font-weight: 600; margin: 0 0 8px; }
  .shell-intro p { margin: 0 0 8px; color: #4b4a46; }
  .design { padding: 48px 20px 80px; }
  .design + .design { border-top: 1px solid #d3d1cb; }
  .design .note { max-width: 68ch; margin: 0 0 28px; color: #4b4a46; }
  .design .note h2 { font-size: 22px; font-weight: 600; margin: 0 0 8px; color: inherit; }
  .design .note p { margin: 0; }
  .design .screen { margin: 0 0 40px; }
  .design .screen > h3 { font-size: 13px; font-weight: 600; color: #4b4a46; margin: 0 0 10px; }
  .design .frame { width: 1280px; max-width: 100%; min-height: 760px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 24px 60px -30px rgba(0,0,0,.35); }
</style>
</head>
<body>
<nav class="shell-nav" aria-label="Designs"><strong>rumi design directions</strong>
HEAD
for f in 0*.html; do
  id=$(sed -n 's/.*id="\(d[0-9]\)".*/\1/p' "$f" | head -1)
  title=$(sed -n 's/.*data-title="\([^"]*\)".*/\1/p' "$f" | head -1)
  printf '<a href="#%s">%s</a>\n' "$id" "$title"
done
cat <<'INTRO'
</nav>
<div class="shell-intro">
<h1>Five directions for the rumi interface</h1>
<p>Each direction shows the same three screens: the start screen, the room review after a scan, and the design workspace once the agent has proposed products. Content is the sample living room and sample catalogue. None of this is wired to the app.</p>
</div>
INTRO
for f in 0*.html; do
  echo "<!-- $f -->"
  # Give each screen a visible label from its data-screen attribute.
  title=$(sed -n 's/.*data-title="\([^"]*\)".*/\1/p' "$f" | head -1)
  sed -E -e 's#<article class="screen" data-screen="([^"]+)">#<article class="screen" data-screen="\1"><h3>\1</h3>#' \
         -e "0,/<aside class=\"note\">/s##<aside class=\"note\"><h2>${title}</h2>#" "$f"
done
cat <<'TAIL'
<script>
  const links = [...document.querySelectorAll('.shell-nav a')];
  const sections = links.map((a) => document.querySelector(a.getAttribute('href')));
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      links.forEach((a) => a.classList.toggle('current', a.getAttribute('href') === '#' + e.target.id));
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  sections.forEach((s) => s && io.observe(s));
</script>
</body>
</html>
TAIL
} > "$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
