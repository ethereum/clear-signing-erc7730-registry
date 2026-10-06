/** What run.js and render.js both read out of an answer. */

/** Findings per severity: the "###" headings inside each section of the answer. */
function countFindings(text) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const [severity, heading] of [['critical', '## Critical'], ['warning', '## Warning'], ['info', '## Info']]) {
    const start = text.indexOf(`\n${heading}`);
    if (start < 0) continue;
    const next = text.indexOf('\n## ', start + 1);
    counts[severity] = (text.slice(start, next < 0 ? undefined : next).match(/^### /gm) ?? []).length;
  }
  return counts;
}

module.exports = { countFindings };
