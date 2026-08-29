/**
 * isTextual is the case that matters. A false positive decodes a binary file to a UTF-8
 * string and writes it back corrupted, silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exportMimeFor,
  guessMimeFromName,
  importMimeFor,
  isGoogleNative,
  isTextual,
  GOOGLE_DOC,
  GOOGLE_SHEET,
  GOOGLE_SLIDES,
} from '../dist/mime.js';

test('isGoogleNative identifies native editor files', () => {
  assert.equal(isGoogleNative(GOOGLE_DOC), true);
  assert.equal(isGoogleNative(GOOGLE_SHEET), true);
  assert.equal(isGoogleNative('application/vnd.google-apps.folder'), true);
  assert.equal(isGoogleNative('text/markdown'), false);
  assert.equal(isGoogleNative('application/pdf'), false);
});

test('native files export to a format that survives a round trip', () => {
  assert.equal(exportMimeFor(GOOGLE_DOC), 'text/markdown');
  assert.equal(exportMimeFor(GOOGLE_SHEET), 'text/csv');
  assert.equal(exportMimeFor(GOOGLE_SLIDES), 'text/plain');
});

test('import mime is the inverse of export for Docs and Sheets', () => {
  assert.equal(importMimeFor(GOOGLE_DOC), exportMimeFor(GOOGLE_DOC));
  assert.equal(importMimeFor(GOOGLE_SHEET), exportMimeFor(GOOGLE_SHEET));
});

test('isTextual accepts text/* and known textual application types', () => {
  assert.equal(isTextual('text/plain'), true);
  assert.equal(isTextual('text/markdown'), true);
  assert.equal(isTextual('application/json'), true);
  assert.equal(isTextual('image/svg+xml'), true);
});

test('isTextual rejects binary types', () => {
  assert.equal(isTextual('application/pdf'), false);
  assert.equal(isTextual('image/png'), false);
  assert.equal(isTextual('application/octet-stream'), false);
  assert.equal(isTextual('application/zip'), false);
});

test('isTextual tolerates charset parameters', () => {
  assert.equal(isTextual('text/plain; charset=utf-8'), true);
  assert.equal(isTextual('application/json; charset=utf-8'), true);
});

test('guessMimeFromName maps common extensions', () => {
  assert.equal(guessMimeFromName('notes.md'), 'text/markdown');
  assert.equal(guessMimeFromName('data.csv'), 'text/csv');
  assert.equal(guessMimeFromName('config.json'), 'application/json');
  assert.equal(guessMimeFromName('resume.tex'), 'application/x-tex');
});

test('guessMimeFromName is case-insensitive and falls back safely', () => {
  assert.equal(guessMimeFromName('NOTES.MD'), 'text/markdown');
  assert.equal(guessMimeFromName('mystery.qqq'), 'text/plain');
  assert.equal(guessMimeFromName('noextension'), 'text/plain');
});

test('guessMimeFromName handles names with no extension without mis-slicing', () => {
  // Regression: name.slice(name.lastIndexOf('.')) returns the last character of an
  // extensionless name, not an empty string, so the old code reached the text/plain
  // fallback for the wrong reason and this test passed while the logic was broken.
  assert.equal(guessMimeFromName('my-google-doc'), 'text/plain');
  assert.equal(guessMimeFromName('verify-doc-1787690954222-6505'), 'text/plain');
  assert.equal(guessMimeFromName('README'), 'text/plain');
  assert.equal(guessMimeFromName(''), 'text/plain');
  assert.equal(guessMimeFromName('trailing.'), 'text/plain');
});

test('a dotted directory-style name still reads its real extension', () => {
  assert.equal(guessMimeFromName('my.notes.backup.md'), 'text/markdown');
});
