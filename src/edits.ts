/**
 * No Drive or network dependency. This is where the bugs that silently corrupt a
 * document live, so it stays separately testable.
 */

import { AmbiguousMatchError, NoMatchError } from './errors.js';

export interface ReplaceResult {
  content: string;
  replacements: number;
}

/**
 * Literal, not regex: a model editing a config file should not have to reason about
 * whether a `.` it copied is a metacharacter. Ambiguous single replacements are
 * refused rather than guessed, since nobody notices a wrong-occurrence edit.
 */
export function applyReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  fileIdForErrors: string,
): ReplaceResult {
  if (oldString === '') {
    throw new NoMatchError(fileIdForErrors, oldString);
  }

  const count = countOccurrences(content, oldString);

  if (count === 0) throw new NoMatchError(fileIdForErrors, oldString);
  if (count > 1 && !replaceAll) throw new AmbiguousMatchError(fileIdForErrors, oldString, count);

  if (replaceAll) {
    return { content: content.split(oldString).join(newString), replacements: count };
  }

  const at = content.indexOf(oldString);
  return {
    content: content.slice(0, at) + newString + content.slice(at + oldString.length),
    replacements: 1,
  };
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * The separator goes in only when the existing content does not already end in one,
 * so repeated appends give a clean list instead of a widening gap of blank lines.
 */
export function applyAppend(content: string, text: string, separator?: string): string {
  if (content === '') return text;

  if (separator !== undefined) return content + separator + text;
  return content.endsWith('\n') ? content + text : `${content}\n${text}`;
}

/** Same seam handling as append. */
export function applyPrepend(content: string, text: string, separator?: string): string {
  if (content === '') return text;

  if (separator !== undefined) return text + separator + content;
  return text.endsWith('\n') ? text + content : `${text}\n${content}`;
}

/** Lets a model confirm the edit landed without spending tokens reading the file back. */
export function summarizeChange(before: string, after: string): string {
  const beforeLines = before === '' ? 0 : before.split('\n').length;
  const afterLines = after === '' ? 0 : after.split('\n').length;
  const lineDelta = afterLines - beforeLines;
  const byteDelta = Buffer.byteLength(after, 'utf8') - Buffer.byteLength(before, 'utf8');

  const parts = [`${afterLines} lines`, `${Buffer.byteLength(after, 'utf8')} bytes`];
  const deltas: string[] = [];
  if (lineDelta !== 0) deltas.push(`${lineDelta > 0 ? '+' : ''}${lineDelta} lines`);
  if (byteDelta !== 0) deltas.push(`${byteDelta > 0 ? '+' : ''}${byteDelta} bytes`);

  return deltas.length > 0 ? `${parts.join(', ')} (${deltas.join(', ')})` : `${parts.join(', ')} (unchanged)`;
}
