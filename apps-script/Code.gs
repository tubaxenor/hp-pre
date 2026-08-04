/**
 * hp-pre backend — Parent Representative Election controller.
 *
 * Container-bound to the private election spreadsheet.
 * Web app deployment: Execute as Me / Who has access: Anyone.
 *
 * Script Properties required:
 *   PEPPER — random hex secret. All lookups/storage use
 *            H2 = HMAC-SHA256(PEPPER, H1) so a leaked sheet cannot be
 *            correlated back to students without this property.
 *
 * Ballot secrecy from the administrator (best-effort, not cryptographic):
 *   Votes are stored in a separate `Votes` sheet keyed by
 *   vote_token = HMAC-SHA256(PEPPER, "vote|" + H2), with NO identity column.
 *   The `Ballots` control sheet holds identity/dedup/passcode but NO votes.
 *   Without the PEPPER (not in the sheet) the two cannot be joined, so
 *   casually reading the sheet does not reveal who voted for whom. A holder
 *   of the PEPPER can still de-anonymize deliberately — this is unavoidable
 *   when the same party owns the sheet and the script secret.
 *
 * The normalization + canonical-string logic here is the REFERENCE
 * implementation; docs/app.js mirrors it (test vectors in README).
 */

var SHEET_CONFIG = 'Config';
var SHEET_ROSTER = 'Roster';
var SHEET_BALLOTS = 'Ballots'; // control table: identity/dedup/passcode, NO votes
var SHEET_VOTES = 'Votes';     // anonymous votes keyed by vote_token, NO identity
var SHEET_AUDIT = 'AuditLog';

// Header rows. Readers loop from r=1 (row 1 is assumed to be the header), so a
// header MUST occupy row 1 — otherwise appendRow fills row 1 and that record is
// skipped by every reader. ensureHeader() self-heals this before any append.
var BALLOTS_HEADERS = ['key_hash', 'first_claimed_at', 'last_updated_at', 'revision', 'passcode_hash'];
var VOTES_HEADERS = ['vote_token', 'vote1', 'vote2', 'vote3', 'vote4'];

var KEY_RE = /^[0-9a-f]{64}$/;
var RATE_LIMIT_MAX_FAILURES = 30;
var RATE_LIMIT_WINDOW_SECONDS = 600;

/* Passcode (領票碼): issued once at ballot claim; required to change votes.
 * 5 chars from an alphabet without ambiguous glyphs (no 0/O/1/I/L). */
var PASSCODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
var PASSCODE_LENGTH = 5;

/* ---------------- entry points ---------------- */

function doGet() {
  return jsonOut({ ok: true, service: 'hp-pre' });
}

function doPost(e) {
  try {
    var req;
    try {
      req = JSON.parse(e.postData.contents);
    } catch (err) {
      return fail('BAD_REQUEST', '請求格式錯誤。');
    }

    switch (req.action) {
      case 'check':
        return handleCheck(req);
      case 'getCandidates':
        return handleGetCandidates(req);
      case 'vote':
        return handleVote(req);
      case 'results':
        return handleResults(req);
      case 'tally':
        return handleTally(req);
      default:
        return fail('BAD_REQUEST', '未知的操作。');
    }
  } catch (err) {
    audit('error', '', 'SERVER_ERROR', String(err));
    return fail('SERVER_ERROR', '系統發生錯誤，請稍後再試。');
  }
}

/* ---------------- actions ---------------- */

