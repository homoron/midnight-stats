import assert from "assert";
import { publicScoresheetUrl, unpublishedRecords, restoreManualStats, readScoresheet } from "../site/manual-reader.js";

assert.strictEqual(
  publicScoresheetUrl("https://storage.googleapis.com/match-scorecard-pdf/alqueriabasket/match.pdf"),
  "https://storage.googleapis.com/storage/v1/b/match-scorecard-pdf/o/alqueriabasket%2Fmatch.pdf?alt=media",
);
assert.strictEqual(
  publicScoresheetUrl("https://storage.googleapis.com/match-scorecard-pdf/alqueriabasket%2Fmatch%20one.pdf"),
  "https://storage.googleapis.com/storage/v1/b/match-scorecard-pdf/o/alqueriabasket%2Fmatch%20one.pdf?alt=media",
);
for (const url of ["http://storage.googleapis.com/match-scorecard-pdf/a.pdf", "https://example.com/a.pdf",
  "https://storage.googleapis.com/private-bucket/a.pdf"]) {
  assert.throws(() => publicScoresheetUrl(url));
}

const record = (id) => ({ match: { id, home: {}, away: {} }, checkedAt: "2026-10-18T18:00:00Z" });
const records = { published: record("published"), pending: record("pending"), broken: { match: null } };
assert.deepStrictEqual(unpublishedRecords({ matches: { published: { id: "published" } } }, records), [records.pending]);
assert.deepStrictEqual(unpublishedRecords(null, records), [records.published, records.pending]);
assert.deepStrictEqual(unpublishedRecords({ matches: { published: {}, pending: {} } }, records), []);

// Reloading a saved result must not need to download the Python runtime again.
const published = { generated_at: "2026-10-18T18:00:00Z", matches: {} };
const snapshot = { ...published, matches: { pending: records.pending.match } };
const values = new Map([["manual-scoresheets.v1.reload", {
  records: { pending: records.pending }, baseGeneratedAt: published.generated_at, snapshot,
}]]);
const storage = { get: (key, fallback) => values.get(key) || fallback, set: (key, value) => values.set(key, value) };
assert.deepStrictEqual(await restoreManualStats(published, "reload", storage), snapshot);
const newlyPublished = { ...published, generated_at: "2026-10-18T18:10:00Z", matches: { pending: { official: true } } };
assert.strictEqual(await restoreManualStats(newlyPublished, "reload", storage), newlyPublished);
assert.strictEqual(values.get("manual-scoresheets.v1.reload"), null);

// Node 14 lacks these browser APIs; this case only exercises the HTTP status handling.
globalThis.AbortController = globalThis.AbortController || class { abort() {} };
globalThis.fetch = async () => ({ status: 404 });
await assert.rejects(() => readScoresheet({}, {
  scoresheetUrl: "https://storage.googleapis.com/match-scorecard-pdf/missing.pdf",
}, [], () => {}), (error) => error.code === "not-published");
console.log("Manual reader URL, persistence, published precedence and missing PDF checks passed.");
