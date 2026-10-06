/** Minimal argument parser: --flag, --key value, --key=value, and positionals. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; } else flags[key] = true;
  }
  return { flags, positional };
}

export function requireFlag(flags, name) {
  if (flags[name] === undefined || flags[name] === true) {
    throw new Error(`Missing required option --${name}`);
  }
  return flags[name];
}