function handleCheck(req) {
  var gate = validateKeyAndRate(req.key, 'check');
  if (gate.error) return gate.error;

  var config = readConfig();
  var open = config.ELECTION_STATUS === 'OPEN';
  var res = {
    ok: true,
    registered: true,
    electionOpen: open,
    title: config.ELECTION_TITLE || '家長代表選舉',
    candidates: listCandidates(),
  };

  var ballot = findControl(gate.h2);

  if (!ballot) {
    if (!open) {
      res.hasBallot = false;
      audit('check', gate.h2, 'OK', 'closed, unclaimed');
      return jsonOut(res);
    }
    // First successful identity check claims the ballot and issues the passcode.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (err) {
      return fail('SERVER_ERROR', '系統忙碌中，請稍後再試。');
    }
    try {
      ballot = findControl(gate.h2);
      if (!ballot) {
        var passcode = generatePasscode();
        // Control row only: identity + passcode, no votes.
        var ballotsSheet = ss().getSheetByName(SHEET_BALLOTS);
        ensureHeader(ballotsSheet, BALLOTS_HEADERS);
        ballotsSheet.appendRow([
          gate.h2,
          new Date().toISOString(),
          '',
          0,
          passcodeHash(gate.h2, passcode),
        ]);
        res.hasBallot = true;
        res.hasVoted = false;
        res.passcode = passcode;
        audit('check', gate.h2, 'OK', 'ballot claimed');
        return jsonOut(res);
      }
    } finally {
      lock.releaseLock();
    }
  }

  res.hasBallot = true;
  if (ballot.passcodeHash) {
    var pc = normalizePasscode(req.passcode);
    if (!pc) {
      // Voted-or-not and current votes stay hidden until the passcode is presented.
      res.passcodeRequired = true;
    } else if (passcodeHash(gate.h2, pc) === ballot.passcodeHash) {
      res.passcodeOk = true;
      res.hasVoted = ballot.hasVoted;
      if (ballot.hasVoted) {
        var vrow = findVotes(voteToken(gate.h2));
        res.currentVotes = vrow ? vrow.votes : [];
        res.revision = ballot.revision;
      }
    } else {
      recordFailure();
      audit('check', gate.h2, 'PASSCODE_WRONG', '');
      return fail('PASSCODE_WRONG', '領票碼錯誤，請確認後再試。');
    }
  } else {
    // Passcode was cleared (lost-passcode reset); next vote issues a fresh one.
    res.hasVoted = ballot.hasVoted;
    if (ballot.hasVoted) {
      var vrow2 = findVotes(voteToken(gate.h2));
      res.currentVotes = vrow2 ? vrow2.votes : [];
      res.revision = ballot.revision;
    }
  }
  audit('check', gate.h2, 'OK', 'hasVoted=' + !!res.hasVoted);
  return jsonOut(res);
}

function handleGetCandidates(req) {
  var gate = validateKeyAndRate(req.key, 'getCandidates');
  if (gate.error) return gate.error;
  audit('getCandidates', gate.h2, 'OK', '');
  return jsonOut({ ok: true, candidates: listCandidates() });
}

