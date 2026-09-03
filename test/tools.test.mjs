/**
 * Tests for the registered tool handlers, driven the way an MCP client drives them.
 *
 * The Drive layer has its own suite. What is worth pinning here is the refusal a
 * handler makes before any write is issued, since the failure it prevents is a tool
 * reporting success over a file that is no longer itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { registerTools } from '../dist/tools.js';

/** Collect the handlers registerTools installs, keyed by tool name. */
function registeredTools(drive) {
  const handlers = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      handlers.set(name, handler);
    },
  };
  registerTools(server, drive);
  return handlers;
}

function fakeDrive(file, bytes) {
  const calls = { update: [] };

  return {
    calls,
    drive: {
      files: {
        get(params) {
          if (params.alt === 'media') return Promise.resolve({ data: bytes });
          return Promise.resolve({ data: { ...file } });
        },
        update(params) {
          calls.update.push(params);
          return Promise.resolve({ data: { ...file } });
        },
      },
    },
  };
}

const PDF = {
  id: 'file-1',
  name: 'report.pdf',
  mimeType: 'application/pdf',
  headRevisionId: 'rev-1',
  modifiedTime: '2026-01-01T00:00:00.000Z',
  trashed: false,
};

test('update_file_content refuses a binary file instead of writing text over its bytes', async () => {
  const original = Buffer.from('%PDF-1.4\nÞ­¾ï', 'latin1');
  const { drive, calls } = fakeDrive(PDF, original);
  const update = registeredTools(drive).get('update_file_content');

  const result = await update({
    fileId: 'file-1',
    content: original.toString('base64'),
  });

  assert.equal(result.isError, true, 'a binary file must be refused');
  assert.match(result.content[0].text, /binary file/i);
  assert.match(result.content[0].text, /cannot write binary files/i);
  assert.equal(calls.update.length, 0, 'the corrupting write must never reach the API');
});

test('replace_in_file names a recovery that does not corrupt the file', async () => {
  const { drive } = fakeDrive(PDF, Buffer.from('%PDF-1.4\n', 'latin1'));
  const replace = registeredTools(drive).get('replace_in_file');

  const result = await replace({ fileId: 'file-1', oldString: 'a', newString: 'b' });

  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /base64/i, 'base64 is what destroyed the file');
  assert.match(result.content[0].text, /re-upload/i);
});
