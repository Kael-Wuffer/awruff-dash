# dash.awruff.org

A homelab dashboard that asks the infrastructure what exists instead of being
told. Runs on CT105 alongside Grafana, Prometheus and Netdata.

Built because [Homepage](https://gethomepage.dev) can be restyled completely
but cannot be restructured at all — no gauges, no tabs with their own content,
no instrument clusters. The look was achievable; the shape was not.

## What it does

**LAB** — every service as a tile with live status and response time, plus a
vitals rail: host CPU, memory and load; the LVM thin pool as a ring; the
storage array; and a roll call of every container.

**WORKSHOP** — the three questions you actually ask when starting something.
*Can I fit another one* (with a verdict, not just numbers). *What IDs are
free.* *What's already half-finished.*

## The one idea worth knowing

**Containers are discovered, not configured.** The Proxmox API already knows
what exists, so `config.yaml` only carries what a machine cannot work out:
display name, URL, group, two-letter abbreviation.

Build CT106 tomorrow and it appears by itself under `UNSORTED`, with live
stats, with no edit to anything. Add four lines of config and it moves
somewhere sensible with a proper name.

That is the whole answer to "how does this still work when the lab is twice
the size".

## Running it

```bash
cp config.example.yaml config.yaml     # edit to taste
cp .env.example .env                   # paste the token secret from Bitwarden
docker compose up -d dash
```

Then `http://<ct105>:3002`.

### In the CT105 compose stack

```yaml
  dash:
    build: /opt/dash
    container_name: dash
    restart: unless-stopped
    network_mode: host
    env_file: /opt/dash/.env
    volumes:
      - /opt/dash/config.yaml:/srv/config.yaml:ro
```

### Without Docker

```bash
pip install -r requirements.txt
export PROXMOX_TOKEN_ID='root@pam!homepage'
export PROXMOX_TOKEN_SECRET='...'
uvicorn app.main:app --host 0.0.0.0 --port 3002
```

## Credentials

The Proxmox token is **read-only** — `PVEAuditor` on `/`, with Privilege
Separation enabled, so it inherits nothing from root. It can see every node,
VM and container and cannot start, stop or change one.

It lives in `.env`, which is gitignored, and in Bitwarden. It is never in
`config.yaml`, and the browser never sees it — that is the entire reason this
has a backend at all rather than being a static page.

Rotate it in Proxmox → Datacenter → Permissions → API Tokens. Nothing else
uses it, so rotating it breaks only this.

## Layout

```
app/
  config.py     config.yaml → typed objects, with errors a human can act on
  proxmox.py    a tiny read-only API client, four endpoints
  state.py      Proxmox's answers → the shape the page wants
  main.py       serves /api/state and the static files
  static/       index.html, app.css, app.js — no framework, on purpose
config.example.yaml
```

The front end polls `/api/state` every ten seconds and stops entirely when the
tab is hidden. The backend caches for five seconds, so ten open tabs are still
one Proxmox request.

## Reading the errors

Problems appear in a red banner at the top of the page rather than in a log
you have to go find. The distinction that matters:

| What you see | What it means |
|---|---|
| `0 / 0` containers, `NaN%` | Token is valid but has no permissions — the ACL is missing |
| `API Error` / 401 | Token id or secret is wrong |
| `could not reach Proxmox — ConnectError` | No route, or nothing listening on 8006 |
| A service stuck on `DOWN` | Check whether this container can actually reach it — see iLO |

**iLO is the cautionary tale.** It has no health check on purpose: it rides on
HP's shared network port, so it cannot be reached from anywhere inside the
rack, only from the far end of the server's cable. A monitor on it is
permanently and wrongly red. A check that cannot succeed is worse than no
check, because it teaches you to ignore red.

## Still to do

- Prometheus as a second source, for history and sparklines
- Open threads read out of the vault's `**Open.**` markers instead of config
- An ACCOUNTS tab — but only once it carries data of its own (domain renewal,
  certificate expiry, billing dates, credential age). A grid of bookmarks is
  not worth a tab.
- Public at `dash.awruff.org`, behind auth, once it has earned it