function handleVote(req) {
  var gate = validateKeyAndRate(req.key, 'vote');
  if (gate.error) return gate.error;

  var config = readConfig();
  if (config.ELECTION_STATUS !== 'OPEN') {
    audit('vote', gate.h2, 'ELECTION_CLOSED', '');
    return fail('ELECTION_CLOSED', '投票已截止。');
  }

  var votesRequired = Number(config.VOTES_REQUIRED) || 4;
  var votes = req.votes;
  if (!Array.isArray(votes) || votes.length !== votesRequired) {
    audit('vote', gate.h2, 'INVALID_VOTES', 'count=' + (votes && votes.length));
    return fail('INVALID_VOTES', '必須圈選 ' + votesRequired + ' 位候選家庭。');
  }
  var distinct = {};
  for (var i = 0; i < votes.length; i++) distinct[votes[i]] = true;
  if (Object.keys(distinct).length !== votesRequired) {
    audit('vote', gate.h2, 'INVALID_VOTES', 'duplicate ids');
    return fail('INVALID_VOTES', '不可重複圈選同一候選家庭。');
  }
  var eligibleIds = {};
  listCandidates().forEach(function (c) { eligibleIds[c.id] = true; });
  for (var j = 0; j < votes.length; j++) {
    if (!eligibleIds[votes[j]]) {
      audit('vote', gate.h2, 'INVALID_VOTES', 'unknown id ' + votes[j]);
      return fail('INVALID_VOTES', '圈選內容無效，請重新整理頁面後再試。');
    }
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    audit('vote', gate.h2, 'SERVER_ERROR', 'lock timeout');
    return fail('SERVER_ERROR', '系統忙碌中，請稍後再試。');
  }
  try {
    var control = ss().getSheetByName(SHEET_BALLOTS);
    var votesSheet = ss().getSheetByName(SHEET_VOTES);
    var now = new Date().toISOString();
    var token = voteToken(gate.h2);
    var existing = findControl(gate.h2);
    var status, revision, newPasscode = null;
    if (existing) {
      if (existing.passcodeHash) {
        var pc = normalizePasscode(req.passcode);
        if (!pc || passcodeHash(gate.h2, pc) !== existing.passcodeHash) {
          recordFailure();
          audit('vote', gate.h2, 'PASSCODE_WRONG', '');
          return fail('PASSCODE_WRONG', '領票碼錯誤，無法更改選票。');
        }
      } else {
        // Passcode was cleared (lost-passcode reset): issue a fresh one now.
        newPasscode = generatePasscode();
        control.getRange(existing.row, 5).setValue(passcodeHash(gate.h2, newPasscode));
      }
      revision = existing.revision + 1;
      writeVotes(votesSheet, token, votes);
      control.getRange(existing.row, 3).setValue(now); // last_updated_at
      control.getRange(existing.row, 4).setValue(revision); // revision
      // First actual vote on a freshly claimed (empty) ballot is a claim, not a change.
      status = existing.hasVoted ? 'updated' : 'claimed';
    } else {
      revision = 1;
      newPasscode = generatePasscode();
      ensureHeader(control, BALLOTS_HEADERS);
      control.appendRow([gate.h2, now, now, revision, passcodeHash(gate.h2, newPasscode)]);
      writeVotes(votesSheet, token, votes);
      status = 'claimed';
    }
    // NOTE: the vote choices are deliberately NOT written to the audit log.
    audit('vote', gate.h2, 'OK', status + ' rev=' + revision);
    var res = { ok: true, status: status, revision: revision };
    if (newPasscode) res.passcode = newPasscode;
    return jsonOut(res);
  } finally {
    lock.releaseLock();
  }
}

function handleTally(req) {
  if (rateLimited()) {
    return fail('RATE_LIMITED', '嘗試次數過多，請稍後再試。');
  }
  var config = readConfig();
  var tokenHash = sha256Hex(String(req.adminToken || ''));
  if (!config.SALT || tokenHash !== String(config.SALT).toLowerCase()) {
    recordFailure();
    audit('tally', '', 'UNAUTHORIZED', '');
    return fail('UNAUTHORIZED', '管理密鑰錯誤。');
  }

  var tally = computeTally();
  audit('tally', '', 'OK', 'ballots=' + tally.totalBallots);
  return jsonOut({
    ok: true,
    electionStatus: config.ELECTION_STATUS,
    totalBallots: tally.totalBallots,
    results: tally.results,
  });
}

/**
 * Public results for the site: no admin token, but reveals counts ONLY
 * when the election is ENDED. Any other status returns ended:false with
 * no counts, so nothing leaks before the election is over. This is the
 * only path that exposes results without the token, and it is gated on
 * ENDED — matching the "no one sees results early" rule.
 */
function handleResults(req) {
  var config = readConfig();
  var status = config.ELECTION_STATUS;
  var title = config.ELECTION_TITLE || '家長代表選舉';
  if (status !== 'ENDED') {
    return jsonOut({ ok: true, ended: false, electionStatus: status, title: title });
  }
  var tally = computeTally();
  audit('results', '', 'OK', 'ballots=' + tally.totalBallots);
  return jsonOut({
    ok: true,
    ended: true,
    electionStatus: status,
    title: title,
    totalBallots: tally.totalBallots,
    results: tally.results,
  });
}

/**
 * Counts votes across vote1..vote4 from the anonymous Votes table (one row
 * per voted family). Returns { totalBallots, results[] } sorted high→low.
 * Shared by tally (token-gated) and results (ENDED-only, public).
 */
