#!/usr/bin/env node
/**
 * End-to-end verification against a real Drive account. The unit suite mocks the Drive
 * API, so it says nothing about the integration; this launches the server the way an MCP
 * client would and checks that edits land in place and a stale write is refused.
 *
 *   npm run verify
 *
 * Creates two files in your Drive and bins them on the way out, including on failure.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { google } from 'googleapis';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const STAMP = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const PLAIN_NAME = `gdrive-write-mcp-verify-${STAMP}.md`;
const DOC_NAME = `gdrive-write-mcp-verify-doc-${STAMP}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function loadDotEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
if (missing.length > 0) {
  console.error(`\n  ✗ Missing ${missing.join(', ')}.\n    Fill in .env and run \`npm run authorize\` first.\n`);
  process.exit(1);
}

if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
  console.error('\n  ✗ dist/index.js not found. Run `npm run build` first.\n');
  process.exit(1);
}

function textOf(result) {
  return (result.content ?? []).map((c) => c.text ?? '').join('\n');
}

function headerValue(text, key) {
  const line = text.split('\n---\n')[0].split('\n').find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

function bodyOf(readText) {
  const parts = readText.split('\n---\n');
  return parts.slice(1).join('\n---\n');
}

const createdIds = [];

async function main() {
  console.log('\n\x1b[1mgdrive-write-mcp end-to-end verification\x1b[0m');
  console.log(`Test files will be named *${STAMP}* and moved to the bin afterwards.`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'dist', 'index.js')],
    env: {
      ...process.env,
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'gdrive-write-mcp-verify', version: '1.0.0' });

  section('1. Connection');

  await client.connect(transport);
  check('server starts and completes the MCP handshake', true);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(`exposes 9 tools (got ${names.length})`, names.length === 9, names.join(', '));
  for (const expected of ['read_file', 'replace_in_file', 'append_to_file', 'update_file_content']) {
    check(`exposes ${expected}`, names.includes(expected));
  }

  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    return { text: textOf(res), isError: Boolean(res.isError) };
  };

  section('2. Create and read a plain file');

  const INITIAL = '# Verification\n\nstatus: PENDING\n\nA line to replace.\n';

  const created = await call('create_file', { name: PLAIN_NAME, content: INITIAL });
  check('create_file succeeds', !created.isError, created.text);

  const fileId = created.text.match(/^id:\s*(\S+)$/m)?.[1];
  check('create_file returns a file ID', Boolean(fileId), created.text);
  if (!fileId) throw new Error('cannot continue without a file ID');
  createdIds.push(fileId);

  const read1 = await call('read_file', { fileId });
  check('read_file succeeds', !read1.isError, read1.text);
  check('content round-trips exactly', bodyOf(read1.text) === INITIAL, JSON.stringify(bodyOf(read1.text)));

  const token1 = headerValue(read1.text, 'revisionToken');
  check('read_file returns a revisionToken', Boolean(token1) && token1 !== 'unknown', `got: ${token1}`);

  section('3. Targeted edits');

  const appended = await call('append_to_file', { fileId, text: 'Appended line.' });
  check('append_to_file succeeds', !appended.isError, appended.text);

  const read2 = await call('read_file', { fileId });
  check('appended text is present', bodyOf(read2.text).includes('Appended line.'));
  check(
    'append does not double the newline at the seam',
    !bodyOf(read2.text).includes('\n\n\nAppended line.'),
    JSON.stringify(bodyOf(read2.text).slice(-40)),
  );

  const replaced = await call('replace_in_file', {
    fileId,
    oldString: 'status: PENDING',
    newString: 'status: VERIFIED',
  });
  check('replace_in_file succeeds', !replaced.isError, replaced.text);

  const read3 = await call('read_file', { fileId });
  check('replacement applied', bodyOf(read3.text).includes('status: VERIFIED'));
  check('old text is gone', !bodyOf(read3.text).includes('status: PENDING'));
  check('unrelated content untouched', bodyOf(read3.text).includes('A line to replace.'));

  section('4. Error handling');

  const noMatch = await call('replace_in_file', { fileId, oldString: 'not-in-the-file', newString: 'x' });
  check('missing target is reported as an error', noMatch.isError, noMatch.text);
  check('the error explains how to recover', /read the file first/i.test(noMatch.text), noMatch.text);

  await call('append_to_file', { fileId, text: 'DUPLICATE\nDUPLICATE' });
  const ambiguous = await call('replace_in_file', { fileId, oldString: 'DUPLICATE', newString: 'x' });
  check('ambiguous replacement is refused', ambiguous.isError, ambiguous.text);
  check('the error names the occurrence count', /\d+ occurrences/.test(ambiguous.text), ambiguous.text);

  const replaceAll = await call('replace_in_file', {
    fileId,
    oldString: 'DUPLICATE',
    newString: 'RESOLVED',
    replaceAll: true,
  });
  check('replaceAll succeeds where a single replace could not', !replaceAll.isError, replaceAll.text);

  const badId = await call('read_file', { fileId: 'this-is-not-a-real-file-id' });
  check('an unknown file ID is reported clearly', badId.isError && /not found/i.test(badId.text), badId.text);

  section('5. Concurrency guard, the headline claim');

  const readForGuard = await call('read_file', { fileId });
  const goodToken = headerValue(readForGuard.text, 'revisionToken');

  const stale = await call('update_file_content', {
    fileId,
    content: 'this must never land',
    expectedRevisionToken: 'definitely-a-stale-token',
  });
  check('a stale write is REFUSED', stale.isError, stale.text);
  check('the conflict error says to re-read and merge', /re-read/i.test(stale.text), stale.text);

  const afterStale = await call('read_file', { fileId });
  check(
    'the refused write did not touch the file',
    !bodyOf(afterStale.text).includes('this must never land'),
    'CRITICAL: a refused write modified the file',
  );

  const fresh = await call('update_file_content', {
    fileId,
    content: '# Verification\n\nstatus: VERIFIED\n',
    expectedRevisionToken: goodToken,
  });
  check('a write with the current token succeeds', !fresh.isError, fresh.text);

  section('6. In-place semantics, the reason this project exists');

  const finalMeta = await call('get_file_metadata', { fileId });
  const finalId = JSON.parse(finalMeta.text).id;
  check(
    'file ID is UNCHANGED after all edits',
    finalId === fileId,
    `started ${fileId}, ended ${finalId}. If these differ, edits are not in place`,
  );

  const revisions = await call('list_revisions', { fileId });
  const revisionCount = revisions.text.trim().split('\n').filter(Boolean).length;
  check(
    `edits accumulated as revisions (found ${revisionCount})`,
    !revisions.isError && revisionCount >= 2,
    revisions.text,
  );

  section('7. Native Google Doc round-trip');

  const docCreated = await call('create_file', {
    name: DOC_NAME,
    content: '# Heading\n\nOriginal body text.\n\n- first item\n- second item\n',
    convertTo: 'application/vnd.google-apps.document',
  });
  check('create_file can produce a native Google Doc', !docCreated.isError, docCreated.text);

  const docId = docCreated.text.match(/^id:\s*(\S+)$/m)?.[1];
  check('native Doc returns a file ID', Boolean(docId));

  if (docId) {
    createdIds.push(docId);

    const docRead = await call('read_file', { fileId: docId });
    check('native Doc reads back', !docRead.isError, docRead.text);
    check(
      'native Doc is exported as markdown',
      headerValue(docRead.text, 'mimeType')?.includes('text/markdown'),
      headerValue(docRead.text, 'mimeType'),
    );
    check('Doc body survived conversion', bodyOf(docRead.text).includes('Original body text'), bodyOf(docRead.text));

    const docBody = bodyOf(docRead.text);
    check(
      'Doc heading became a real heading, not literal text',
      /^#+\s+Heading/m.test(docBody),
      docBody.includes('\\#')
        ? 'the "#" came back backslash-escaped, which is how Drive exports a literal "#" sitting in a ' +
          'paragraph. That means the upload was imported as plain text rather than markdown, so the ' +
          'Doc contains the characters "# Heading" instead of a heading. Check the upload MIME type ' +
          'in createFile.'
        : JSON.stringify(docBody.slice(0, 120)),
    );

    check(
      'Doc list became a real list, not literal text',
      /^\s*[-*]\s+first item/m.test(docBody),
      docBody.includes('\\-') ? 'the "-" came back escaped, imported as plain text, not markdown' : JSON.stringify(docBody),
    );

    const docEdit = await call('replace_in_file', {
      fileId: docId,
      oldString: 'Original body text',
      newString: 'Edited body text',
    });
    check('native Doc accepts an in-place edit', !docEdit.isError, docEdit.text);

    const docRead2 = await call('read_file', { fileId: docId });
    check('native Doc edit persisted', bodyOf(docRead2.text).includes('Edited body text'), bodyOf(docRead2.text));

    const docMeta = await call('get_file_metadata', { fileId: docId });
    check(
      'native Doc is still a Google Doc after editing',
      JSON.parse(docMeta.text).mimeType === 'application/vnd.google-apps.document',
      JSON.parse(docMeta.text).mimeType,
    );
    check('native Doc ID unchanged', JSON.parse(docMeta.text).id === docId);
  }

  await client.close();
}

// Always runs, so a failed run does not litter the user's Drive.

async function cleanup() {
  if (createdIds.length === 0) return;

  section('Cleanup');
  try {
    const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const drive = google.drive({ version: 'v3', auth });

    for (const id of createdIds) {
      try {
        await drive.files.update({ fileId: id, requestBody: { trashed: true } });
        console.log(`  moved ${id} to the bin`);
      } catch (err) {
        console.log(`  could not bin ${id}: ${err.message}. Delete it manually`);
      }
    }
  } catch (err) {
    console.log(`  cleanup failed: ${err.message}`);
    console.log(`  delete these manually: ${createdIds.join(', ')}`);
  }
}

try {
  await main();
} catch (err) {
  failed += 1;
  failures.push('unhandled error');
  console.error(`\n\x1b[31mUnhandled error:\x1b[0m ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  await cleanup();
}

console.log(`\n${'─'.repeat(56)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ ALL ${passed} CHECKS PASSED\x1b[0m. The server works against live Drive.`);
} else {
  console.log(`\x1b[31m✗ ${failed} of ${passed + failed} checks FAILED\x1b[0m`);
  for (const f of failures) console.log(`    - ${f}`);
}
console.log('');

process.exit(failed === 0 ? 0 : 1);
