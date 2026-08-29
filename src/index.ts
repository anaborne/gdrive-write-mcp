#!/usr/bin/env node
/**
 * Nothing but MCP protocol messages goes to stdout. stdout is the transport, and one
 * stray console.log corrupts the stream into a parse error that looks like a client bug.
 * Diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { driveFromEnv, warnIfRestrictedScope } from './auth.js';
import { registerTools } from './tools.js';
import { ToolError } from './errors.js';

const NAME = 'gdrive-write-mcp';
const VERSION = '0.1.0';

async function main(): Promise<void> {
  let drive;
  try {
    drive = driveFromEnv();
    warnIfRestrictedScope();
  } catch (err) {
    if (err instanceof ToolError) {
      process.stderr.write(`${NAME}: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const server = new McpServer(
    { name: NAME, version: VERSION },
    {
      instructions:
        'Read, edit, and write Google Drive files in place. Edits preserve the file ID, its sharing ' +
        'settings, and its revision history, so a document can be updated repeatedly without ' +
        'accumulating copies. Read a file before editing it and pass the revisionToken back on write; ' +
        'if the write is refused as a conflict, re-read and merge rather than forcing.',
    },
  );

  registerTools(server, drive);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`${NAME} v${VERSION} ready on stdio\n`);
}

// Non-zero exit, so the client reports a startup failure instead of hanging on a
// half-open transport.
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${NAME}: fatal: ${message}\n`);
  process.exit(1);
});
