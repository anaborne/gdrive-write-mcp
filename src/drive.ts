import type { drive_v3 } from 'googleapis';
import { RevisionConflictError, ToolError } from './errors.js';
import {
  GOOGLE_DOC,
  GOOGLE_SHEET,
  GOOGLE_SLIDES,
  exportMimeFor,
  guessMimeFromName,
  importMimeFor,
  isGoogleNative,
  isTextual,
} from './mime.js';

const METADATA_FIELDS = 'id, name, mimeType, headRevisionId, modifiedTime, size, trashed, webViewLink, parents';

export interface FileMetadata {
  id: string;
  name: string;
  mimeType: string;
  revisionToken: string;
  modifiedTime: string;
  size?: number;
  trashed: boolean;
  webViewLink?: string;
  parents?: string[];
}

export interface ReadResult {
  metadata: FileMetadata;
  content?: string;
  base64Content?: string;
  readAs: string;
}

export interface WriteOptions {
  /** When set and the file has moved on, the write is refused rather than clobbering
   * whatever landed in between. */
  expectedRevisionToken?: string;
}

/** Last resort when Drive returns neither field. It compares equal to itself, so a
 * guarded write against it is refused in writeFile instead of being let through by two
 * sentinels matching each other. */
export const UNKNOWN_REVISION_TOKEN = 'unknown';

/**
 * Drive exposes headRevisionId only for files with real binary content. Native editor
 * files have none, and those are the ones a human has open in a browser tab, so the
 * token falls back to modifiedTime rather than leaving them unguarded.
 */
export function revisionToken(file: drive_v3.Schema$File): string {
  if (file.headRevisionId) return file.headRevisionId;
  if (file.modifiedTime) return `mtime:${file.modifiedTime}`;
  return UNKNOWN_REVISION_TOKEN;
}

function toMetadata(file: drive_v3.Schema$File): FileMetadata {
  return {
    id: file.id ?? '',
    name: file.name ?? '',
    mimeType: file.mimeType ?? 'application/octet-stream',
    revisionToken: revisionToken(file),
    modifiedTime: file.modifiedTime ?? '',
    size: file.size != null ? Number(file.size) : undefined,
    trashed: file.trashed ?? false,
    webViewLink: file.webViewLink ?? undefined,
    parents: file.parents ?? undefined,
  };
}

export async function getMetadata(drive: drive_v3.Drive, fileId: string): Promise<FileMetadata> {
  const res = await drive.files.get({
    fileId,
    fields: METADATA_FIELDS,
    supportsAllDrives: true,
  });
  return toMetadata(res.data);
}

/** Binary files come back base64 so a read/write round trip cannot corrupt them. */
export async function readFile(drive: drive_v3.Drive, fileId: string): Promise<ReadResult> {
  const metadata = await getMetadata(drive, fileId);

  if (isGoogleNative(metadata.mimeType)) {
    const exportMime = exportMimeFor(metadata.mimeType);
    const res = await drive.files.export(
      { fileId, mimeType: exportMime },
      { responseType: 'arraybuffer' },
    );
    const buffer = Buffer.from(res.data as ArrayBuffer);
    return { metadata, content: buffer.toString('utf8'), readAs: exportMime };
  }

  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  const buffer = Buffer.from(res.data as ArrayBuffer);

  if (isTextual(metadata.mimeType)) {
    return { metadata, content: buffer.toString('utf8'), readAs: metadata.mimeType };
  }
  return { metadata, base64Content: buffer.toString('base64'), readAs: metadata.mimeType };
}

/** An allow-list, because importMimeFor's fallback is text/plain and Drive takes that for
 * a Doc or a Sheet only. A Site, a Drawing, a Form or a Jamboard would reach files.update
 * as plain text and be refused there, so they are refused here by name instead. */
const WRITABLE_NATIVE_TYPES = new Set([GOOGLE_DOC, GOOGLE_SHEET]);

/** In place: the file ID, sharing settings and location survive, and the previous
 * content stays in File > Version history. */
