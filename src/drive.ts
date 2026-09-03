import type { drive_v3 } from 'googleapis';
import { RevisionConflictError, ToolError } from './errors.js';
import {
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

/** In place: the file ID, sharing settings and location survive, and the previous
 * content stays in File > Version history. */
export async function writeFile(
  drive: drive_v3.Drive,
  fileId: string,
  body: string | Buffer,
  options: WriteOptions = {},
): Promise<FileMetadata> {
  const current = await getMetadata(drive, fileId);

  if (options.expectedRevisionToken !== undefined) {
    if (current.revisionToken === UNKNOWN_REVISION_TOKEN) {
      throw new ToolError(
        `Cannot check for a concurrent edit on file ${fileId}: Drive returned neither a headRevisionId ` +
          `nor a modifiedTime, so there is no current token to compare yours against. Re-read the file ` +
          `and try again. Dropping expectedRevisionToken would write with no guard at all.`,
        'REVISION_UNKNOWN',
      );
    }

    if (options.expectedRevisionToken !== current.revisionToken) {
      throw new RevisionConflictError(fileId, options.expectedRevisionToken, current.revisionToken);
    }
  }

  if (current.mimeType === GOOGLE_SLIDES) {
    throw new ToolError(
      `Cannot write to ${current.name}: it is a Google Slides presentation. Drive has no plain-text ` +
        `import format for a presentation, so this write would come back as a 400 from the API. ` +
        `Slides are read-only through this server. Edit the deck in Google Slides.`,
      'SLIDES_READ_ONLY',
    );
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

/** Drive returns revisions oldest first and offers no ordering parameter, so every page
 * is walked and the list reversed before the newest are handed back. Reading one page and
 * stopping would hide the edit that was just made, which is the thing callers ask for. */
export async function listRevisions(
  drive: drive_v3.Drive,
  fileId: string,
  pageSize = 20,
): Promise<RevisionSummary[]> {
  const collected: drive_v3.Schema$Revision[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.revisions.list({
      fileId,
      pageSize: REVISION_API_PAGE_SIZE,
      pageToken,
      fields: 'nextPageToken, revisions(id, modifiedTime, size, lastModifyingUser(displayName))',
    });

    collected.push(...(res.data.revisions ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return collected
    .reverse()
    .slice(0, pageSize)
    .map((rev) => ({
      id: rev.id ?? '',
      modifiedTime: rev.modifiedTime ?? '',
      lastModifyingUser: rev.lastModifyingUser?.displayName ?? undefined,
      size: rev.size != null ? Number(rev.size) : undefined,
    }));
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
