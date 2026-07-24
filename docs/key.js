/* Shared ballot-key derivation — pure functions, no DOM.
 * Reference implementation lives in apps-script/Code.gs; this module must
 * stay byte-identical in behavior (CI pins both with test vectors).
 * Loaded by index.html before app.js; imported by test/key.test.mjs in CI. */

(function (root) {
  "use strict";

  function normalizeName(raw) {
    return String(raw).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  function normalizeNumber(raw) {
    return String(raw).normalize("NFKC").replace(/\D/g, "").replace(/^0+/, "");
  }

  function canonicalString(pairs) {
    const sorted = [...pairs].sort(
      (a, b) =>
        Number(a.num) - Number(b.num) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
    return "hp-pre-v1|" + sorted.map((p) => `${p.name}|${p.num}`).join("|");
  }

  async function computeKey(canonical) {
    const subtle = (root.crypto || {}).subtle;
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  const api = { normalizeName, normalizeNumber, canonicalString, computeKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HP_KEY = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