function computeTally() {
  var counts = {};
  var votes = ss().getSheetByName(SHEET_VOTES).getDataRange().getValues();
  var totalBallots = 0;
  for (var r = 1; r < votes.length; r++) {
    if (!votes[r][0]) continue; // no token = empty row
    totalBallots++;
    for (var c = 1; c <= 4; c++) {
      var id = String(votes[r][c]);
      if (id) counts[id] = (counts[id] || 0) + 1;
    }
  }
  var names = {};
  listCandidates().forEach(function (cand) { names[cand.id] = cand.name; });
  var results = Object.keys(counts)
    .map(function (id) {
      return { id: id, name: names[id] || id, count: counts[id] };
    })
    .sort(function (a, b) { return b.count - a.count; });
  return { totalBallots: totalBallots, results: results };
}

/* ---------------- shared gate: key format → rate limit → roster ---------------- */

function validateKeyAndRate(key, action) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    return { error: fail('BAD_REQUEST', '選票識別碼格式錯誤。') };
  }
  if (rateLimited()) {
    return { error: fail('RATE_LIMITED', '嘗試次數過多，請稍後再試。') };
  }
  var h2 = serverHash(key);
  var family = findFamily(h2);
  if (!family || family.eligible !== 'Y') {
    recordFailure();
    audit(action, h2, 'UNKNOWN_STUDENT', '');
    return {
      error: fail(
        'UNKNOWN_STUDENT',
        '查無此學生資料，請確認姓名與座號是否正確（雙胞胎家庭請勾選並填寫兩位學生）。'
      ),
    };
  }
  return { h2: h2, family: family };
}

/* ---------------- data access ---------------- */

function ss() {
  return SpreadsheetApp.getActive();
}

// Guarantees the header row exists before an append, so appendRow lands in
// row 2+ (readers skip row 1). Self-heals a sheet that was cleared by hand.
function ensureHeader(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
}

function readConfig() {
  var values = ss().getSheetByName(SHEET_CONFIG).getDataRange().getValues();
  var config = {};
  values.forEach(function (row) {
    if (row[0]) config[String(row[0]).trim()] = String(row[1]).trim();
  });
  return config;
}

function readRoster() {
  return ss().getSheetByName(SHEET_ROSTER).getDataRange().getValues();
}

function findFamily(h2) {
  var rows = readRoster();
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][4]).toLowerCase() === h2) {
      return {
        row: r + 1,
        familyId: String(rows[r][0]),
        displayName: String(rows[r][1]),
        eligible: String(rows[r][5]).trim().toUpperCase(),
      };
    }
  }
  return null;
}

function listCandidates() {
  var rows = readRoster();
  var out = [];
  for (var r = 1; r < rows.length; r++) {
    if (!rows[r][0]) continue;
    if (String(rows[r][5]).trim().toUpperCase() !== 'Y') continue;
    out.push({
      id: String(rows[r][0]),
      name: String(rows[r][1]),
      selfRec: String(rows[r][7]).trim().toUpperCase() === 'Y',
    });
  }
  // Self-recommended (自薦) families float to the top of the ballot; roster
  // order is kept within each group (Array.prototype.sort is stable).
  out.sort(function (a, b) { return (b.selfRec ? 1 : 0) - (a.selfRec ? 1 : 0); });
  return out;
}

// Control table (Ballots): identity/dedup/passcode, no votes.
// Columns: key_hash | first_claimed_at | last_updated_at | revision | passcode_hash
function findControl(h2) {
  var rows = ss().getSheetByName(SHEET_BALLOTS).getDataRange().getValues();
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][0]) === h2) {
      var revision = Number(rows[r][3]) || 0;
      return {
        row: r + 1,
        revision: revision,
        hasVoted: revision > 0,
        passcodeHash: rows[r][4] ? String(rows[r][4]) : '',
      };
    }
  }
  return null;
}

