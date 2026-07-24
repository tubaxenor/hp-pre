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
 * The normalization + canonical-string logic here is the REFERENCE
 * implementation; docs/app.js mirrors it (test vectors in README).
 */

var SHEET_CONFIG = 'Config';
var SHEET_ROSTER = 'Roster';
var SHEET_BALLOTS = 'Ballots';
var SHEET_AUDIT = 'AuditLog';

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

  var ballot = findBallot(gate.h2);

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
      ballot = findBallot(gate.h2);
      if (!ballot) {
        var passcode = generatePasscode();
        ss().getSheetByName(SHEET_BALLOTS).appendRow([
          gate.h2,
          gate.family.familyId,
          '', '', '', '',
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
        res.currentVotes = ballot.votes;
        res.revision = ballot.revision;
      }
    } else {
      recordFailure();
      audit('check', gate.h2, 'PASSCODE_WRONG', '');
      return fail('PASSCODE_WRONG', '領票碼錯誤，請確認後再試。');
    }
  } else {
    // Legacy ballot without a passcode; next vote issues one.
    res.hasVoted = ballot.hasVoted;
    if (ballot.hasVoted) {
      res.currentVotes = ballot.votes;
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
    var sheet = ss().getSheetByName(SHEET_BALLOTS);
    var now = new Date().toISOString();
    var existing = findBallot(gate.h2);
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
        // Legacy ballot: issue a passcode on this update.
        newPasscode = generatePasscode();
        sheet.getRange(existing.row, 10).setValue(passcodeHash(gate.h2, newPasscode));
      }
      revision = existing.revision + 1;
      sheet
        .getRange(existing.row, 3, 1, 4)
        .setValues([votes]);
      sheet.getRange(existing.row, 8).setValue(now);
      sheet.getRange(existing.row, 9).setValue(revision);
      // First actual vote on a freshly claimed (empty) ballot is a claim, not a change.
      status = existing.hasVoted ? 'updated' : 'claimed';
    } else {
      revision = 1;
      newPasscode = generatePasscode();
      sheet.appendRow([
        gate.h2,
        gate.family.familyId,
        votes[0],
        votes[1],
        votes[2],
        votes[3],
        now,
        now,
        revision,
        passcodeHash(gate.h2, newPasscode),
      ]);
      status = 'claimed';
    }
    audit('vote', gate.h2, 'OK', status + ' rev=' + revision + ' votes=' + votes.join(','));
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
  if (!config.ADMIN_TOKEN_HASH || tokenHash !== String(config.ADMIN_TOKEN_HASH).toLowerCase()) {
    recordFailure();
    audit('tally', '', 'UNAUTHORIZED', '');
    return fail('UNAUTHORIZED', '管理密鑰錯誤。');
  }

  var counts = {};
  var ballots = ss().getSheetByName(SHEET_BALLOTS).getDataRange().getValues();
  var totalBallots = 0;
  for (var r = 1; r < ballots.length; r++) {
    if (!ballots[r][0]) continue;
    if (!String(ballots[r][2])) continue; // claimed but not voted
    totalBallots++;
    for (var c = 2; c <= 5; c++) {
      var id = String(ballots[r][c]);
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

  audit('tally', '', 'OK', 'ballots=' + totalBallots);
  return jsonOut({
    ok: true,
    electionStatus: config.ELECTION_STATUS,
    totalBallots: totalBallots,
    results: results,
  });
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
    out.push({ id: String(rows[r][0]), name: String(rows[r][1]) });
  }
  return out;
}

function findBallot(h2) {
  var rows = ss().getSheetByName(SHEET_BALLOTS).getDataRange().getValues();
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][0]) === h2) {
      return {
        row: r + 1,
        votes: [rows[r][2], rows[r][3], rows[r][4], rows[r][5]].map(String),
        hasVoted: !!String(rows[r][2]),
        revision: Number(rows[r][8]) || 0,
        passcodeHash: rows[r][9] ? String(rows[r][9]) : '',
      };
    }
  }
  return null;
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
      ],
    },
    {
      name: SHEET_BALLOTS,
      headers: [
        'key_hash',
        'family_id',
        'vote1',
        'vote2',
        'vote3',
        'vote4',
        'first_claimed_at',
        'last_updated_at',
        'revision',
        'passcode_hash',
      ],
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
    ['ADMIN_TOKEN_HASH', ''],
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
