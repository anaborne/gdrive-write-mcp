#!/usr/bin/env node
/**
 * Turns an OAuth client ID and secret into the long-lived refresh token the server runs
 * on. Plain JavaScript on purpose: this is the first thing a new user runs, and it should
 * work on any Node 18+ with no build step.
 *
 *   node scripts/authorize.mjs
 *
 * Reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from the environment or a .env beside
 * this repo, then prints the refresh token to paste into your MCP client config.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { google } from 'googleapis';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PORT = 4181;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Mirrors scopeFromEnv() in src/auth.ts, which it has to, because a refresh token carries
 * the scope it was granted with. GOOGLE_OAUTH_SCOPE=drive.file requests the per-file
 * scope, which consent never blocks.
 */
function resolveScope() {
  const raw = process.env.GOOGLE_OAUTH_SCOPE?.trim();
  if (!raw) return DRIVE_SCOPE;
  if (raw === 'drive') return DRIVE_SCOPE;
  if (raw === 'drive.file') return DRIVE_FILE_SCOPE;
  return raw;
}

/** Avoids a dependency for one file read. */
function loadDotEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

loadDotEnv();

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  fail(
    'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.\n' +
      '    Create an OAuth client (type: Desktop app) in Google Cloud Console,\n' +
      '    then put the values in a .env file. See the README for the walkthrough.',
  );
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
const scope = resolveScope();

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: [scope],
  // Google returns a refresh token only on the first consent for a client/user pair.
  // Without this, a second run prints "undefined" and looks broken.
  prompt: 'consent',
});

console.log('\n  gdrive-write-mcp authorization\n');
console.log(`  scope: ${scope}`);
if (scope === DRIVE_FILE_SCOPE) {
  console.log('         (per-file scope. This token can only reach files this app creates)');
}
console.log('\n  1. Open this URL in your browser:\n');
console.log(`     ${authUrl}\n`);
console.log('  2. Approve access. You will be redirected back to localhost.\n');
console.log(`  Waiting for the redirect on ${REDIRECT_URI} …\n`);

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/oauth2callback')) {
    res.writeHead(404).end('Not found');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Authorization failed: ${error}`);
    server.close();

    if (error === 'access_denied') {
      fail(
        'Google refused the authorization (access_denied).\n\n' +
          '    If you did not click "Cancel", this is almost always the OAuth consent\n' +
          '    configuration rather than anything in this code. The auth/drive scope is\n' +
          '    "restricted" in Google\'s terms, and restricted scopes are blocked unless the\n' +
          '    app is set up to allow them. Check, in Google Auth Platform:\n\n' +
          '      1. Audience -> publishing status is "Testing", not "In production".\n' +
          '         An unverified app in production cannot use restricted scopes at all.\n' +
          '      2. Audience -> Test users includes the exact account you signed in with.\n' +
          '      3. Branding -> app name, support email, and developer contact are saved.\n\n' +
          '    Changes take a few minutes to propagate.\n\n' +
          '    Alternatively, request the non-restricted per-file scope, which is never\n' +
          '    blocked but only reaches files this app creates:\n\n' +
          '      GOOGLE_OAUTH_SCOPE=drive.file npm run authorize\n',
      );
      return;
    }

    fail(`Authorization was denied: ${error}`);
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('No authorization code in the callback.');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);

    if (!tokens.refresh_token) {
      res
        .writeHead(200, { 'Content-Type': 'text/plain' })
        .end('Authorized, but Google did not return a refresh token. See the terminal.');
      server.close();
      fail(
        'Google returned no refresh token.\n' +
          '    This happens when the app was already authorized for this account.\n' +
          '    Revoke it at https://myaccount.google.com/permissions and run this again.',
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><meta charset="utf-8">' +
        '<title>Authorized</title>' +
        '<body style="font:16px system-ui;padding:3rem;max-width:34rem">' +
        '<h1 style="font-size:1.25rem">Authorized</h1>' +
        '<p>Your refresh token has been printed in the terminal. You can close this tab.</p>' +
        '</body>',
    );

    console.log('  ✓ Authorized.\n');
    console.log('  Add this to your .env (and to your MCP client config):\n');
    console.log(`  GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log('  Treat it like a password: it grants ongoing access to your Drive.');
    console.log('  Revoke any time at https://myaccount.google.com/permissions\n');

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Token exchange failed. See the terminal.');
    server.close();
    fail(`Token exchange failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(`Port ${PORT} is already in use. Close whatever is using it and try again.`);
  }
  fail(`Could not start the local callback server: ${err.message}`);
});

server.listen(PORT);