// Anonymous votes table, keyed by vote_token = HMAC(PEPPER, "vote|"+H2).
// Columns: vote_token | vote1 | vote2 | vote3 | vote4
function findVotes(token) {
  var rows = ss().getSheetByName(SHEET_VOTES).getDataRange().getValues();
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][0]) === token) {
      return {
        row: r + 1,
        votes: [rows[r][1], rows[r][2], rows[r][3], rows[r][4]].map(String),
      };
    }
  }
  return null;
}

// Upsert a family's votes by token, then sort the sheet by token so row
// order is random (a hash) and carries no voting-order/time information.
function writeVotes(sheet, token, votes) {
  ensureHeader(sheet, VOTES_HEADERS);
  var existing = findVotes(token);
  if (existing) {
    sheet.getRange(existing.row, 2, 1, 4).setValues([votes]);
  } else {
    sheet.appendRow([token, votes[0], votes[1], votes[2], votes[3]]);
  }
  var last = sheet.getLastRow();
  if (last > 2) sheet.getRange(2, 1, last - 1, 5).sort(1);
}

/* ---------------- crypto ---------------- */

function serverHash(h1) {
  var pepper = PropertiesService.getScriptProperties().getProperty('PEPPER');
  if (!pepper) throw new Error('PEPPER script property is not set');
  return bytesToHex(Utilities.computeHmacSha256Signature(h1, pepper));
}

function sha256Hex(str) {
  return bytesToHex(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)
  );
}

function normalizePasscode(raw) {
  return String(raw || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

function generatePasscode() {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid()
  );
  var code = '';
  for (var i = 0; i < PASSCODE_LENGTH; i++) {
    code += PASSCODE_ALPHABET.charAt((bytes[i] & 0xff) % PASSCODE_ALPHABET.length);
  }
  return code;
}

function passcodeHash(h2, passcode) {
  var pepper = PropertiesService.getScriptProperties().getProperty('PEPPER');
  if (!pepper) throw new Error('PEPPER script property is not set');
  return bytesToHex(Utilities.computeHmacSha256Signature(h2 + '|' + passcode, pepper));
}

// Opaque key that links a family to its Votes row WITHOUT revealing identity:
// reversible only with the PEPPER, which is not stored in the sheet.
function voteToken(h2) {
  var pepper = PropertiesService.getScriptProperties().getProperty('PEPPER');
  if (!pepper) throw new Error('PEPPER script property is not set');
  return bytesToHex(Utilities.computeHmacSha256Signature('vote|' + h2, pepper));
}

function bytesToHex(bytes) {
  return bytes
    .map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    })
    .join('');
}

/* ---------------- normalization (reference impl, mirrored in app.js) ---------------- */

