/* hp-pre frontend — identity → key → check → select → vote.
 * Key derivation must stay in sync with the reference implementation
 * in apps-script/Code.gs (see README test vectors). */

(() => {
  "use strict";

  const VOTES_REQUIRED = 4;

  const state = {
    key: null,          // H1 (64-hex), the only identity value sent to the server
    candidates: [],     // [{id, name}]
    hasBallot: false,
    currentVotes: [],   // [family_id]
    revision: 0,
    electionOpen: false,
    selected: new Set(),
    passcode: null,        // entered by voter (change) or issued by server (claim)
    passcodeRequired: false,
    hasVoted: false,
    claimedNow: false,     // passcode was issued in this session's check
  };

  const $ = (id) => document.getElementById(id);

  /* ---------- key derivation: shared module (docs/key.js, mirrors Code.gs) ---------- */

  const { normalizeName, normalizeNumber, canonicalString, computeKey } =
    window.HP_KEY;

  /* ---------- API client ---------- */

  async function api(payload) {
    const res = await fetch(window.APP_CONFIG.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  /* ---------- UI helpers ---------- */

  const SCREENS = ["identity", "status", "select", "done"];

  function showScreen(name) {
    SCREENS.forEach((s) => $("screen-" + s).classList.toggle("hidden", s !== name));
    $("select-bar").classList.toggle("hidden", name !== "select");
    updateSteps(name);
    window.scrollTo({ top: 0 });
  }

  function updateSteps(name) {
    const order = { identity: 0, status: 0, select: 1, confirm: 2, done: 3 };
    const idx = order[name] ?? 0;
    document.querySelectorAll("#steps .step").forEach((el, i) => {
      el.classList.toggle("step-primary", i <= idx);
    });
  }

  function showError(msg) {
    $("error-message").textContent = msg;
    $("error-banner").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function hideError() {
    $("error-banner").classList.add("hidden");
  }

  function setLoading(on) {
    $("loading").classList.toggle("hidden", !on);
  }

  function candidateName(id) {
    const c = state.candidates.find((c) => c.id === id);
    return c ? c.name : id;
  }

  function renderVoteList(el, ids) {
    el.innerHTML = "";
    ids.forEach((id) => {
      const li = document.createElement("li");
      li.textContent = candidateName(id);
      el.appendChild(li);
    });
  }

  /* ---------- screen 1: identity ---------- */

  // Pressing Enter in any text field triggers its screen's primary button.
  function submitOnEnter(inputId, buttonId) {
    $(inputId).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $(buttonId).click();
      }
    });
  }
  ["name-1", "num-1", "name-2", "num-2"].forEach((id) =>
    submitOnEnter(id, "btn-check")
  );
  submitOnEnter("passcode-input", "btn-verify-passcode");

  $("twins-toggle").addEventListener("change", (e) => {
    $("student-2").classList.toggle("hidden", !e.target.checked);
  });

  $("btn-check").addEventListener("click", async () => {
    hideError();
    const pairs = [];
    const name1 = normalizeName($("name-1").value);
    const num1 = normalizeNumber($("num-1").value);
    if (!name1 || !num1) {
      showError("請填寫學生姓名與座號。");
      return;
    }
    pairs.push({ name: name1, num: num1 });

    if ($("twins-toggle").checked) {
      const name2 = normalizeName($("name-2").value);
      const num2 = normalizeNumber($("num-2").value);
      if (!name2 || !num2) {
        showError("已勾選雙胞胎，請填寫第二位學生的姓名與座號。");
        return;
      }
      pairs.push({ name: name2, num: num2 });
    }

    setLoading(true);
    try {
      state.key = await computeKey(canonicalString(pairs));
      const res = await api({ action: "check", key: state.key });
      if (!res.ok) {
        showError(res.message || "發生錯誤，請稍後再試。");
        return;
      }
      state.candidates = res.candidates || [];
      state.hasBallot = res.hasBallot;
      state.hasVoted = !!res.hasVoted;
      state.currentVotes = res.currentVotes || [];
      state.revision = res.revision || 0;
      state.electionOpen = res.electionOpen;
      state.passcode = res.passcode || null;
      state.claimedNow = !!res.passcode;
      state.passcodeRequired = !!res.passcodeRequired;
      if (res.title) $("election-title").textContent = res.title;
      renderStatus();
      showScreen("status");
    } catch (err) {
      showError("連線失敗，請檢查網路後重試。");
    } finally {
      setLoading(false);
    }
  });

  /* ---------- screen 2: ballot status ---------- */

  function renderStatus() {
    const locked = state.hasBallot && state.passcodeRequired;
    const claimed = state.claimedNow;
    const voted = state.hasVoted;

    let stamp, title, desc;
    if (claimed) {
      stamp = "領選票";
      title = "領取選票";
      desc = "身分確認成功，已為您登記選票！請先保存下方的領票碼，再開始圈選。";
    } else if (locked) {
      stamp = "領票碼";
      title = "輸入領票碼";
      desc = "此家庭已領取選票。請輸入領票碼以繼續。";
    } else if (voted) {
      stamp = "更改選票";
      title = "更改選票";
      desc = "此家庭已投過票。您可以重新圈選，送出後將覆蓋原選票。";
    } else {
      stamp = "領選票";
      title = "領取選票";
      desc = "選票尚未圈選，請開始圈選 4 位候選家庭。";
    }
    $("stamp-text").textContent = stamp;
    $("status-title").textContent = title;
    $("status-desc").textContent = desc;

    $("claim-passcode-box").classList.toggle("hidden", !claimed);
    if (claimed) $("claim-passcode").textContent = state.passcode;

    $("passcode-box").classList.toggle("hidden", !locked);
    $("current-votes-box").classList.toggle("hidden", !voted || locked);
    if (voted && !locked) {
      renderVoteList($("current-votes"), state.currentVotes);
      $("revision-badge").textContent = `第 ${state.revision} 次填寫`;
    }

    const btn = $("btn-start-select");
    btn.textContent = voted ? "重新圈選" : "開始圈選";
    if (!state.electionOpen) {
      btn.disabled = true;
      showError("投票已截止，無法圈選或更改選票。");
    } else {
      btn.disabled = locked;
    }
  }

  $("btn-verify-passcode").addEventListener("click", async () => {
    hideError();
    const pc = $("passcode-input")
      .value.normalize("NFKC")
      .replace(/\s+/g, "")
      .toUpperCase();
    if (pc.length !== 5) {
      showError("請輸入 5 碼領票碼。");
      return;
    }
    setLoading(true);
    try {
      const res = await api({ action: "check", key: state.key, passcode: pc });
      if (!res.ok) {
        showError(res.message || "發生錯誤，請稍後再試。");
        return;
      }
      state.passcode = pc;
      state.passcodeRequired = false;
      state.hasVoted = !!res.hasVoted;
      state.currentVotes = res.currentVotes || [];
      state.revision = res.revision || 0;
      renderStatus();
    } catch (err) {
      showError("連線失敗，請檢查網路後重試。");
    } finally {
      setLoading(false);
    }
  });

  $("btn-start-select").addEventListener("click", () => {
    hideError();
    state.selected = new Set(state.hasVoted ? state.currentVotes : []);
    renderCandidates();
    showScreen("select");
  });

  $("btn-back-identity").addEventListener("click", () => {
    hideError();
    showScreen("identity");
  });

  /* ---------- screen 3: selection ---------- */

  function renderCandidates() {
    const grid = $("candidate-grid");
    grid.innerHTML = "";
    state.candidates.forEach((c) => {
      const label = document.createElement("label");
      label.className = "candidate-cell";
      label.dataset.id = c.id;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state.selected.has(c.id);

      const mark = document.createElement("span");
      mark.className = "mark-circle";
      mark.textContent = "圈";

      const name = document.createElement("span");
      name.className = "candidate-name";
      name.textContent = c.name;

      input.addEventListener("change", () => {
        if (input.checked) state.selected.add(c.id);
        else state.selected.delete(c.id);
        refreshSelection();
      });

      label.append(input, mark, name);
      grid.appendChild(label);
    });
    refreshSelection();
  }

  function refreshSelection() {
    const full = state.selected.size >= VOTES_REQUIRED;
    document.querySelectorAll(".candidate-cell").forEach((cell) => {
      const input = cell.querySelector("input");
      const checked = state.selected.has(cell.dataset.id);
      cell.classList.toggle("checked", checked);
      const locked = full && !checked;
      cell.classList.toggle("disabled", locked);
      input.disabled = locked;
    });
    $("count-now").textContent = state.selected.size;
    $("btn-submit").disabled = state.selected.size !== VOTES_REQUIRED;
  }

  /* ---------- confirm + submit ---------- */

  $("btn-submit").addEventListener("click", () => {
    renderVoteList($("confirm-votes"), [...state.selected]);
    updateSteps("confirm");
    $("confirm-modal").showModal();
  });

  $("btn-confirm-cancel").addEventListener("click", () => {
    $("confirm-modal").close();
    updateSteps("select");
  });

  $("btn-confirm-submit").addEventListener("click", async () => {
    $("confirm-modal").close();
    hideError();
    setLoading(true);
    try {
      const votes = [...state.selected];
      const payload = { action: "vote", key: state.key, votes };
      if (state.passcode) payload.passcode = state.passcode;
      const res = await api(payload);
      if (!res.ok) {
        showError(res.message || "發生錯誤，請稍後再試。");
        updateSteps("select");
        return;
      }
      state.hasBallot = true;
      state.hasVoted = true;
      state.currentVotes = votes;
      state.revision = res.revision;
      if (res.passcode) state.passcode = res.passcode;
      // Repeat the passcode on the success screen when it was issued this session.
      const remind = res.passcode || (state.claimedNow && state.passcode);
      $("done-passcode-box").classList.toggle("hidden", !remind);
      if (remind) $("done-passcode").textContent = state.passcode;
      const updated = res.status === "updated";
      $("done-stamp-text").textContent = updated ? "選票已更新" : "投票成功";
      $("done-title").textContent = updated ? "選票已更新！" : "投票成功！";
      $("done-desc").textContent = updated
        ? "您的選票已更新完成，感謝您的參與。"
        : "您的選票已送出，感謝您的參與。";
      renderVoteList($("done-votes"), votes);
      $("done-revision").textContent = `第 ${res.revision} 次填寫`;
      showScreen("done");
    } catch (err) {
      showError("連線失敗，請檢查網路後重試。您的選票尚未送出。");
      updateSteps("select");
    } finally {
      setLoading(false);
    }
  });

  $("error-dismiss").addEventListener("click", hideError);

  showScreen("identity");
})();
