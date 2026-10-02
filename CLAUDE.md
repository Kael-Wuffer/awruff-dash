# awruff-dash — working notes for Claude

A homelab dashboard for a six-container Proxmox lab. Runs on CT105 next to
Grafana, Prometheus and Netdata. Reachable on the tailnet only.

Read this before changing anything. It is short on purpose.

## Who you are working with

William — helpdesk technician, self-taught, aiming at system administration.
Knows hardware and software well, networking less so, and is learning the
formal terms as he goes. He has said plainly that what is obvious to an expert
often is not to him.

What that means in practice:

- **Explain fundamentals in plain language.** Not dumbed down — explained. If
  a command does something non-obvious, say what and why.
- **Discuss before building.** Propose, hear his concerns, answer them, then
  write code. Do not produce a large change off an ambiguous "sounds good".
- **Small chunks.** He has explicitly said he does not want large volumes of
  output at once. One thing at a time, conversationally.
- **Ask rather than decide silently.** His words: "we're supposed to work on
  this together."
- **Multi-command terminal pastes are fine.** His only concern is that if an
  early command fails, the later ones in that batch were generated for nothing.
  So: put the risky or discovering step first, and let it report before the
  steps that depend on it.

He will challenge whether work is worth doing. That is a feature. Answer with
honest cost and benefit, and concede when he is right — he has been, twice.

## What this project is for

A dashboard that **asks the infrastructure what exists** instead of being told.

That is the whole design thesis, and it came from his question: how does this
page still work when the lab is twice the size? The answer is that containers
are discovered from the Proxmox API at runtime. `config.yaml` carries only what
a machine cannot work out — display name, URL, group, two-letter abbreviation.

Build CT106 and it appears under `UNSORTED` with live stats, no config edit.
Add four lines and it moves somewhere sensible with a proper name.

**Do not break this.** Any change that requires hand-listing containers to work
is a regression no matter how much nicer it looks.

## Architecture

```
app/config.py    config.yaml → typed objects, errors written for a human at 11pm
app/proxmox.py   read-only API client, four endpoints, nothing else
app/state.py     Proxmox's answers → the exact shape the page renders
app/main.py      serves /api/state and the static files
app/static/      index.html, app.css, app.js — no framework, deliberately
```

One rule holds this together: **the front end never knows where a number came
from.** `state.py` is the only place that shapes data. Adding Prometheus as a
second source should be a change in that one file.

The backend exists for exactly one reason: to hold the Proxmox token so the
browser never sees it. If that stops being true, the backend stops being
necessary.

## Conventions that are deliberate, not accidental

- **Pin every version**, and discover it rather than guessing. `requirements.txt`
  was written by installing unpinned and reading back what actually resolved.
  Guessing version numbers already broke this build once.
- **Errors go on the page, not into a log file.** A dashboard that goes blank
  tells you nothing; one that says "the token has no permissions" tells you
  everything. Preserve that when you touch error paths.
- **A check that cannot succeed is worse than no check.** iLO has no health
  check on purpose — it rides on HP's shared network port and is unreachable
  from anywhere inside the rack. A permanently red badge teaches you to ignore
  red badges. The config says so in a comment. Leave it.
- **Stats are per container, not per service.** Three tiles on CT105 showing
  identical CPU numbers reads as a bug even though it is correct, so only the
  first service listed for a vmid displays them.
- **Credentials never enter config.yaml.** `.env` only, gitignored, and the
  Proxmox token is read-only (`PVEAuditor`) with Privilege Separation on.

## The look

Phosphor: amber on near-black, IBM Plex Mono, square-ish corners, segmented
meters, hairline rules under tracked uppercase headings. It deliberately
matches awruff.org — this is that site's sibling, not a separate identity.

Colour tokens live at the top of `app.css`. Use them; do not introduce new
hexes inline.

Two earlier attempts at theming failed because they only recoloured — same
boxes, same spacing, same type, different hue. His verdict: *"it looks like
some kid figured out how to use the inspect console and change colors."* If a
visual change does not touch geometry, spacing or type, it is not a visual
change.

## Known bugs, as of 2026-10-01

1. **Tile stat bars overflow.** `.track` is built from a `<span>` in
   `renderTile()`, so its `height` does not apply and the fill grows
   unbounded. The vitals meters are fine because those are `<div>`s. Fix:
   `display: block` on `.track` and `.bar` in `app.css`.
2. **Two cards show the same storage pool.** `_vitals()` looks for a pool named
   `storage-vault`, does not find it, and falls back to the largest pool —
   which is `local-lvm`, already shown as the thin pool. Find the array's real
   name in the Proxmox storage list and either fix the lookup or make the
   fallback skip a pool already displayed.
3. **`next_ip` is always `—`.** The field exists and is never populated. Either
   work it out (the Proxmox API knows each container's config) or remove it.

## Roadmap, in the order it matters

- Prometheus as a second source — history, sparklines, trends on the vitals.
- Open threads read from the vault's `**Open.**` markers instead of being
  hand-written in `config.yaml`.
- An ACCOUNTS tab, **only** once it carries data of its own: domain renewal,
  certificate expiry, billing dates, credential age. A grid of bookmarks was
  prototyped and deliberately cut — every other panel tells you something, and
  a link list does not.
- Public at `dash.awruff.org`, behind auth, once it has earned it.

## The vault

There is an Obsidian vault documenting this lab — systems, decisions,
runbooks — synced through Nextcloud. It is the source of truth for anything
about the infrastructure this dashboard watches: why iLO is unreachable, why
the thin pool is overcommitted, what the Proxmox token can do.

When a change here produces a durable fact about the lab, it belongs in the
vault, not only in a commit message.

## Two things that are not finished and matter

- **Homepage still runs on CT105 port 3001.** It stays until this dashboard is
  genuinely preferred. Do not remove it to tidy up.
- **An old Homepage on CT101 is published to the internet, unauthenticated,
  with the Docker socket mounted into it.** Known, agreed to be stopped, not
  yet stopped. It is unrelated to this repo but it is the most exposed thing
  in the lab.
