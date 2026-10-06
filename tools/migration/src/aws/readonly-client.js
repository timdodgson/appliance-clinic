/**
 * Read-only guard for AWS SDK v3 clients.
 *
 * Every inventory call goes through a client wrapped here. The guard runs as the first
 * middleware step, so a mutating command is rejected before any request is signed or sent,
 * whichever way the command reaches the client.
 */

// Command names are matched in full, so names such as "PutRule" or "UpdateFunctionCode"
// can never slip through a prefix rule.
const READ_ONLY_COMMAND = /^(Get|List|Describe|Lookup|BatchGet|Head)[A-Za-z0-9]*Command$/;

// Read-shaped commands that still return or expose sensitive material. They are refused unless
// the caller opts in explicitly for that client.
const SENSITIVE_READ_COMMANDS = new Set(['GetSecretValueCommand', 'BatchGetSecretValueCommand']);

export class ReadOnlyViolation extends Error {
  constructor(commandName) {
    super(`Refused AWS command "${commandName}": migration inventory tooling is read-only.`);
    this.name = 'ReadOnlyViolation';
    this.commandName = commandName;
  }
}

export function isReadOnlyCommandName(commandName, { allowSecretValues = false } = {}) {
  if (typeof commandName !== 'string' || !READ_ONLY_COMMAND.test(commandName)) return false;
  if (SENSITIVE_READ_COMMANDS.has(commandName) && !allowSecretValues) return false;
  return true;
}

export function assertReadOnlyCommandName(commandName, options) {
  if (!isReadOnlyCommandName(commandName, options)) throw new ReadOnlyViolation(commandName);
}

/**
 * Attach the guard to an SDK client instance and return it.
 * @param {object} client an AWS SDK v3 client
 * @param {{ allowSecretValues?: boolean }} [options]
 */
export function guardReadOnly(client, options = {}) {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      assertReadOnlyCommandName(context.commandName, options);
      return next(args);
    },
    { step: 'initialize', name: 'appliance-clinic-readonly-guard', priority: 'high' },
  );
  return client;
}