export async function writeFile(
  drive: drive_v3.Drive,
  fileId: string,
  body: string | Buffer,
  options: WriteOptions = {},
): Promise<FileMetadata> {
  const current = await getMetadata(drive, fileId);

  // Ahead of the revision check: a refusal no retry can clear has to be the one the caller
  // sees, or a stale token on a Slides deck sends it round a loop that ends here anyway.
  if (isGoogleNative(current.mimeType) && !WRITABLE_NATIVE_TYPES.has(current.mimeType)) {
    if (current.mimeType === GOOGLE_SLIDES) {
      throw new ToolError(
        `Cannot write to ${current.name}: it is a Google Slides presentation. Drive does not accept a ` +
          `plain-text import for a presentation, so this write cannot succeed. ` +
          `Slides are read-only through this server. Edit the deck in Google Slides.`,
        'SLIDES_READ_ONLY',
      );
    }

    throw new ToolError(
      `Cannot write to ${current.name}: it is a native Google file of type ${current.mimeType}. ` +
        `Only Docs and Sheets have a text format Drive converts back on upload, so every other ` +
        `native type is read-only through this server. Edit it in its own Google editor.`,
      'NATIVE_TYPE_READ_ONLY',
    );
  }

  if (options.expectedRevisionToken !== undefined) {
    if (current.revisionToken === UNKNOWN_REVISION_TOKEN) {
      throw new ToolError(
        `Cannot check for a concurrent edit on file ${fileId}: Drive returned neither a headRevisionId ` +
          `nor a modifiedTime, so there is no current token to compare yours against. A re-read returns ` +
          `the same two missing fields, so retrying will not change this. This file cannot be guarded: ` +
          `use update_file_content with no expectedRevisionToken if you accept an unguarded write. ` +
          `replace_in_file, append_to_file and prepend_to_file always send a token, so they cannot ` +
          `write this file at all.`,
        'REVISION_UNKNOWN',
      );
    }

    if (options.expectedRevisionToken !== current.revisionToken) {
      throw new RevisionConflictError(fileId, options.expectedRevisionToken, current.revisionToken);
    }
  }

  const uploadMime = isGoogleNative(current.mimeType) ? importMimeFor(current.mimeType) : current.mimeType;

  const res = await drive.files.update({
    fileId,
    media: { mimeType: uploadMime, body },
    fields: METADATA_FIELDS,
    supportsAllDrives: true,
  });

  return toMetadata(res.data);
}

export interface CreateOptions {
  name: string;
  content: string | Buffer;
  mimeType?: string;
  parentId?: string;
  convertTo?: string;
}

export async function createFile(drive: drive_v3.Drive, options: CreateOptions): Promise<FileMetadata> {
  // On a conversion the upload MIME decides whether Drive parses the content or takes
  // it literally: text/plain into a Doc yields a Doc containing "# Heading" as text.
  // Name-based guessing does not help, since native files have no extension.
  const uploadMime =
    options.mimeType ??
    (options.convertTo && isGoogleNative(options.convertTo)
      ? importMimeFor(options.convertTo)
      : guessMimeFromName(options.name));

  const res = await drive.files.create({
    requestBody: {
      name: options.name,
      ...(options.parentId ? { parents: [options.parentId] } : {}),
      ...(options.convertTo ? { mimeType: options.convertTo } : {}),
    },
    media: { mimeType: uploadMime, body: options.content },
    fields: METADATA_FIELDS,
    supportsAllDrives: true,
  });

  return toMetadata(res.data);
}

export interface RevisionSummary {
  id: string;
  modifiedTime: string;
  lastModifyingUser?: string;
  size?: number;
}

const REVISION_API_PAGE_SIZE = 1000; // Drive's documented maximum for revisions.list

/** 50 pages is 50,000 revisions, past anything a real file carries. The cap exists so a
 * server that keeps handing back a nextPageToken cannot spin here forever. */
const MAX_REVISION_PAGES = 50;

export interface RevisionListResult {
  revisions: RevisionSummary[];
  /** True when the walk stopped on the page cap or a repeated token, which means older
   * pages were read and newer revisions were never fetched. */
  truncated: boolean;
}

/** revisions.list offers no ordering parameter, so every page is walked and the result is
 * sorted on modifiedTime before the newest are handed back. Reading one page and stopping
 * would hide the edit that was just made, which is the thing callers ask for. The cost is
 * one API call per 1000 revisions, paid on every call. */
export async function listRevisions(
  drive: drive_v3.Drive,
  fileId: string,
  pageSize = 20,
): Promise<RevisionListResult> {
  const collected: drive_v3.Schema$Revision[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_REVISION_PAGES; page += 1) {
    const res = await drive.revisions.list({
      fileId,
      pageSize: REVISION_API_PAGE_SIZE,
      pageToken,
      fields: 'nextPageToken, revisions(id, modifiedTime, size, lastModifyingUser(displayName))',
    });

    collected.push(...(res.data.revisions ?? []));

    const nextPageToken = res.data.nextPageToken ?? undefined;
    if (nextPageToken === undefined) {
      pageToken = undefined;
      break;
    }
    // A token Drive has already handed out means the same page again, forever.
    if (seenTokens.has(nextPageToken)) {
      truncated = true;
      break;
    }
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  if (pageToken !== undefined) truncated = true;

  const revisions = collected
    .sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''))
    .slice(0, pageSize)
    .map((rev) => ({
      id: rev.id ?? '',
      modifiedTime: rev.modifiedTime ?? '',
      lastModifyingUser: rev.lastModifyingUser?.displayName ?? undefined,
      size: rev.size != null ? Number(rev.size) : undefined,
    }));

  return { revisions, truncated };
}

export interface SearchResult {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
}

/** Here so the server stands alone: every write tool needs a file ID. */
export async function searchFiles(
  drive: drive_v3.Drive,
  query: string,
  pageSize = 20,
): Promise<SearchResult[]> {
  const res = await drive.files.list({
    q: query,
    pageSize,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
    orderBy: 'modifiedTime desc',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return (res.data.files ?? []).map((file) => ({
    id: file.id ?? '',
    name: file.name ?? '',
    mimeType: file.mimeType ?? '',
    modifiedTime: file.modifiedTime ?? '',
    webViewLink: file.webViewLink ?? undefined,
  }));
}
