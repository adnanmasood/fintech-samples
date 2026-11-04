# The landing page

A scroll-scrubbed hero: one AI-generated shot that plays forward as you scroll
down and backward as you scroll up, then the page settles into a real site.

Plain HTML, CSS and vanilla JavaScript. No build step.

## Running it

The API server serves this page at `/`, so `npm run dev` from the repository
root is all you need. On its own:

```bash
npx http-server site -p 4173
```

It needs a server rather than a double-clicked file, because browsers block
`fetch` on `file://` URLs and the video is loaded as a Blob. Opening
`index.html` directly shows the designed still hero instead, which is the
intended fallback rather than a bug.

## The media

Everything is committed, so a fresh clone works with no extra step:

| File | What it is |
|---|---|
| `hero-scrub.mp4` | H.264, for hardware decoding nearly everywhere |
| `hero-scrub.webm` | VP9, for browsers built without the proprietary codecs |
| `hero-poster.jpg` | First frame, shown while the video loads |
| `hero-ending.jpg` | The composed resting frame, reused as the static hero and behind the closing card |
| `section-*.jpg` | Stills pulled from the same footage, so the page and the video are one world |

Both encodes carry a keyframe every eight frames (`-g 8`). A browser can only
seek precisely to a keyframe, so without that density scrubbing visibly steps
instead of gliding. If you re-encode, keep it.

The loader asks the browser which codec it will take and fetches only that one.
If it will take neither, the page serves the static hero rather than a spinner
that never resolves.
