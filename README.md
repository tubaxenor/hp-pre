# hp-pre — Parent Representative Election (家長代表選舉)

Static voting site for a class parent-representative election.

- **Frontend**: GitHub Pages (`docs/`), vanilla JS + Tailwind CSS v4 + daisyUI 5 (CDN, no build step). UI is 100% zh-TW.
- **Backend**: Google Apps Script web app (`apps-script/Code.gs`), container-bound to a **private** Google Spreadsheet.
- **Rules**: 50+ families; each family = 1 ballot with exactly **4 votes for 4 distinct candidate families** (連記法). Candidates are the same families; voting for your own family is allowed. Twins = 1 family (two students, one ballot).

## How voting works

1. A parent enters their student's name + student number (twins: both students). The browser normalizes the input and computes `H1 = SHA-256(canonical string)` via the Web Crypto API. **Raw names/numbers never leave the browser** — only H1 is sent.
2. The server computes `H2 = HMAC-SHA256(PEPPER, H1)` and looks it up in the roster. Valid key → returns candidates and ballot state.
3. First successful identity check **claims the ballot immediately**: a Ballots row is created (votes empty, revision 0) and a **5-char passcode (領票碼)** is issued and shown once with a save-it warning — the server stores only `HMAC-SHA256(PEPPER, key_hash|passcode)`.
4. Every later visit (and every vote) requires the passcode before the voted/unvoted state or current votes are revealed or overwritten. First actual vote = revision 1 (領選票); overwrites increment (更改選票). A family can never obtain a second ballot; tally counts only rows with votes.
5. Results are readable only via the `tally` action with a secret admin token. The spreadsheet itself is owner-only.

**Lost passcode**: the admin clears that row's `passcode_hash` cell in `Ballots`; the family's next vote issues a fresh passcode.

## Key scheme (spec)

Normalization — identical in `docs/app.js` and `apps-script/Code.gs` (`Code.gs` is the reference):

1. **Name**: Unicode NFKC → remove ALL whitespace (including internal) → lowercase Latin letters.
2. **Number**: NFKC → keep digits only → strip leading zeros (`０５` → `5`). Empty after stripping = invalid.
3. **Twins**: two (name, number) pairs sorted by numeric student number ascending (entry order never matters); tie broken by codepoint name order.
4. **Canonical string**: `hp-pre-v1|name1|num1` or `hp-pre-v1|name1|num1|name2|num2`.
5. `H1 = SHA-256(canonical)` hex lowercase.

### Test vectors

```
printf 'hp-pre-v1|測試生|1' | shasum -a 256
# 王 小明 + ０５  ≡  王小明 + 5   → same H1
# twins entered in either order    → same H1
```

## Spreadsheet layout (private, owner-only, 4 tabs)

| Tab | Columns |
|---|---|
| `Config` | A: key, B: value — `ELECTION_STATUS` (`OPEN`/`CLOSED`), `SALT` (sha256 hex of token), `VOTES_REQUIRED` (4), `ELECTION_TITLE` |
| `Roster` | A: `family_id` (F01…), B: `display_name` (candidate label), C: `student_names` (comma-separated for twins), D: `student_numbers`, E: `key_hash` (H2 — filled by `adminRebuildHashes()`, never by hand), F: `eligible` (Y/N), G: `notes` |
| `Ballots` | A: `key_hash`, B: `family_id`, C–F: `vote1..vote4`, G: `first_claimed_at`, H: `last_updated_at`, I: `revision`, J: `passcode_hash` |
| `AuditLog` | A: timestamp, B: action, C: key prefix (12 hex), D: result, E: detail |

Header row required on every tab. The **PEPPER is NOT in the sheet** — it lives in Apps Script → Project Settings → Script Properties.

## Setup runbook

### 1. Frontend (done once)

Repo is served by GitHub Pages from `main` branch, `/docs` folder → https://tubaxenor.github.io/hp-pre/

### 2. Spreadsheet

1. Create a private Google Spreadsheet (link sharing OFF).
2. Add the 4 tabs above with header rows.
3. Fill `Config` (`ELECTION_STATUS=CLOSED` for now) and `Roster` columns A–D and F.

### 3. Secrets

