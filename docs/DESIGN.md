# Design notes

Background on the decisions that aren't obvious from the code, written for anyone extending or forking this server.

---

## 1. Why in-place writes are worth a dedicated server

The Drive API has supported in-place content updates since v2. `files.update` with a media body replaces a file's bytes, keeps its ID, and appends a revision. Nothing here is clever.

What's missing is exposure. The Drive integrations that ship with most assistant platforms expose `files.get`, `files.list`, `files.create`, and `files.update` limited to metadata (title, parent). The media-body form of `files.update`, the one that changes content, is left out.

The workaround that fills the gap is create-new-and-trash-old, and it is genuinely destructive in ways that aren't visible at the moment you do it:

- File IDs are referenced from outside the file. Links in other documents, browser bookmarks, `parentId` references, and any automation holding the ID all break, pointing at something in the bin.
- Revision history is the safety net for automated editing. An assistant that mangles a document is recoverable if there's a version history and unrecoverable if each "edit" started a fresh file.
- Comments and sharing live on the file object. A new file has neither.

An in-place write can always be undone from version history. A create-and-trash cannot be undone at all once the trash is emptied. So in-place is the safer primitive even before considering the metadata it preserves.

---

## 2. The concurrency model

### The failure it prevents

Read-modify-write over a network, without a guard, has a race:

```
t0  A reads  "Intro. Body."
t1  B (a human, in the Drive UI) appends a paragraph
t2  A writes "Intro. Revised body."      ← B's paragraph is gone
```

Nobody gets an error. The document just quietly loses work. This is more likely with an assistant than with two humans, because the think-time between read and write is long and the assistant has no awareness of the browser tab someone has open.

### The guard

Every read returns an opaque `revisionToken`. Every write optionally accepts one, and refuses if it no longer matches:

```ts
const current = await getMetadata(drive, fileId);
if (expected !== undefined && expected !== current.revisionToken) {
  throw new RevisionConflictError(fileId, expected, current.revisionToken);
}
```

This is optimistic concurrency, done on the client. Drive's `files.update` accepts no precondition, so the token is checked against a separate `files.get` issued immediately before the write. An HTTP `If-Match` / `ETag` exchange is enforced at the server, where the check and the write are one operation. This one is not, so a write that lands between the check and the update is not caught. That window is milliseconds wide. The `expectedMtimeMs` guard in file-sync tools has the same shape and the same limit.

### Why the token is opaque

Drive populates `headRevisionId` only for files with binary content. Google-native Docs, Sheets, and Slides don't have one.

That's precisely the wrong set of files to leave unguarded. Native files are the ones a human is most likely to have open in a browser tab, editing, right now. So the token is a composite:

```
headRevisionId              when Drive provides one
mtime:<RFC3339 modifiedTime>  otherwise
```

Callers treat it as opaque, reading it and handing it back. Making it a string means the fallback can change later without breaking any caller.

`modifiedTime` is millisecond-resolution, so two writes inside the same millisecond could theoretically slip past the fallback guard. I accepted that limitation. The realistic race here is a human against an assistant over tens of seconds. Sub-second machine contention is not the case this guard is built for.

### Why writes are guarded by default in the targeted tools

`replace_in_file`, `append_to_file`, and `prepend_to_file` do their own read and pass the token through internally. The caller never sees it, and there is no way to opt out. Those tools are the common path, so the safe behaviour is the one that requires no thought.

`update_file_content` takes the token as an optional parameter, because a caller who genuinely wants to overwrite a document wholesale (restoring a backup, say) shouldn't have to read it first. Omitting the guard there is an explicit choice.

---

## 3. Why `replace_in_file` matches literally

`replace_in_file` matches literally, via `split`/`join`.

Two failure modes motivate this:

1. Metacharacters in copied text. A model that copies `price is $1.00` out of a document and passes it as a regex gets `.` as a wildcard and `$1` as a group reference. Literal matching means what you copied is what gets matched.
2. `$&` and friends in the replacement. `String.replace` expands `$&`, `` $` ``, `$'`, and `$1` in the replacement string, so replacement text containing a literal `$&` gets silently mangled. `split`/`join` doesn't interpret anything. There's a test for exactly this.

An ambiguous match raises an error, because a wrong-occurrence edit is silent. The caller is told the occurrence count and asked either to add context or to pass `replaceAll`, both of which are deliberate acts.

---

## 4. Text versus binary

