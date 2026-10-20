// Client-side drop model. Reads the esbuild-transpiled copy of vault.ts that
// `npm test` writes first — this Node build has no TypeScript support.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as V from "./.test-build/vault.js";
const { dropFiles, totalBytes } = V;

const mk = (payload) => ({ payload });

test("reads the file list", () => {
  const files = [{ name: "a", size: 1 }, { name: "b", size: 2 }];
  assert.deepEqual(dropFiles(mk({ files })), files);
  assert.equal(totalBytes(files), 3);
});

test("falls back to a legacy single-file record", () => {
  const file = { name: "old", size: 9 };
  assert.deepEqual(dropFiles(mk({ file })), [file]);
});

test("prefers the list when a record somehow has both", () => {
  const files = [{ name: "new", size: 1 }];
  assert.deepEqual(dropFiles(mk({ files, file: { name: "old", size: 9 } })), files);
});

test("returns nothing for a note", () => {
  assert.deepEqual(dropFiles(mk({ text: "hi" })), []);
  assert.deepEqual(dropFiles(mk({ files: [] })), []);
  assert.equal(totalBytes([]), 0);
});

/* ---- relay routing: which host a file goes to, and how it comes back ---- */

const { FILE_MAX, SMALL_FILE_MAX, BLOB_DOWNLOAD_MAX, isDirectLink } = V;
const GB = 1024 ** 3;

test("caps files at 50 GB", () => {
  assert.equal(FILE_MAX, 50 * GB);
  assert.ok(SMALL_FILE_MAX < FILE_MAX);
});

test("only gofile needs a landing page", () => {
  assert.equal(isDirectLink({ host: "tmpfiles" }), true);
  assert.equal(isDirectLink({ host: "litterbox" }), true);
  assert.equal(isDirectLink({ host: "gofile" }), false);
});

test("never blob-downloads more than 100 MB", () => {
  // Buffering past this crashes the tab, so the threshold must not drift up
  // with the file cap.
  assert.equal(BLOB_DOWNLOAD_MAX, 100 * 1024 * 1024);
  assert.ok(BLOB_DOWNLOAD_MAX < FILE_MAX);
});
