import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeName, normalizeNumber, canonicalString, computeKey } =
  require("../docs/key.js");

// Reference H1 vectors (sha256 of the canonical string, hex lowercase).
// Regenerate with: printf 'hp-pre-v1|測試生|1' | shasum -a 256
const H1_TEST1 = "2a2ce9c4209034e67f8457b5a3516f22cc9f9b53da9032b272c01d5ba16a3f96";
const H1_WANG = "70191d88e8a4adbae96bfdf16d6fc84d787c071a4c08def536d493408edfb50e";
const H1_TWINS = "65a52f37d85362b9063a287929edef50c6318fe485f99056fb3b030cc482ee32";

const key = (pairs) => computeKey(canonicalString(pairs));

test("normalizeName strips all whitespace, folds width, lowercases", () => {
  assert.equal(normalizeName("王 小明"), "王小明");
  assert.equal(normalizeName("  王小明  "), "王小明");
  assert.equal(normalizeName("Ａｂｃ"), "abc");
});

test("normalizeNumber keeps digits only, strips leading zeros, folds width", () => {
  assert.equal(normalizeNumber("０５"), "5");
  assert.equal(normalizeNumber(" 05 "), "5");
  assert.equal(normalizeNumber("no.12"), "12");
  assert.equal(normalizeNumber("abc"), "");
});

test("canonicalString formats and sorts by student number", () => {
  assert.equal(
    canonicalString([{ name: "測試生", num: "1" }]),
    "hp-pre-v1|測試生|1"
  );
  assert.equal(
    canonicalString([
      { name: "測試生四", num: "4" },
      { name: "測試生三", num: "3" },
    ]),
    "hp-pre-v1|測試生三|3|測試生四|4"
  );
});

test("H1 matches the pinned reference vectors", async () => {
  assert.equal(await key([{ name: "測試生", num: "1" }]), H1_TEST1);
  assert.equal(await key([{ name: "王小明", num: "5" }]), H1_WANG);
  assert.equal(
    await key([
      { name: "測試生三", num: "3" },
      { name: "測試生四", num: "4" },
    ]),
    H1_TWINS
  );
});

test("messy input derives the same key as clean input", async () => {
  const clean = await key([{ name: "王小明", num: "5" }]);
  const messy = await key([
    { name: normalizeName("王 小明"), num: normalizeNumber("０５") },
  ]);
  assert.equal(messy, clean);
});

test("twins entry order never changes the key", async () => {
  const ab = await key([
    { name: "測試生三", num: "3" },
    { name: "測試生四", num: "4" },
  ]);
  const ba = await key([
    { name: "測試生四", num: "4" },
    { name: "測試生三", num: "3" },
  ]);
  assert.equal(ab, ba);
  assert.equal(ab, H1_TWINS);
});
