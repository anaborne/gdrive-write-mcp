/**
 * A language model reads these, so each message says what the current state is and
 * what to do next. "409 Conflict" gives a model nothing to act on.
 */

export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export class RevisionConflictError extends ToolError {
  constructor(
    readonly fileId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Conflict: file ${fileId} has changed since you read it. ` +
        `You passed expectedRevisionToken="${expected}" but the file is now at "${actual}". ` +
        `Someone else (a person in the Drive UI, or another process) wrote to it in between. ` +
        `Re-read the file, re-apply your change to the new content, and write again. ` +
        `This server has no force or override option.`,
      'REVISION_CONFLICT',
    );
  }
}

export class NoMatchError extends ToolError {
  constructor(fileId: string, needle: string) {
    super(
      `No match: the string to replace was not found in file ${fileId}. ` +
        `Searched for ${JSON.stringify(truncate(needle))}. ` +
        `Read the file first and copy the exact text, including whitespace and line breaks.`,
      'NO_MATCH',
    );
  }
}

export class AmbiguousMatchError extends ToolError {
  constructor(fileId: string, needle: string, count: number) {
    super(
      `Ambiguous: found ${count} occurrences of ${JSON.stringify(truncate(needle))} in file ${fileId}, ` +
        `but replaceAll is false. Either include enough surrounding context to make the match unique, ` +
        `or pass replaceAll: true to replace every occurrence.`,
      'AMBIGUOUS_MATCH',
    );
  }
}

export class ConfigError extends ToolError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Google API errors bury the useful part several levels deep, and the raw object is a
 * wall of JSON that costs tokens and explains nothing. */
export function describeError(err: unknown): string {
  if (err instanceof ToolError) return err.message;

  const anyErr = err as {
    code?: number | string;
    message?: string;
    errors?: Array<{ message?: string; reason?: string }>;
    response?: { data?: { error?: { message?: string; errors?: Array<{ reason?: string }> } } };
  };

  const apiMessage = anyErr?.response?.data?.error?.message ?? anyErr?.errors?.[0]?.message ?? anyErr?.message;
  const reason = anyErr?.response?.data?.error?.errors?.[0]?.reason ?? anyErr?.errors?.[0]?.reason;
  const status = anyErr?.code;

  switch (status) {
    case 401:
      return (
        'Google rejected the credentials (401). The refresh token is invalid, revoked, or was issued ' +
        'for a different OAuth client. Re-run `npm run authorize` to mint a new one.'
      );
    case 403:
      if (reason === 'insufficientFilePermissions' || reason === 'forbidden') {
        return (
          'Permission denied (403). The authorized account can see this file but cannot write to it. ' +
          'Check that the account has Editor access, and that the token was granted the ' +
          'https://www.googleapis.com/auth/drive scope rather than drive.file or a read-only scope.'
        );
      }
      if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
        return 'Rate limited by Google (403). Wait a few seconds and retry; this is transient.';
      }
      return `Google refused the request (403): ${apiMessage ?? 'no detail given'}`;
    case 404:
      return (
        'File not found (404). Either the file ID is wrong, the file is in the trash, or the ' +
        'authorized account has no access to it. File IDs are the long string in the Drive URL ' +
        'after /d/, not the file name.'
      );
    case 429:
      return 'Rate limited by Google (429). Back off and retry.';
    default:
      break;
  }

  if (apiMessage) return `Google Drive API error${status ? ` (${status})` : ''}: ${apiMessage}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
