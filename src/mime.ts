/**
 * Ordinary uploaded files are bytes in, bytes out. Native editor files have no bytes of
 * their own: they are read by exporting to a concrete format and written by uploading
 * one Drive converts back. Conflating the two returns "fileNotDownloadable" from Google,
 * which names nothing.
 */

export const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

export const GOOGLE_DOC = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
export const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';
export const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith(GOOGLE_NATIVE_PREFIX);
}

/**
 * Markdown over text/plain for Docs because it survives the round trip: headings, lists
 * and bold read back as the markup they were written with, so a read-modify-write does
 * not flatten the document.
 */
export function exportMimeFor(mimeType: string): string {
  switch (mimeType) {
    case GOOGLE_DOC:
      return 'text/markdown';
    case GOOGLE_SHEET:
      return 'text/csv';
    case GOOGLE_SLIDES:
      return 'text/plain';
    default:
      return 'text/plain';
  }
}

/** Inverse of exportMimeFor. Drive converts on ingest: markdown into a Doc becomes
 * formatted content, CSV into a Sheet becomes cells. */
export function importMimeFor(mimeType: string): string {
  switch (mimeType) {
    case GOOGLE_DOC:
      return 'text/markdown';
    case GOOGLE_SHEET:
      return 'text/csv';
    default:
      return 'text/plain';
  }
}

/** Anything outside this set goes through base64. A JPEG read as a string and written
 * back is no longer a JPEG. */
export function isTextual(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  return TEXTUAL_APPLICATION_TYPES.has(mimeType.split(';')[0]!.trim());
}

const TEXTUAL_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
  'application/sql',
  'application/graphql',
  'application/x-latex',
  'application/x-tex',
  'image/svg+xml',
]);

/** Only used when creating. Drive accepts application/octet-stream, but a correct type
 * is what makes the file preview in the Drive UI. */
export function guessMimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');

  // Guard explicitly: name.slice(-1) on an extensionless name yields its last
  // character, which reaches the fallback for the wrong reason and hides the bug.
  if (dot === -1 || dot === name.length - 1) return 'text/plain';

  return EXTENSION_MIME[name.slice(dot).toLowerCase()] ?? 'text/plain';
}

const EXTENSION_MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.go': 'text/x-go',
  '.rs': 'text/rust',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.tex': 'application/x-tex',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};
