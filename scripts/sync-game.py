#!/usr/bin/env python3
"""Refresh the browser version (play/) from the game repo's www/ folder.

    python3 scripts/sync-game.py ../sling-and-slide/www

Copies the game's files into play/ (keeping the website-only files web.js and
manifest.webmanifest), then adds the website's page header and the web.js script
to play/index.html. Stops without changing anything if the game's index.html
doesn't look as expected.
"""
import shutil, sys
from pathlib import Path

WEB_ONLY = {'web.js', 'manifest.webmanifest'}
HEAD_OLD = '<title>Sling &amp; Slide</title>'
HEAD_NEW = ('<title>Play Sling &amp; Slide</title><meta name="description" content="Play Sling &amp; Slide in your browser: '
            'launch your chick from a giant slingshot and slide as far as you can."><link rel="icon" href="../assets/favicon.png">'
            '<link rel="apple-touch-icon" href="../assets/apple-touch-icon.png"><link rel="manifest" href="manifest.webmanifest">'
            '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">'
            '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" '
            'content="Sling &amp; Slide"><meta name="theme-color" content="#2f8fe8">')
LAST_SCRIPT = '<script src="rankings.js"></script>'

src = Path(sys.argv[1] if len(sys.argv) > 1 else '../sling-and-slide/www').resolve()
dst = Path(__file__).resolve().parent.parent / 'play'
html = (src / 'index.html').read_text(encoding='utf-8')
for need in (HEAD_OLD, LAST_SCRIPT):
    if html.count(need) != 1:
        sys.exit(f'stopped: expected exactly one {need!r} in {src / "index.html"}')
html = html.replace(HEAD_OLD, HEAD_NEW).replace(LAST_SCRIPT, LAST_SCRIPT + '<script src="web.js"></script>')

for p in dst.iterdir():
    if p.name in WEB_ONLY:
        continue
    shutil.rmtree(p) if p.is_dir() else p.unlink()
for p in src.iterdir():
    (shutil.copytree if p.is_dir() else shutil.copy2)(p, dst / p.name)
(dst / 'index.html').write_text(html, encoding='utf-8')
print(f'play/ refreshed from {src}')
