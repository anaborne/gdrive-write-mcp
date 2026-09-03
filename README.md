# gdrive-write-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants real write access to Google Drive. It does in-place content updates, appends, and find/replace edits that preserve a file's ID, sharing settings, and revision history.

[![CI](https://github.com/anaborne/gdrive-write-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/anaborne/gdrive-write-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## The problem

Most Google Drive integrations for AI assistants are read-plus-create. They can search files, read them, make new ones, and move old ones to the bin. They have no way to change the content of a file that already exists.

Without in-place writes, "edit this document" becomes three steps:

1. Read the file.
2. Create a new file with the corrected content.
3. Trash the old one.

The result has the right text in it. Everything else about the file is wrong:

| | after a real edit | after create-and-trash |
|---|---|---|
| **File ID** | unchanged | new. Every existing link, bookmark, and API reference now points at a trashed file |
| **Revision history** | one more revision | gone. No "restore previous version" |
| **Comments** | preserved on the file object. Anchored comments may be orphaned by a full-content rewrite | gone |
| **Sharing** | preserved | reset. Collaborators silently lose access |
| **Bin** | untouched | fills with orphaned near-duplicates |

`gdrive-write-mcp` fills that gap. Google's Drive API has always supported in-place content updates. This is a small, focused server that exposes them over MCP.

---

## What it does

### Editing

- `replace_in_file`. Exact-match find and replace. The tool to reach for by default, since it does not require resending the whole document and cannot accidentally drop content that was never mentioned.
- `append_to_file` / `prepend_to_file`. Add to either end, without resending what is already there. Built for logs, journals, and changelogs.
- `update_file_content`. Replace the whole document. Destructive by nature, so it is documented to the model as a last resort.

### Reading

- `read_file`. Content plus the `revisionToken` used to make the next write safe.
- `get_file_metadata`. Check whether a file moved on without downloading it.
- `search_files`. Drive query syntax, so a file name can be turned into the ID the write tools need.
- `list_revisions`. The history that in-place editing preserves.

### Creating

- `create_file`. For genuinely new documents, with optional conversion to a native Google Doc or Sheet.

---

## Two things it gets right

### 1. Concurrent edits are refused, on a best-effort client-side check

The failure mode of a naive write tool is quiet and expensive. You read a document, spend thirty seconds thinking, and write it back over the paragraph a colleague added in the meantime. Nobody gets an error. Nobody notices until the paragraph is missed, days later.

Every read here returns a `revisionToken`, and every write accepts one:

```
read_file(fileId)                    → revisionToken: "0B1a2…"
update_file_content(fileId, content, expectedRevisionToken: "0B1a2…")
```

If the file has changed before the write is issued, the write is refused with an error that tells the model what to do (re-read, re-apply, write again). The targeted tools (`replace_in_file`, `append_to_file`, `prepend_to_file`) read and write inside a single call, so they carry the guard automatically and you never handle a token yourself.

Drive only exposes `headRevisionId` for files with real binary content. Google-native Docs and Sheets do not have one, and those are the files where concurrent human editing is most likely, since they are the ones someone has open in a browser tab. The token falls back to `modifiedTime` there, so native files are guarded too.

### 2. Native Google files are handled honestly

Drive stores two very different kinds of thing, and conflating them is the most common source of bugs in Drive integrations:

- Uploaded files (`text/markdown`, `application/pdf`, …). Bytes in, bytes out.
- Native editor files (`application/vnd.google-apps.document`, …). No bytes of their own. Read by exporting to a concrete format, written by uploading a format Drive converts back on ingest.

This server detects which is which and routes accordingly. Docs export to markdown so that a read-modify-write round trip preserves headings, lists, and emphasis. A plain-text export would silently flatten the document. Binary files come back base64-encoded on read, so a PDF is never mangled by a text tool. Writing binary content back is not supported, and the write tools refuse it.

---

## Install

```bash
git clone https://github.com/anaborne/gdrive-write-mcp.git
cd gdrive-write-mcp
npm install
npm run build
```

Requires Node 18 or newer.

---

## Setup

### Step 1. Create a Google OAuth client

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project (or pick an existing one).
2. Enable the Google Drive API at *APIs & Services → Library → Google Drive API → Enable*.
3. Configure the OAuth consent screen at *APIs & Services → OAuth consent screen*. Choose External, fill in the required fields, and add your own Google account under Test users. While the app is in "Testing", only listed test users can authorize it, which is what you want for a personal tool.
4. Create credentials at *APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app*.
5. Copy the Client ID and Client secret.

### Step 2. Get a refresh token

```bash
cp .env.example .env
# put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env
npm run authorize
```

This prints a one-time Google consent URL for you to open, listens on `http://localhost:4181/oauth2callback` for the redirect, and prints a refresh token. Add it to `.env`:

```env
GOOGLE_CLIENT_ID=1234567890-abcdef.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-…
GOOGLE_REFRESH_TOKEN=1//0g…
```

### Step 3. Point your MCP client at the server

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gdrive-write": {
      "command": "node",
      "args": ["/absolute/path/to/gdrive-write-mcp/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "…",
        "GOOGLE_CLIENT_SECRET": "…",
        "GOOGLE_REFRESH_TOKEN": "…"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add gdrive-write \
  --env GOOGLE_CLIENT_ID=… \
  --env GOOGLE_CLIENT_SECRET=… \
  --env GOOGLE_REFRESH_TOKEN=… \
  -- node /absolute/path/to/gdrive-write-mcp/dist/index.js
```

For anything else, the server speaks MCP over stdio. Launch `node dist/index.js` as a subprocess with those three environment variables set.

### Step 4. Verify it works

```bash
npm run verify
```

This runs a real end-to-end check against your Drive. It launches the server the same way an MCP client would, drives it over stdio with the official MCP client, and asserts the behaviour this project claims, including that a stale write is refused, that a refused write leaves the file untouched, that the file ID is unchanged after every edit, and that a native Google Doc survives a read-edit-read round trip as a Doc.

It creates two temporary files in your Drive and moves them to the bin when it finishes, including when it fails partway. Expect a green summary line:

```
✓ ALL 41 CHECKS PASSED. The server works against live Drive.
```

If anything fails, the output names the specific check and shows what came back. The conflict and native-Doc checks carry extra diagnostics explaining what a given failure implies. A backslash-escaped `#`, for instance, means the content was imported as plain text.

I keep this check because the unit suite was green at 49 tests, and CI passed, while a real defect sat in the code. Creating a native Doc from markdown silently produced a Doc containing the literal characters `# Heading`. Only the live run caught it, because the mock encoded the same wrong assumption as the implementation. Run this after any change to `drive.ts` or `mime.ts`.

---

## Tool reference

### `read_file`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fileId` | string | yes | Drive file ID, the long string in the URL after `/d/` |

Returns content plus `revisionToken`, `mimeType`, and `modifiedTime`. Native files are exported (Docs → markdown, Sheets → CSV, Slides → plain text). Binary files come back base64-encoded.

### `replace_in_file`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fileId` | string | yes | Drive file ID |
| `oldString` | string | yes | Exact text to find, including whitespace and line breaks |
| `newString` | string | yes | Replacement text. An empty string deletes |
| `replaceAll` | boolean | no | Replace every occurrence (default `false`) |

Matching is literal. A `.` or `$1` in your search text means exactly those characters, with no regex interpretation. If `oldString` appears more than once and `replaceAll` is false, the call fails, because a silent wrong-occurrence edit is the kind of bug nobody catches.

### `append_to_file` / `prepend_to_file`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fileId` | string | yes | Drive file ID |
| `text` | string | yes | Text to add |
| `separator` | string | no | Explicit separator (default is a newline, only if one is needed) |

Repeated appends stay evenly separated, with no run-on lines and no widening gaps of blank lines.

### `update_file_content`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fileId` | string | yes | Drive file ID |
| `content` | string | yes | The complete new content |
| `expectedRevisionToken` | string | no | From your last read. Strongly recommended |

Replaces everything. Without `expectedRevisionToken` it will overwrite changes made since you last read the file.

### `create_file`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | File name including extension |
| `content` | string | yes | Initial content |
| `parentId` | string | no | Folder ID (defaults to My Drive root) |
| `mimeType` | string | no | Guessed from the file name if omitted |
| `convertTo` | string | no | e.g. `application/vnd.google-apps.document` to upload markdown as a real Doc |

### `search_files`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | [Drive query syntax](https://developers.google.com/drive/api/guides/search-files) |
| `pageSize` | number | no | Max results, 1 to 100 (default 20) |

```
name contains 'budget'
fullText contains 'quarterly review'
'FOLDER_ID' in parents
mimeType = 'application/vnd.google-apps.document'
```

### `get_file_metadata` / `list_revisions`

Both take `fileId`, and `list_revisions` also takes an optional `pageSize`.

---

## Security

### Why full Drive scope

This server requests `https://www.googleapis.com/auth/drive` by default. The narrower `drive.file` scope only grants access to files the app itself created, which cannot work for a tool whose entire purpose is editing documents you already have. The trade-off is real. The token can read and write everything in the authorized account's Drive.

If your workflow only ever touches files the assistant creates itself, request the narrower scope instead, for both the authorize step and the server:

```env
GOOGLE_OAUTH_SCOPE=drive.file
```

The two must agree. A refresh token carries the scope it was granted with, so minting a token under one and running the server under the other produces confusing `403`s at call time. The server prints a warning to stderr on startup when the per-file scope is active, so a later `404` on someone else's document is not a mystery.

Ways to keep that bounded:

- Authorize a dedicated Google account and share only the specific files or folders you want reachable.
- Keep the OAuth app in Testing mode so only listed test users can authorize it.
- Revoke access any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

### Handling the refresh token

It is a password to your Drive. It never expires on its own. Keep it in `.env` (git-ignored here) or your MCP client's config, never in a committed file. If it leaks, revoke at the link above, which invalidates it immediately.

### No telemetry

This server makes network calls to Google's APIs and nowhere else.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Missing required environment variable…` | The server started without credentials. Check your MCP client passes all three env vars. |
| `Google rejected the credentials (401)` | The refresh token is invalid, revoked, or from a different OAuth client. Re-run `npm run authorize`. |
| `Permission denied (403)` | The account can see the file but not write to it, or the token has a read-only scope. Confirm Editor access and full `drive` scope. |
| `File not found (404)` | Wrong ID, file is trashed, or the authorized account has no access. IDs come from the URL after `/d/`, not the file name. |
| `Conflict: file … has changed` | Working as designed. Someone edited the file after you read it. Re-read, re-apply, write again. |
| `No refresh token` during authorize | The app was already authorized for this account. Revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and retry. |
| `Error 403: access_denied` at the consent screen | A consent configuration problem. See below. |
| Client shows a parse error on startup | Something is writing to stdout. All diagnostics here go to stderr, and a stray `console.log` in a fork will corrupt the protocol stream. |

### `Error 403: access_denied`

Google is refusing the consent screen before any of this code runs. `auth/drive` is a restricted scope, Google's strictest tier, and restricted scopes are blocked unless the app is configured to permit them. In Google Auth Platform, check in this order:

1. Audience → publishing status is "Testing", not "In production". An unverified app in production cannot use restricted scopes at all, for anyone, including its own author. Testing mode allows them for up to 100 listed test users with no verification.
2. Audience → Test users includes the exact account you sign in with.
3. Branding → app name, user support email, and developer contact email are all saved. An incomplete consent screen is an invalid one.

Changes take a few minutes to propagate. If it still fails immediately after an edit, wait five minutes and retry.

To sidestep it entirely, request the non-restricted per-file scope, which is never blocked:

```bash
GOOGLE_OAUTH_SCOPE=drive.file npm run authorize
```

Every file `npm run verify` touches is one it creates itself, so the full verification suite passes under `drive.file`. That is useful for confirming the server works while the consent configuration is still being sorted out. It will not reach documents created elsewhere, so it is a diagnostic path and not a permanent one.

---

## Development

```bash
npm install
npm run build       # compile TypeScript to dist/
npm test            # build, then run the unit suite (no network, no credentials)
npm run verify      # end-to-end check against a real Drive account
npm run typecheck   # type-check without emitting
npm run watch       # rebuild on change
```

`npm test` and `npm run verify` answer different questions. The unit suite mocks the Drive API. It proves the logic is right, runs in CI, and needs no credentials. `npm run verify` proves the integration is right, that Google actually behaves the way this server assumes, particularly around native-file conversion and revision tokens. A change to `drive.ts` or `mime.ts` should be checked with both.

I organised the code so the parts that can silently corrupt a document are testable without touching the network:

```
src/
  index.ts    entry point; stdio transport
  auth.ts     OAuth client from environment
  drive.ts    Drive operations, incl. the concurrency guard
  edits.ts    pure text transforms, no I/O, fully unit-tested
  mime.ts     native vs. binary vs. textual classification
  tools.ts    MCP tool definitions and handlers
  errors.ts   error types written to be actionable by a model
```

The suite covers the find/replace edge cases (regex-looking literals, `$&` in replacements, multi-line targets, ambiguous matches), the append/prepend seam logic, MIME classification, and the concurrency guard, including that a conflicting write never reaches the API. It also pins the refusals that keep a bad write from reaching Drive at all.

---

## Contributing

Issues and pull requests are welcome. For a change of any size, please open an issue first so the approach can be agreed before the work.

If you add a tool, add tests for its pure logic, and write its description for the model that will read it. Say when to reach for it over its neighbours.

---

## License

MIT. See [LICENSE](LICENSE).
