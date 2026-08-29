/** Runs against dist/, so it exercises the code that ships and not a second transpile. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAppend,
  applyPrepend,
  applyReplace,
  countOccurrences,
  summarizeChange,
} from '../dist/edits.js';

test('countOccurrences counts non-overlapping matches', () => {
  assert.equal(countOccurrences('abcabcabc', 'abc'), 3);
  assert.equal(countOccurrences('aaaa', 'aa'), 2, 'must not double-count overlaps');
  assert.equal(countOccurrences('hello', 'z'), 0);
  assert.equal(countOccurrences('hello', ''), 0, 'empty needle is never a match');
});

test('applyReplace replaces a single unique occurrence', () => {
  const { content, replacements } = applyReplace('the cat sat', 'cat', 'dog', false, 'f1');
  assert.equal(content, 'the dog sat');
  assert.equal(replacements, 1);
});

test('applyReplace refuses an ambiguous single replacement', () => {
  assert.throws(() => applyReplace('cat cat', 'cat', 'dog', false, 'f1'), {
    code: 'AMBIGUOUS_MATCH',
  });
});

test('applyReplace replaces every occurrence when asked', () => {
  const { content, replacements } = applyReplace('cat cat cat', 'cat', 'dog', true, 'f1');
  assert.equal(content, 'dog dog dog');
  assert.equal(replacements, 3);
});

test('applyReplace throws when the target is absent', () => {
  assert.throws(() => applyReplace('hello', 'goodbye', 'x', false, 'f1'), { code: 'NO_MATCH' });
});

test('applyReplace rejects an empty search string', () => {
  assert.throws(() => applyReplace('hello', '', 'x', true, 'f1'), { code: 'NO_MATCH' });
});

test('applyReplace treats the needle literally, not as a regex', () => {
  const { content } = applyReplace('price is $1.00 today', '$1.00', '$2.00', false, 'f1');
  assert.equal(content, 'price is $2.00 today');
});

test('applyReplace does not interpret $& in the replacement', () => {
  // String.replace would expand $& to the matched text; split/join must not.
  const { content } = applyReplace('a-b', '-', '$&', false, 'f1');
  assert.equal(content, 'a$&b');
});

test('applyReplace can delete text', () => {
  const { content } = applyReplace('keep [drop] keep', ' [drop]', '', false, 'f1');
  assert.equal(content, 'keep keep');
});

test('applyReplace handles multi-line targets', () => {
  const before = 'line one\nline two\nline three';
  const { content } = applyReplace(before, 'line two\nline three', 'line 2', false, 'f1');
  assert.equal(content, 'line one\nline 2');
});

test('applyAppend inserts a newline only when one is missing', () => {
  assert.equal(applyAppend('a', 'b'), 'a\nb');
  assert.equal(applyAppend('a\n', 'b'), 'a\nb', 'must not double the newline');
});

test('applyAppend on empty content returns the new text alone', () => {
  assert.equal(applyAppend('', 'first entry'), 'first entry');
});

test('applyAppend honours an explicit separator, including an empty one', () => {
  assert.equal(applyAppend('a', 'b', ''), 'ab');
  assert.equal(applyAppend('a', 'b', '\n\n'), 'a\n\nb');
});

test('repeated appends stay evenly separated', () => {
  let log = '';
  for (const entry of ['one', 'two', 'three']) log = applyAppend(log, entry);
  assert.equal(log, 'one\ntwo\nthree');
});

test('applyPrepend mirrors append at the top of the file', () => {
  assert.equal(applyPrepend('old', 'new'), 'new\nold');
  assert.equal(applyPrepend('old', 'new\n'), 'new\nold');
  assert.equal(applyPrepend('', 'new'), 'new');
  assert.equal(applyPrepend('old', 'new', ''), 'newold');
});

test('summarizeChange reports growth', () => {
  const summary = summarizeChange('a\nb', 'a\nb\nc');
  assert.match(summary, /3 lines/);
  assert.match(summary, /\+1 lines/);
});

test('summarizeChange reports an unchanged write', () => {
  assert.match(summarizeChange('same', 'same'), /unchanged/);
});

test('summarizeChange counts bytes, not characters', () => {
  // "é" is two bytes in UTF-8; a naive length check would report +1.
  assert.match(summarizeChange('e', 'é'), /\+1 bytes/);
});
