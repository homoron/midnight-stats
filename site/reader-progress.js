// One unit per completed operation, independent of how long each operation takes.
export const READER_TASKS = Object.freeze([
  "published", "details", "roster", "download",
  "runtime-script", "runtime", "runtime-packages", "pdf-packages", "reader-sources",
  "pdf-text", "pdf-header", "pdf-home", "pdf-away", "pdf-scoring", "match", "validated",
  "aggregated", "saved",
]);

export function readerProgress(completedTasks) {
  const completed = new Set([...completedTasks].filter((task) => READER_TASKS.includes(task))).size;
  return { percent: Math.floor(completed * 100 / READER_TASKS.length), completed, total: READER_TASKS.length };
}
