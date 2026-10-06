/**
 * File-for-file equivalence of two artefacts.
 *
 * A rebuilt zip never has the same CodeSha256 as the original (timestamps and ordering differ),
 * so equivalence means identical file contents and paths. `allowedDifferences` lists paths that
 * are expected to differ, such as the one file a hotfix changes.
 */
export function compareArtifacts(a, b, { allowedDifferences = [], ignore = [] } = {}) {
  const skip = (p) => ignore.some((pattern) => p === pattern || p.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`));
  const onlyInA = [];
  const onlyInB = [];
  const differing = [];
  const modeDiffering = [];
  let identical = 0;
  for (const path of Object.keys(a)) {
    if (skip(path)) continue;
    if (!b[path]) { onlyInA.push(path); continue; }
    if (a[path].sha256 !== b[path].sha256) differing.push(path);
    else identical += 1;
    if (a[path].mode && b[path].mode && a[path].mode !== b[path].mode) modeDiffering.push({ path, a: a[path].mode.toString(8), b: b[path].mode.toString(8) });
  }
  for (const path of Object.keys(b)) if (!skip(path) && !a[path]) onlyInB.push(path);

  const unexpected = [...onlyInA, ...onlyInB, ...differing].filter((p) => !allowedDifferences.includes(p));
  const missingExpected = allowedDifferences.filter((p) => !differing.includes(p) && !onlyInA.includes(p) && !onlyInB.includes(p));
  return {
    equivalent: unexpected.length === 0 && missingExpected.length === 0,
    identical,
    differing: differing.sort(),
    onlyInA: onlyInA.sort(),
    onlyInB: onlyInB.sort(),
    unexpected: unexpected.sort(),
    missingExpected,
    modeDiffering,
  };
}
