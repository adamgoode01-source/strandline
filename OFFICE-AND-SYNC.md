# Office plan reader and field sync

Two pieces, and they are independent — the reader works without the server,
and the server works whether the schedule was read by machine or typed in.

```
  office computer                     server                    iPad
  ---------------                     ------                    ----
  read-plans.mjs  ──project file──►  strandline-sync  ◄──────►  Strandline PT
  (renders sheets,                   (projects,                 (fills forms,
   reads the schedule)                revisions)                 pushes back)
          │                                                          │
          └────────── or hand the file over directly ────────────────┘
```

---

## Why the reader exists

PT shop drawings are exported with the text converted to outlines. The
schedule on the sheet is line art, not characters, so no PDF parser can read
it — this was measured on the Prado Lofts set: 627,217 line segments against
606 text operations, and only 1,012 of those segments were glyph-scale.

The reader sidesteps that by rendering the sheet and *looking* at it. Vision
reads pixels, so how the text got onto the page stops mattering.

### Division of labour

The model only transcribes what is printed. Every piece of arithmetic —
expanding `300 THRU 308` into nine tendons, turning `2 1/2` into inches —
happens in `expand.mjs`, which is tested against a sheet whose correct answer
is known. A model is good at reading a cramped table and bad at being audited,
so it is never asked to compute.

### The desktop app

```
cd desktop
npm install
npm start
```

PowerShell does not accept `&&` as a separator, so those go on separate
lines rather than chained.

The window is the same page the iPad and the artifact use, with the office
controls added: **Read the schedule off the plans** appears on a project, and
**API key** stores your key in the Windows credential store. Nothing about the
field app changes.

The renderer runs with context isolation on, node integration off, and a CSP
that allows no remote script and no network from the page at all. It reaches
the outside world only through a fixed set of named operations in
`electron/preload.cjs`, and the sync call goes through the main process so the
token never sits in the page and plain http is refused in one place.

### Running it from the command line

```
cd desktop
npm install
set ANTHROPIC_API_KEY=sk-ant-...

node read-plans.mjs "path/to/PT shop drawings.pdf" --out project.json --job 2622560140
```

| flag | effect |
|---|---|
| `--dry-run` | render the page images only, no API calls, so you can see exactly what would be sent |
| `--pages 4-7` | limit which sheets are examined |
| `--from-json f.json` | skip the API and expand a schedule you already have |
| `--out` | where to write the project file (default `project.json`) |
| `--job`, `--name` | job number and project name |

Two passes per sheet: a whole-sheet image to locate the schedule, then a crop
of that region enlarged to read it. Claude downscales anything wider than
~1568px, so sending the whole sheet at high resolution would leave the
schedule text a few pixels tall. Cost is roughly a cent or two per sheet.

`STRANDLINE_LOCATE_MODEL` and `STRANDLINE_READ_MODEL` override the models.
Locating is easy and defaults to Sonnet; reading is the accuracy-critical step
and defaults to Opus.

### What it will not do

It will not invent a number. An unreadable cell comes back `null`, is left
blank on the form, and is listed under warnings. If a stated quantity
disagrees with the range it describes — `300 THRU 308` alongside `10 X 34A` —
the row is flagged and left for a person. That mismatch is either a reading
error or a drawing error, and neither is for a script to settle.

Import the result with **Import plan file** on the app's home screen.

---

## The sync server

The office pushes schedules; the field pulls them and pushes back what was
measured.

### The property that matters

Writes are scoped by role, enforced on the server, not trusted to the client:

- A **field** token can write measurements — gauge pressure, both marks,
  seating, notes, signatures.
- Only an **office** token can write the schedule and the acceptance criteria
  — calculated elongation, tendon length, ram area, tolerances.

So a field device cannot alter the calculated elongation its own work is
judged against, even by accident or by pushing a stale copy. And the office
can revise a schedule without wiping measurements the crew already recorded —
field entries are carried across by tendon mark.

A tendon the schedule does not contain is reported back rather than silently
added, because that is a discrepancy somebody has to resolve.

### Deploying

```
cd server
npm install
node admin.mjs add-token --org "JC Concrete, LLC" --role office --label "office pc"
node admin.mjs add-token --org "JC Concrete, LLC" --role field  --label "ipad 1"
npm start
```

Tokens are shown once and stored only as a SHA-256 hash, so a copy of the
database is not a set of working credentials. There is no recovery — issue a
new token and revoke the old one.

For fly.io, `fly.toml` and the `Dockerfile` are ready. **The database is a
file, so it needs a volume** or it is wiped on every redeploy:

```
fly launch --no-deploy
fly volumes create strandline_data --size 1
fly deploy
```

Any host that runs a container and mounts a disk works the same way.

| env | default | meaning |
|---|---|---|
| `PORT` | 8787 | listen port |
| `STRANDLINE_DB` | `./strandline.sqlite` | database file — put it on a volume |
| `STRANDLINE_ORIGINS` | capacitor/ionic/localhost | allowed browser origins |

The iOS build is a Capacitor webview whose origin is `capacitor://localhost`
rather than an https page, which is why that scheme is allowed by default.

### Use https

The app refuses a plain-http server address. Over http the device token and
every job record travel in the clear, readable by anyone on the same network —
including site wifi. fly.io terminates TLS for you; behind your own proxy,
terminate it there.

### API

| | |
|---|---|
| `GET /health` | open, for uptime checks |
| `GET /v1/projects` | list projects for the token's organisation |
| `GET /v1/projects/:id` | one project with its forms |
| `POST /v1/projects` | create or update a project *(office only)* |
| `DELETE /v1/projects/:id` | soft-delete a project and its forms *(office only)* |
| `POST /v1/projects/:id/records` | push forms, merged by role |
| `GET /v1/changes?since=<iso>` | everything that moved since a watermark |

Every write carries `baseRev`. If the record has moved on, the server refuses
the write and returns its own copy rather than letting a stale client
overwrite it. The app adopts the server's revision and re-sends its own
fields, which the role-based merge makes safe — so a late push from a device
that was offline still lands without dragging an old schedule back with it.

Organisations are isolated by token; one cannot read another's projects.

---

## Tests

```
cd desktop && node test-reader.mjs     # 49  fractions, bundle expansion, guards
cd desktop && node test-import.mjs     # 19  the app importing a real reader file
cd server  && node test-server.mjs     # 38  auth, roles, merge, conflicts, isolation
```

The client suite needs a running server:

```
cd server
node admin.mjs add-token --org Test --role office
node admin.mjs add-token --org Test --role field
npm start
node test-client.mjs http://127.0.0.1:8787 <officeToken> <fieldToken>   # 27
```

The reader tests use the real Prado Lofts POUR 1 schedule as their fixture, so
the expected answer is not invented: bundles 300 through 420, 121 tendons,
78 stressed at one end and 43 at each end.

The API call itself is not covered — it needs a key and a network. Everything
either side of it is.
