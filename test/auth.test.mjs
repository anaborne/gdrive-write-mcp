/**
 * A refresh token carries the scope it was granted with. If the authorize script and the
 * server disagree on scope, the mismatch shows up as a 403 at call time, not at startup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRIVE_FILE_SCOPE,
  DRIVE_SCOPE,
  credentialsFromEnv,
  scopeFromEnv,
} from '../dist/auth.js';

const FULL_ENV = {
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'token',
};

test('credentialsFromEnv reads all three values', () => {
  const creds = credentialsFromEnv(FULL_ENV);
  assert.equal(creds.clientId, 'id.apps.googleusercontent.com');
  assert.equal(creds.clientSecret, 'secret');
  assert.equal(creds.refreshToken, 'token');
});

test('credentialsFromEnv trims surrounding whitespace', () => {
  const creds = credentialsFromEnv({ ...FULL_ENV, GOOGLE_CLIENT_ID: '  id  ' });
  assert.equal(creds.clientId, 'id');
});

test('credentialsFromEnv names every missing variable in one error', () => {
  assert.throws(() => credentialsFromEnv({ GOOGLE_CLIENT_ID: 'id' }), (err) => {
    assert.equal(err.code, 'CONFIG_ERROR');
    assert.match(err.message, /GOOGLE_CLIENT_SECRET/);
    assert.match(err.message, /GOOGLE_REFRESH_TOKEN/);
    return true;
  });
});

test('credentialsFromEnv treats an empty string as missing', () => {
  assert.throws(() => credentialsFromEnv({ ...FULL_ENV, GOOGLE_REFRESH_TOKEN: '   ' }), {
    code: 'CONFIG_ERROR',
  });
});

test('scopeFromEnv defaults to full Drive access', () => {
  assert.equal(scopeFromEnv({}), DRIVE_SCOPE);
  assert.equal(scopeFromEnv({ GOOGLE_OAUTH_SCOPE: '' }), DRIVE_SCOPE);
});

test('scopeFromEnv accepts the short forms', () => {
  assert.equal(scopeFromEnv({ GOOGLE_OAUTH_SCOPE: 'drive' }), DRIVE_SCOPE);
  assert.equal(scopeFromEnv({ GOOGLE_OAUTH_SCOPE: 'drive.file' }), DRIVE_FILE_SCOPE);
});

test('scopeFromEnv passes a full URL through unchanged', () => {
  const readonly = 'https://www.googleapis.com/auth/drive.readonly';
  assert.equal(scopeFromEnv({ GOOGLE_OAUTH_SCOPE: readonly }), readonly);
});

test('the two scope constants are distinct and correctly formed', () => {
  assert.notEqual(DRIVE_SCOPE, DRIVE_FILE_SCOPE);
  assert.ok(DRIVE_SCOPE.startsWith('https://www.googleapis.com/auth/'));
  assert.ok(DRIVE_FILE_SCOPE.endsWith('/drive.file'));
});
