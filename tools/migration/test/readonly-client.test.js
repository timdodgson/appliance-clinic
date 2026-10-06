import { describe, expect, it } from 'vitest';
import { LambdaClient, ListFunctionsCommand, UpdateFunctionCodeCommand, AddPermissionCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { guardReadOnly, isReadOnlyCommandName, ReadOnlyViolation } from '../src/aws/readonly-client.js';
import { guardAllowlist, CommandNotAllowed } from '../src/aws/allowlisted-client.js';

const credentials = { accessKeyId: 'AKIDTESTONLY', secretAccessKey: 'test-only' };

// Short-circuits the request after the guard has run, so no network call is made.
function stubTransport(client) {
  client.middlewareStack.add(() => async () => ({ output: { $metadata: {}, stubbed: true } }), { step: 'initialize', name: 'stub', priority: 'low' });
  return client;
}

describe('isReadOnlyCommandName', () => {
  it.each(['ListFunctionsCommand', 'GetRoleCommand', 'DescribeTableCommand', 'LookupEventsCommand', 'HeadBucketCommand', 'BatchGetItemCommand'])('allows %s', (name) => {
    expect(isReadOnlyCommandName(name)).toBe(true);
  });

  it.each(['UpdateFunctionCodeCommand', 'PutRolePolicyCommand', 'DeleteTableCommand', 'CreateBackupCommand', 'AddPermissionCommand', 'PutSecretValueCommand', 'TagResourceCommand', 'InvokeCommand', 'Getaway', '', undefined])('refuses %s', (name) => {
    expect(isReadOnlyCommandName(name)).toBe(false);
  });

  it('refuses secret values unless explicitly allowed', () => {
    expect(isReadOnlyCommandName('GetSecretValueCommand')).toBe(false);
    expect(isReadOnlyCommandName('GetSecretValueCommand', { allowSecretValues: true })).toBe(true);
  });
});

describe('guardReadOnly on a real SDK client', () => {
  it('rejects a mutating command before it is sent', async () => {
    const client = stubTransport(guardReadOnly(new LambdaClient({ region: 'eu-west-1', credentials })));
    await expect(client.send(new UpdateFunctionCodeCommand({ FunctionName: 'x', ZipFile: new Uint8Array() }))).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(client.send(new AddPermissionCommand({ FunctionName: 'x', StatementId: 's', Action: 'lambda:InvokeFunction', Principal: '*' }))).rejects.toBeInstanceOf(ReadOnlyViolation);
  });

  it('lets a read command through', async () => {
    const client = stubTransport(guardReadOnly(new LambdaClient({ region: 'eu-west-1', credentials })));
    await expect(client.send(new ListFunctionsCommand({}))).resolves.toMatchObject({ stubbed: true });
  });

  it('blocks secret values by default and allows them only when opted in', async () => {
    const locked = stubTransport(guardReadOnly(new SecretsManagerClient({ region: 'eu-west-1', credentials })));
    await expect(locked.send(new GetSecretValueCommand({ SecretId: 's' }))).rejects.toBeInstanceOf(ReadOnlyViolation);
    const opted = stubTransport(guardReadOnly(new SecretsManagerClient({ region: 'eu-west-1', credentials }), { allowSecretValues: true }));
    await expect(opted.send(new GetSecretValueCommand({ SecretId: 's' }))).resolves.toMatchObject({ stubbed: true });
    await expect(opted.send(new PutSecretValueCommand({ SecretId: 's', SecretString: 'x' }))).rejects.toBeInstanceOf(ReadOnlyViolation);
  });
});

describe('guardAllowlist', () => {
  it('allows only the named mutating commands', async () => {
    const client = stubTransport(guardAllowlist(new LambdaClient({ region: 'eu-west-1', credentials }), ['AddPermissionCommand']));
    await expect(client.send(new AddPermissionCommand({ FunctionName: 'x', StatementId: 's', Action: 'lambda:InvokeFunction', Principal: '*' }))).resolves.toMatchObject({ stubbed: true });
    await expect(client.send(new ListFunctionsCommand({}))).resolves.toMatchObject({ stubbed: true });
    await expect(client.send(new UpdateFunctionCodeCommand({ FunctionName: 'x', ZipFile: new Uint8Array() }))).rejects.toBeInstanceOf(CommandNotAllowed);
  });
});