function normalizeName(raw) {
  return String(raw).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function normalizeNumber(raw) {
  return String(raw).normalize('NFKC').replace(/\D/g, '').replace(/^0+/, '');
}

function canonicalString(pairs) {
  var sorted = pairs.slice().sort(function (a, b) {
    return (
      Number(a.num) - Number(b.num) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
  });
  return (
    'hp-pre-v1|' +
    sorted
      .map(function (p) {
        return p.name + '|' + p.num;
      })
      .join('|')
  );
}

/* ---------------- rate limiting (global brake; GAS cannot see IPs) ---------------- */

function rateLimited() {
  var count = Number(CacheService.getScriptCache().get('failcount')) || 0;
  return count >= RATE_LIMIT_MAX_FAILURES;
}

function recordFailure() {
  var cache = CacheService.getScriptCache();
  var count = Number(cache.get('failcount')) || 0;
  cache.put('failcount', String(count + 1), RATE_LIMIT_WINDOW_SECONDS);
}

/* ---------------- audit ---------------- */

function audit(action, h2, result, detail) {
  try {
    ss()
      .getSheetByName(SHEET_AUDIT)
      .appendRow([
        new Date().toISOString(),
        action,
        h2 ? String(h2).slice(0, 12) : '',
        result,
        detail || '',
      ]);
  } catch (err) {
    // Auditing must never break the request path.
  }
}

/* ---------------- responses ---------------- */

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function fail(code, message) {
  return jsonOut({ ok: false, error: code, message: message });
}

/* ---------------- admin: run from the GAS editor ---------------- */

/**
 * Creates the 4 tabs with header rows and Config defaults.
 * Safe to re-run: existing tabs/values are left untouched.
 */
function adminSetupSheets() {
  var s = ss();
  var specs = [
    { name: SHEET_CONFIG, headers: ['key', 'value'] },
    {
      name: SHEET_ROSTER,
      headers: [
        'family_id',
        'display_name',
        'student_names',
        'student_numbers',
        'key_hash',
        'eligible',
        'notes',
        'self_recommended',
      ],
    },
    {
      name: SHEET_BALLOTS,
      headers: [
        'key_hash',
        'first_claimed_at',
        'last_updated_at',
        'revision',
        'passcode_hash',
      ],
    },
    {
      name: SHEET_VOTES,
      headers: ['vote_token', 'vote1', 'vote2', 'vote3', 'vote4'],
    },
    { name: SHEET_AUDIT, headers: ['timestamp', 'action', 'key_prefix', 'result', 'detail'] },
  ];
  specs.forEach(function (spec) {
    var sheet = s.getSheetByName(spec.name) || s.insertSheet(spec.name);
    var current = sheet
      .getRange(1, 1, 1, spec.headers.length)
      .getValues()[0]
      .map(String)
      .join('|');
    if (current !== spec.headers.join('|')) {
      sheet.getRange(1, 1, 1, spec.headers.length).setValues([spec.headers]);
      sheet.getRange(1, 1, 1, spec.headers.length).setFontWeight('bold');
    }
  });

  var config = readConfig();
  var defaults = [
    ['ELECTION_STATUS', 'CLOSED'],
    ['SALT', ''],
    ['VOTES_REQUIRED', '4'],
    ['ELECTION_TITLE', '家長代表選舉'],
  ];
  var configSheet = s.getSheetByName(SHEET_CONFIG);
  defaults.forEach(function (kv) {
    if (!(kv[0] in config)) configSheet.appendRow(kv);
  });
  adminRebuildHashes();
}

/**
 * One-time migration / fresh start for the anonymized-ballot schema.
 * Rebuilds the control `Ballots` sheet (identity/passcode, NO votes) and the
 * anonymous `Votes` sheet (vote_token + votes, NO identity), and clears
 * AuditLog rows. DESTROYS any existing ballots — run only with disposable
 * (e.g. test) data, before real voting begins.
 */
function adminResetBallots() {
  var s = ss();
  var b = s.getSheetByName(SHEET_BALLOTS) || s.insertSheet(SHEET_BALLOTS);
  b.clear();
  b.getRange(1, 1, 1, 5)
    .setValues([['key_hash', 'first_claimed_at', 'last_updated_at', 'revision', 'passcode_hash']])
    .setFontWeight('bold');

  var v = s.getSheetByName(SHEET_VOTES) || s.insertSheet(SHEET_VOTES);
  v.clear();
  v.getRange(1, 1, 1, 5)
    .setValues([['vote_token', 'vote1', 'vote2', 'vote3', 'vote4']])
    .setFontWeight('bold');

  var a = s.getSheetByName(SHEET_AUDIT);
  if (a && a.getLastRow() > 1) {
    a.getRange(2, 1, a.getLastRow() - 1, a.getLastColumn()).clearContent();
  }
}

/**
 * Lost-passcode reset for one family. Looks up the family's key_hash from the
 * Roster, finds its control row, and clears passcode_hash — the family's next
 * vote then issues a fresh passcode and overwrites their existing (anonymous)
 * Votes row via the token, so the tally is never double-counted or lost.
 * Votes are NOT touched. Run from the editor, e.g. adminClearPasscode('F07').
 */
function adminClearPasscode(familyId) {
  var roster = readRoster();
  var h2 = null;
  for (var r = 1; r < roster.length; r++) {
    if (String(roster[r][0]) === String(familyId)) {
      h2 = String(roster[r][4]).toLowerCase();
      break;
    }
  }
  if (!h2) throw new Error('Unknown family_id: ' + familyId);
  var control = findControl(h2);
  if (!control) throw new Error('No ballot claimed yet for ' + familyId);
  ss().getSheetByName(SHEET_BALLOTS).getRange(control.row, 5).setValue('');
  return familyId + ': passcode cleared; their next vote issues a new one.';
}

/**
 * Reads Roster student_names (col C) + student_numbers (col D),
 * applies the reference normalization, and writes H2 into key_hash (col E).
 * Run once after editing the roster. Names may be separated by , or 、or ，.
 */
function adminRebuildHashes() {
  var sheet = ss().getSheetByName(SHEET_ROSTER);
  var rows = sheet.getDataRange().getValues();
  for (var r = 1; r < rows.length; r++) {
    if (!rows[r][0]) continue;
    var names = String(rows[r][2]).split(/[,，、]/).map(normalizeName).filter(Boolean);
    var nums = String(rows[r][3]).split(/[,，、]/).map(normalizeNumber).filter(Boolean);
    if (!names.length || names.length !== nums.length) {
      sheet.getRange(r + 1, 5).setValue('ERROR: names/numbers mismatch');
      continue;
    }
    var pairs = names.map(function (name, i) {
      return { name: name, num: nums[i] };
    });
    var h1 = sha256Hex(canonicalString(pairs));
    sheet.getRange(r + 1, 5).setValue(serverHash(h1));
  }
}

/**
 * Builds the "結果" tab: votes per candidate, ranked high-to-low.
 * Results stay blank until Config ELECTION_STATUS = "ENDED" (a third state
 * alongside OPEN/CLOSED; voting is already rejected whenever status != OPEN).
 * Safe to re-run; rebuilds the sheet. Formulas only (COUNTIF/SORT/FILTER),
 * so it stays live without re-running.
 */
function adminCreateResultsTab() {
  var s = ss();
  var roster = s.getSheetByName(SHEET_ROSTER).getDataRange().getValues();
  var n = 0;
  for (var i = 1; i < roster.length; i++) if (roster[i][0]) n++;

  var sheet = s.getSheetByName('結果') || s.insertSheet('結果');
  sheet.clear();

  sheet.getRange('A1').setFormula(
    '=IF(Config!$B$2="ENDED","投票結果（已結束）","結果尚未公開：將 Config 的 ELECTION_STATUS 改為 ENDED 後才會顯示")'
  );
  sheet.getRange('A1').setFontWeight('bold').setFontSize(13);
  sheet.getRange('A2').setValue('投票戶數');
  sheet.getRange('B2').setFormula('=IF(Config!$B$2="ENDED",COUNTIF(Votes!$B$2:$B,"<>"),"—")');
  sheet.getRange('A4:C4').setValues([['名次', '候選家庭', '得票數']]);
  sheet.getRange('A4:C4').setFontWeight('bold');

  var first = 5;
  var last = first + n - 1;

  // Hidden helper columns E (candidate name) / F (vote count, gated on ENDED).
  var helper = [];
  for (var r = 0; r < n; r++) {
    var rr = r + 2; // roster data row
    helper.push([
      '=Roster!B' + rr,
      '=IF(Config!$B$2="ENDED",COUNTIF(Votes!$B$2:$E,Roster!A' + rr + '),"")',
    ]);
  }
  sheet.getRange(first, 5, n, 2).setFormulas(helper);

  // Display: rank + sorted name/count, all blank until ENDED.
  sheet.getRange('A' + first).setFormula(
    '=IF(Config!$B$2<>"ENDED","",IFERROR(SEQUENCE(COUNT($F$' + first + ':$F$' + last + ')),""))'
  );
  sheet.getRange('B' + first).setFormula(
    '=IFERROR(SORT(FILTER($E$' + first + ':$F$' + last + ',$F$' + first + ':$F$' + last + '<>""),2,FALSE),"")'
  );

  sheet.hideColumns(5, 2);
  sheet.setColumnWidth(1, 60);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 90);
}
