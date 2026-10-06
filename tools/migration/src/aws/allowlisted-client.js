/**
 * Guard for the explicit, mutating runbook tooling (backups).
 *
 * Only the commands named by the caller may run, in addition to read-only commands.
 * Anything else is refused before it is sent.
 */
import { isReadOnlyCommandName } from './readonly-client.js';

export class CommandNotAllowed extends Error {
  constructor(commandName) {
    super(`Refused AWS command "${commandName}": not on this runbook's command allowlist.`);
    this.name = 'CommandNotAllowed';
    this.commandName = commandName;
  }
}

export function guardAllowlist(client, allowedCommands) {
  const allowed = new Set(allowedCommands);
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const name = context.commandName;
      if (!allowed.has(name) && !isReadOnlyCommandName(name)) throw new CommandNotAllowed(name);
      return next(args);
    },
    { step: 'initialize', name: 'appliance-clinic-allowlist-guard', priority: 'high' },
  );
  return client;
}
