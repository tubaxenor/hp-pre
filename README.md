# hp-pre — 家長代表選舉 (Parent Representative Election)

Static voting site for a class parent-rep election. Voter UI is 100% zh-TW.

- **Frontend** — GitHub Pages (`docs/`), vanilla JS + prebuilt Tailwind/daisyUI (`docs/vendor.css`). Live: https://tubaxenor.github.io/hp-pre/
- **Backend** — Google Apps Script (`apps-script/Code.gs`) on a **private** Spreadsheet.
- **Rules** — each family = 1 ballot, exactly **4 votes for 4 distinct candidate families** (連記法). Candidates are the families themselves; voting for your own family is allowed. Twins = 1 family.

## Election states — `Config` → `ELECTION_STATUS`

| State | Site shows | Voting |
|---|---|---|
| `CLOSED` | 「投票尚未開始」 + open window (`VOTE_WINDOW` in `docs/config.js`) | blocked |
| `OPEN` | normal voting | allowed |
| `ENDED` | ranked results (4 正取 + 2 備取) | blocked |

Changing the state takes effect on the next page load — no redeploy.

## Spreadsheet tabs (private, owner-only)

| Tab | Contents |
|---|---|
| `Config` | `ELECTION_STATUS`, `SALT` (sha256 of admin token), `VOTES_REQUIRED` (4), `ELECTION_TITLE` |
| `Roster` | one row per family: `family_id` · `display_name` · `student_names` · `student_numbers` · `key_hash` (auto) · `eligible` (`Y`=participates) · `notes` · `self_recommended` (`Y`=自薦, floats to top of ballot) |
| `Ballots` | control only: `key_hash` · timestamps · `revision` · `passcode_hash` — **no votes** |
| `Votes` | anonymous: `vote_token` · `vote1..4` — **no identity** |
| `結果` | ranked tally, populated only when `ENDED` |
| `AuditLog` | append-only action log (never records vote choices) |

**Ballot privacy:** votes (`Votes`) and identity (`Ballots`/`Roster`) are linkable only with the `PEPPER`, which lives in Apps Script → Project Settings → Script Properties (never in the sheet). Reading the sheet shows *that* a family voted, never *what*. A `PEPPER` holder (the owner) could still de-anonymize deliberately — unavoidable when one party owns both the sheet and the secret.

## Common tasks

- **Self-recommended family** — `Roster` col `self_recommended` = `Y`.
- **Exclude a family** — `Roster` col `eligible` = anything but `Y` (can't vote, not a candidate).
- **Lost passcode** — reset it from the Apps Script editor (owner-only); **never delete rows**. Their next vote issues a fresh passcode and safely overwrites their existing vote.
- **Reveal results** — set `ELECTION_STATUS = ENDED`.

## Key derivation

The browser sends only `H1 = SHA-256("hp-pre-v1|name|num"[|name2|num2])`; the server peppers it (`H2 = HMAC(PEPPER, H1)`) and matches the roster — raw names never leave the browser. Normalization (name: NFKC → strip spaces → lowercase; number: digits only, no leading zeros; twins sorted by number) is identical in `docs/app.js` and `apps-script/Code.gs` (the reference).

```bash
printf 'hp-pre-v1|測試生|1' | shasum -a 256   # test vector
```