`isTextual()` gates whether downloaded bytes are decoded to a string. A false positive here is the worst bug this server could have. Decode a PNG as UTF-8, write it back, and the file is destroyed with no error anywhere.

So the classifier is an allow-list, `text/*` plus a fixed set of textual `application/*` types. An unrecognised type is treated as binary and base64-encoded, which is the failure-safe direction. Writing binary content back is not supported at all: the write tools refuse a binary file instead of uploading text over its bytes. The worst case is an edit you have to make outside Drive and re-upload.

---

## 5. Native file round-tripping

Native files are exported on read and converted on write:

| Type | Export (read) | Import (write) |
|---|---|---|
| Docs | `text/markdown` | `text/markdown` |
| Sheets | `text/csv` | `text/csv` |
| Slides | `text/plain` | refused |
| Any other `vnd.google-apps` type | `text/plain` | refused |

Docs export to markdown so the round trip is closer to lossless. Headings, lists, and emphasis survive as markup, where a plain-text export would flatten them into undifferentiated text and write them back as a document with no structure.

The upload MIME type is what decides whether conversion happens at all. This is the one place the API is genuinely easy to get wrong, and it fails silently. Uploading `text/plain` while setting `requestBody.mimeType` to `application/vnd.google-apps.document` does produce a Google Doc, one containing the literal characters `# Heading` as paragraph text. No error, no warning. The conversion just degrades.

The tell on the way back out is a backslash escape. Export a Doc whose paragraph text happens to start with `#` and Drive returns `\# Heading`, escaping the character so it won't be misread as markup. So `\#` in exported content means "this was literal text in the document", which in turn means the original import was never parsed as markdown.

Native target names have no file extension, so extension-based MIME guessing is no help. It lands on the `text/plain` fallback, which is exactly the broken case. `createFile` therefore derives the upload type from the `convertTo` target instead, and only falls back to name-guessing when no conversion was requested.

This bug shipped, and `npm run verify` against a live account caught it while the unit suite stayed green, because the mock had no opinion about which MIME type Drive would parse.

The round trip is not fully lossless. Markdown has no representation for comments, suggestions, footnotes, images, or complex tables. Slides are worse. Drive does not accept a plain-text import for a presentation, so a write to a native Slides file cannot succeed.

Writing to a native file is therefore an allow-list of Docs and Sheets. The import table above has only those two, and `importMimeFor` falls back to `text/plain` for everything else, so a Site, a Drawing, a Form or a Jamboard would otherwise reach `files.update` as plain text and be refused by Google in terms that name nothing. `writeFile` refuses each of them by name before the call is made. Slides get their own message, since a deck is the one a caller is most likely to try.

---

## 6. Error messages as an interface

Errors here are written to be read by a model. A raw `409` or a dumped Google error object gives a model nothing to act on. A sentence naming the recovery gives it a next step. Compare:

```
Error: Conflict
```

with what this server returns:

```
Conflict: file 1a2b3c has changed since you read it. You passed
expectedRevisionToken="0B1" but the file is now at "0B2". Someone else (a person
in the Drive UI, or another process) wrote to it in between. Re-read the file,
re-apply your change to the new content, and write again. This server has no
force or override option.
```

The second recovers on its own. The same reasoning shapes the 401/403/404 messages in `errors.ts`, which name the specific misconfiguration (wrong scope, wrong account, ID-versus-name confusion).

Tool descriptions follow the same principle. Each one says when to reach for it over its neighbours, because a model that can't tell `replace_in_file` from `update_file_content` will pick the destructive one and overwrite documents it meant to edit.

---

## 7. Why OAuth rather than a service account

A service account has its own Drive and cannot see a person's "My Drive" without domain-wide delegation, a Workspace-admin feature most individuals don't have. Files could be shared to the service account one by one, but the tool would then only ever reach files someone had remembered to share.

An OAuth refresh token acts as the user, which is what "edit my documents" means. The cost is the full `drive` scope, since `drive.file` only covers files the app itself created and is useless for editing existing documents. That trade-off is stated in the README, along with the mitigations: a dedicated account, Testing-mode consent screen, and one-click revocation.

---

## 8. stdout is the transport

The server speaks MCP over stdio, so stdout carries protocol frames and nothing else. A stray `console.log` corrupts the JSON-RPC stream and surfaces as a parse error in the client that looks like a client bug.

All diagnostics go to stderr, including the startup line and fatal errors. Anyone forking this should keep that invariant. Breaking it is the easiest way to break the server.
