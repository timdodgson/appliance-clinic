/**
 * Compare a deployed artefact with a source tree by content, not by path.
 *
 * Deploy scripts copy files between folders when they build a zip, so the same file can sit at
 * a different path in the artefact. A deployed file with no byte-identical file anywhere in the
 * source means production is not running that source.
 */
export function compareDeployedWithSource(artifactEntries, sourceEntries) {
  const byHash = new Map();
  for (const [path, info] of Object.entries(sourceEntries)) {
    if (!byHash.has(info.sha256)) byHash.set(info.sha256, []);
    byHash.get(info.sha256).push(path);
  }
  const matched = [];
  const unmatched = [];
  const dependencies = [];
  for (const [path, info] of Object.entries(artifactEntries).sort(([a], [b]) => a.localeCompare(b))) {
    if (path.startsWith('node_modules/') || path.includes('/node_modules/')) { dependencies.push(path); continue; }
    const sources = byHash.get(info.sha256);
    if (sources) matched.push({ path, sources, samePath: sources.includes(path) });
    else unmatched.push({ path, size: info.size, sha256: info.sha256 });
  }
  return {
    summary: {
      files: Object.keys(artifactEntries).length,
      matched: matched.length,
      unmatched: unmatched.length,
      bundledDependencyFiles: dependencies.length,
      equivalent: unmatched.length === 0,
    },
    unmatched,
    matched,
    bundledPackages: bundledPackages(dependencies),
  };
}

/** Top-level packages bundled in node_modules (their versions inform Phase 3 pinning). */
function bundledPackages(paths) {
  const names = new Set();
  for (const p of paths) {
    const rest = p.slice(p.indexOf('node_modules/') + 'node_modules/'.length).split('/');
    names.add(rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]);
  }
  return [...names].sort();
}