```bash
openssl rand -hex 32   # PEPPER → Apps Script Script Properties
openssl rand -hex 16   # admin token → keep in password manager
printf '%s' "<token>" | shasum -a 256   # → Config.SALT
```

### 4. Apps Script

1. Spreadsheet → Extensions → Apps Script; paste `apps-script/Code.gs`; set manifest per `apps-script/appsscript.json` (Project Settings → Show manifest).
2. Project Settings → Script Properties → add `PEPPER`.
3. Run `adminRebuildHashes()` once from the editor (grants OAuth scopes, fills `Roster.key_hash`). Re-run after any roster edit.
4. Deploy → New deployment → Web app → Execute as **Me**, Who has access: **Anyone** (must be "Anyone", not "Anyone with a Google account"). Copy the `/exec` URL.
5. For later code changes: paste new code → Deploy → **Manage deployments → edit → New version** (keeps the same URL).

### 5. Wire frontend

Put the `/exec` URL into `docs/config.js` → commit → push. Pages redeploys automatically.

### 6. Go live / close

- Open: set `Config.ELECTION_STATUS = OPEN`, distribute the site URL.
- Close: set `CLOSED`. Votes are rejected; `check` still works.
- Tally: `POST {"action":"tally","adminToken":"<token>"}` to the `/exec` URL (works while OPEN too — turnout monitoring).
- Archive: File → Make a copy of the spreadsheet.

## API

All requests: `POST` to the `/exec` URL with `Content-Type: text/plain;charset=utf-8` and a JSON body (avoids CORS preflight, which GAS cannot answer). All responses: JSON `{ok:true,...}` or `{ok:false,error,message}` (messages zh-TW).

| Action | Request | Response |
|---|---|---|
| `check` | `{action, key, passcode?}` | `{registered, hasBallot, hasVoted?, electionOpen, title, candidates[], passcode?, passcodeRequired?, currentVotes?, revision?}` — first check while OPEN claims the ballot and returns `passcode` once; later checks return `passcodeRequired` until the correct passcode is presented, which unlocks `hasVoted`/`currentVotes` |
| `getCandidates` | `{action, key}` | `{candidates[]}` |
| `vote` | `{action, key, votes[4], passcode}` | `{status: "claimed"\|"updated", revision}` — `claimed` on the first vote of a claimed ballot; passcode required whenever the ballot has one |
| `tally` | `{action, adminToken}` | `{electionStatus, totalBallots, results[]}` |

Errors: `BAD_REQUEST, UNKNOWN_STUDENT, ELECTION_CLOSED, INVALID_VOTES, PASSCODE_WRONG, UNAUTHORIZED, RATE_LIMITED, SERVER_ERROR`.

Passcode format: 5 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L); input is NFKC-normalized, whitespace-stripped, uppercased. Failed passcode attempts count toward the global rate-limit brake.

### Smoke test

```bash
H1=$(printf 'hp-pre-v1|測試生|1' | shasum -a 256 | cut -d' ' -f1)
curl -sL -H 'Content-Type: text/plain;charset=utf-8' \
  -d "{\"action\":\"check\",\"key\":\"$H1\"}" "$GAS_URL"
```

## Threat model / accepted limitations

- **Impersonation**: anyone who knows a student's name + number can claim that family's ballot **first** — but once claimed, changing it requires the 5-char passcode issued at claim time, so a ballot cannot be silently overwritten by name+number knowledge alone. Residual risk: an attacker claiming before the real family does (the family then reports being unable to claim, and the admin investigates via `AuditLog`). Other mitigations: append-only `AuditLog`, visible revision counter (「第 N 次填寫」).
- **Ballot secrecy from the administrator**: none — the sheet owner can map ballots to families. Inherent to "one family, changeable ballot".
- **Sheet leak**: `Ballots`/`Roster.key_hash` store only peppered H2; correlation requires also compromising the Script Property.
- **Rate limiting**: GAS cannot see client IPs; a global brake (30 failed lookups / 10 min → `RATE_LIMITED`) slows roster guessing. Same brake covers bad tally tokens.
- **Out of scope**: CAPTCHA, per-IP limits, DoS beyond GAS's own quotas, insiders who know roster data.
