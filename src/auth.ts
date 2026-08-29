/**
 * Refresh token rather than service account: a service account has its own empty
 * Drive and cannot reach a person's My Drive without domain-wide delegation, a
 * Workspace-admin feature most individual users do not have.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { drive_v3 } from 'googleapis';
import { ConfigError } from './errors.js';

/** Restricted scope. An unverified app requesting it is blocked at consent unless
 * the project is in Testing mode with the account listed as a test user. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Unrestricted, so consent never blocks it, but it cannot touch a file this app
 * did not create. That rules out the main use case, so it is not the default. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Must match what scripts/authorize.mjs requests. A refresh token carries the scope
 * it was granted with, and a mismatch surfaces as a 403 at call time, not at startup. */
export function scopeFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GOOGLE_OAUTH_SCOPE?.trim();
  if (!raw) return DRIVE_SCOPE;

  if (raw === 'drive') return DRIVE_SCOPE;
  if (raw === 'drive.file') return DRIVE_FILE_SCOPE;
  return raw;
}

/** Loopback redirect the authorize script listens on. */
export const DEFAULT_REDIRECT_URI = 'http://localhost:4181/oauth2callback';

export interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Names the missing variable and refuses to start. A server that starts anyway and
 * fails on every call is much harder to diagnose. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();

  const missing: string[] = [];
  if (!clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!refreshToken) missing.push('GOOGLE_REFRESH_TOKEN');

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        `Set them in your MCP client's server config (or a .env file for local runs). ` +
        `Run \`npm run authorize\` to obtain a refresh token. See the README for the full setup.`,
    );
  }

  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    refreshToken: refreshToken!,
  };
}

/** stderr, never stdout: stdout is the MCP transport. */
export function warnIfRestrictedScope(env: NodeJS.ProcessEnv = process.env): void {
  if (scopeFromEnv(env) === DRIVE_FILE_SCOPE) {
    process.stderr.write(
      'gdrive-write-mcp: using drive.file scope, this token can only reach files ' +
        'created by this app. Files created elsewhere will report 404. ' +
        'Unset GOOGLE_OAUTH_SCOPE and re-authorize for full Drive access.\n',
    );
  }
}

export function createOAuthClient(creds: Credentials, redirectUri = DEFAULT_REDIRECT_URI): OAuth2Client {
  const client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
  client.setCredentials({ refresh_token: creds.refreshToken });
  return client;
}

export function createDriveClient(auth: OAuth2Client): drive_v3.Drive {
  return google.drive({ version: 'v3', auth });
}

export function driveFromEnv(env: NodeJS.ProcessEnv = process.env): drive_v3.Drive {
  return createDriveClient(createOAuthClient(credentialsFromEnv(env)));
}
