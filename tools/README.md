# tools

Small scripts that are not part of the service.

## `demo-server.ts`

Runs the **real** server — real poller, real routes, real pages — against the
`FakeBee` the test suite uses, seeded with four plausible batches and enough
uploaded content that fullness and the bucket map are genuine rather than
drawn. It also stands up a local stand-in for the public node index, so the
peer map and the reachability check resolve without calling a third party.

Used for the README tour, and useful on its own for looking at a page whose
state is awkward to reach on a live node.

```
bun run tools/demo-server.ts        # serves on :8902, admin token demo-admin-token
```

## `shoot.ts`

Screenshots a list of pages over the DevTools protocol.

Chromium's own `--screenshot` cannot write files in some sandboxes;
`Page.captureScreenshot` returns base64 over the wire, so this process writes
the file instead. Shoot at `scale: 2` and downsample — GIF at 1:1 looks soft.

```
chromium --headless --remote-debugging-port=9222 about:blank &
bun run tools/shoot.ts <out-dir> <base-url> <spec.json>
```

Assembling the tour, deliberately **without** dithering: the background is a
dark gradient, and Floyd-Steinberg noise across it triples the file for no
visible gain (1.3 MB against 364 kB).

```
convert -delay 260 01-*.png -delay 220 02-*.png ... \
        -loop 0 -resize 1000x625 -dither None -colors 256 -layers Optimize tour.gif
```

## `fix-world-antimeridian.py`

Repairs the world outline used by the peer map: splits rings that cross ±180,
and closes polar rings through the pole. See the header in the file.
