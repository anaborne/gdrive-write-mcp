/**
 * The description strings below are prompt surface, not documentation. A model that
 * cannot tell replace_in_file from update_file_content reaches for the destructive one
 * and overwrites a document it meant to edit, so each says when to prefer its neighbour.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { drive_v3 } from 'googleapis';

import { applyAppend, applyPrepend, applyReplace, summarizeChange } from './edits.js';
import { createFile, getMetadata, listRevisions, readFile, searchFiles, writeFile } from './drive.js';
import { describeError, ToolError } from './errors.js';
import { isGoogleNative } from './mime.js';

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): TextResult {
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown): TextResult {
  return { content: [{ type: 'text', text: describeError(err) }], isError: true };
}

/** A tool that throws hands the model a protocol error it cannot reason about. isError
 * plus a sentence about what to do next is recoverable. */
async function guard(fn: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ToolError) return fail(err);
    return fail(err);
  }
}

export function registerTools(server: McpServer, drive: drive_v3.Drive): void {
  server.registerTool(
    'read_file',
    {
      title: 'Read a Drive file',
      description:
        'Read the content of a Google Drive file by ID. Returns the text along with a revisionToken. ' +
        'ALWAYS read before writing: the revisionToken you get back is what you pass to a write tool ' +
        'to prove you are editing the version you actually saw. Google Docs, Sheets, and Slides are ' +
        'exported to markdown, CSV, and plain text respectively. Binary files come back base64-encoded.',
      inputSchema: {
        fileId: z
          .string()
          .describe('Drive file ID, the long string in the file URL after /d/, not the file name.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fileId }) =>
      guard(async () => {
        const result = await readFile(drive, fileId);
        const meta = result.metadata;

        const header = [
          `file: ${meta.name}`,
          `id: ${meta.id}`,
          `mimeType: ${meta.mimeType}${result.readAs !== meta.mimeType ? ` (exported as ${result.readAs})` : ''}`,
          `revisionToken: ${meta.revisionToken}`,
          `modifiedTime: ${meta.modifiedTime}`,
          meta.trashed ? 'trashed: true, this file is in the bin' : null,
        ]
          .filter(Boolean)
          .join('\n');

        const body =
          result.content !== undefined
            ? result.content
            : `[binary file, ${meta.size ?? 0} bytes, base64]\n${result.base64Content}`;

        return ok(`${header}\n---\n${body}`);
      }),
  );

  server.registerTool(
    'get_file_metadata',
    {
      title: 'Get Drive file metadata',
      description:
        'Fetch a file’s name, MIME type, size, modified time, and current revisionToken without ' +
        'downloading its content. Use this to check whether a file has changed since you last read it.',
      inputSchema: { fileId: z.string().describe('Drive file ID.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fileId }) =>
      guard(async () => ok(JSON.stringify(await getMetadata(drive, fileId), null, 2))),
  );

  server.registerTool(
    'search_files',
    {
      title: 'Search Drive files',
      description:
        'Find files using Google Drive query syntax, e.g. "name contains \'budget\'", ' +
        '"fullText contains \'quarterly\'", "\'FOLDER_ID\' in parents", or ' +
        '"mimeType = \'application/vnd.google-apps.document\'". Combine clauses with and/or. ' +
        'Use this to turn a file name into the file ID the write tools need.',
      inputSchema: {
        query: z.string().describe('A Google Drive search query.'),
        pageSize: z.number().int().min(1).max(100).optional().describe('Max results (default 20).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, pageSize }) =>
      guard(async () => {
        const results = await searchFiles(drive, query, pageSize ?? 20);
        if (results.length === 0) {
          return ok(`No files matched: ${query}`);
        }
        return ok(results.map((r) => `${r.id}  ${r.name}  (${r.mimeType}, modified ${r.modifiedTime})`).join('\n'));
      }),
  );

  server.registerTool(
    'list_revisions',
    {
      title: 'List file revisions',
      description:
        'Show the revision history Drive has kept for a file, newest first. Useful for confirming ' +
        'that an in-place edit landed, or for finding the version to roll back to.',
      inputSchema: {
        fileId: z.string().describe('Drive file ID.'),
        pageSize: z.number().int().min(1).max(100).optional().describe('Max revisions (default 20).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fileId, pageSize }) =>
      guard(async () => {
        const revisions = await listRevisions(drive, fileId, pageSize ?? 20);
        if (revisions.length === 0) return ok('No revisions recorded for this file.');
        return ok(
          revisions
            .map((r) => `${r.id}  ${r.modifiedTime}${r.lastModifyingUser ? `  by ${r.lastModifyingUser}` : ''}`)
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'update_file_content',
    {
      title: 'Replace a Drive file’s content',
      description:
        'Overwrite a file’s entire content IN PLACE, keeping its ID, sharing settings, comments, and ' +
        'location, and recording a new revision. This is destructive: everything currently in the file ' +
        'is replaced. Prefer replace_in_file or append_to_file for targeted changes, and reach for ' +
        'this only when you are genuinely rewriting the whole document. ' +
        'Pass expectedRevisionToken from your most recent read so a concurrent edit by someone else ' +
        'is refused rather than silently overwritten.',
      inputSchema: {
        fileId: z.string().describe('Drive file ID.'),
        content: z.string().describe('The complete new content of the file.'),
        expectedRevisionToken: z
          .string()
          .optional()
          .describe(
            'The revisionToken from your last read. Strongly recommended: without it, this call will ' +
              'overwrite whatever is there now, including changes made since you read the file.',
          ),
      },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ fileId, content, expectedRevisionToken }) =>
      guard(async () => {
        const before = await readFile(drive, fileId);
        const meta = await writeFile(drive, fileId, content, { expectedRevisionToken });
        return ok(
          `Updated ${meta.name} in place.\n` +
            `${summarizeChange(before.content ?? '', content)}\n` +
            `revisionToken: ${meta.revisionToken}`,
        );
      }),
  );

  server.registerTool(
    'replace_in_file',
    {
      title: 'Find and replace in a Drive file',
      description:
        'Make a targeted edit: replace an exact string with another, in place. This is the tool to ' +
        'use for most edits, since it does not require sending the whole document back and cannot ' +
        'accidentally drop content you did not mention. ' +
        'Matching is literal, not regex. If the string appears more than once the call fails rather ' +
        'than guessing, so include surrounding context to disambiguate, or pass replaceAll. ' +
        'The read and the write happen inside this one call, so no separate revisionToken is needed.',
      inputSchema: {
        fileId: z.string().describe('Drive file ID.'),
        oldString: z.string().describe('Exact text to find, including whitespace and line breaks.'),
        newString: z.string().describe('Text to replace it with. Use an empty string to delete.'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace every occurrence instead of failing on multiple matches. Default false.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ fileId, oldString, newString, replaceAll }) =>
      guard(async () => {
        const before = await readFile(drive, fileId);
        if (before.content === undefined) {
          throw new ToolError(
            `Cannot do a text replacement on ${before.metadata.name}: it is a binary file ` +
              `(${before.metadata.mimeType}). Use update_file_content with base64 instead.`,
            'NOT_TEXT',
          );
        }

        const { content: after, replacements } = applyReplace(
          before.content,
          oldString,
          newString,
          replaceAll ?? false,
          fileId,
        );

        const meta = await writeFile(drive, fileId, after, {
          expectedRevisionToken: before.metadata.revisionToken,
        });

        return ok(
          `Replaced ${replacements} occurrence${replacements === 1 ? '' : 's'} in ${meta.name}.\n` +
            `${summarizeChange(before.content, after)}\n` +
            `revisionToken: ${meta.revisionToken}`,
        );
      }),
  );

  server.registerTool(
    'append_to_file',
    {
      title: 'Append to a Drive file',
      description:
        'Add text to the end of a file in place, without resending the existing content. Ideal for ' +
        'running logs, journals, and changelogs. A newline is inserted between old and new content ' +
        'unless the file already ends with one, so repeated appends stay cleanly separated.',
      inputSchema: {
        fileId: z.string().describe('Drive file ID.'),
        text: z.string().describe('Text to add at the end.'),
        separator: z
          .string()
          .optional()
          .describe('Explicit separator between existing content and the new text. Default: a newline if needed.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ fileId, text, separator }) =>
      guard(async () => {
        const before = await readFile(drive, fileId);
        if (before.content === undefined) {
          throw new ToolError(
            `Cannot append to ${before.metadata.name}: it is a binary file (${before.metadata.mimeType}).`,
            'NOT_TEXT',
          );
        }

        const after = applyAppend(before.content, text, separator);
        const meta = await writeFile(drive, fileId, after, {
          expectedRevisionToken: before.metadata.revisionToken,
        });

        return ok(`Appended to ${meta.name}.\n${summarizeChange(before.content, after)}\nrevisionToken: ${meta.revisionToken}`);
      }),
  );

  server.registerTool(
    'prepend_to_file',
    {
      title: 'Prepend to a Drive file',
      description:
        'Add text to the beginning of a file in place. Useful for reverse-chronological notes where ' +
        'the newest entry belongs at the top.',
      inputSchema: {
        fileId: z.string().describe('Drive file ID.'),
        text: z.string().describe('Text to add at the beginning.'),
        separator: z.string().optional().describe('Explicit separator. Default: a newline if needed.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ fileId, text, separator }) =>
      guard(async () => {
        const before = await readFile(drive, fileId);
        if (before.content === undefined) {
          throw new ToolError(
            `Cannot prepend to ${before.metadata.name}: it is a binary file (${before.metadata.mimeType}).`,
            'NOT_TEXT',
          );
        }

        const after = applyPrepend(before.content, text, separator);
        const meta = await writeFile(drive, fileId, after, {
          expectedRevisionToken: before.metadata.revisionToken,
        });

        return ok(`Prepended to ${meta.name}.\n${summarizeChange(before.content, after)}\nrevisionToken: ${meta.revisionToken}`);
      }),
  );

  server.registerTool(
    'create_file',
    {
      title: 'Create a Drive file',
      description:
        'Create a new file with the given content. Only for genuinely new documents. To change an ' +
        'existing file, use one of the in-place edit tools so its ID and history survive. ' +
        'Set convertTo to application/vnd.google-apps.document to upload markdown as a real Google Doc.',
      inputSchema: {
        name: z.string().describe('File name, including extension.'),
        content: z.string().describe('Initial content.'),
        parentId: z.string().optional().describe('Folder ID to create it in. Defaults to My Drive root.'),
        mimeType: z.string().optional().describe('MIME type of the content. Guessed from the name if omitted.'),
        convertTo: z
          .string()
          .optional()
          .describe(
            'Convert to a native Google type on upload, e.g. application/vnd.google-apps.document. ' +
              'Markdown content becomes real headings and lists. Leave mimeType unset when using this, ' +
              'since it is chosen automatically to make the conversion work.',
          ),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, content, parentId, mimeType, convertTo }) =>
      guard(async () => {
        const meta = await createFile(drive, { name, content, parentId, mimeType, convertTo });
        return ok(
          `Created ${meta.name}\nid: ${meta.id}\nmimeType: ${meta.mimeType}` +
            `${meta.webViewLink ? `\nlink: ${meta.webViewLink}` : ''}` +
            `${isGoogleNative(meta.mimeType) ? '\n(native Google file, edits to it will be exported/imported as text)' : ''}`,
        );
      }),
  );
}
