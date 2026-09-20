# iPhone capture handoff

This is the version 1 integration contract implemented in this branch. The QR service is deployed on Srinivas's personal development backend at `https://utmost-cow-946.convex.site`. Use this origin in the native app's development allowlist. The browser importer and the iPhone exporter can be developed independently against this document.

## Native app responsibilities

The native app keeps the JSON export/share workflow and provides an in-app **Connect to Rumi** QR scanner and a **Send to Rumi** action for a completed detailed scan. It uploads the original ZIP with layout, mesh, photos, depth, and confidence. **Send layout only** is an explicit fallback when detailed capture is unavailable. Use Apple's camera APIs for QR recognition; a universal link or App Store release is not required. Never send an unfinished capture.

The web app creates a capture session belonging to its authenticated user and displays this JSON as the QR payload:

```json
{
  "type": "rumi.capture",
  "version": 1,
  "baseUrl": "https://<deployment>.convex.site",
  "sessionId": "<opaque-session-id>",
  "pairingToken": "<random-single-use-secret>",
  "expiresAt": "2026-09-19T20:10:00.000Z"
}
```

Reject unknown versions, expired payloads, invalid fields, and non-HTTPS URLs. Accept only a configured allowlist of Rumi backend origins. Do not trust an arbitrary endpoint simply because it appears in a QR code. Never log the QR text or tokens. Display the destination before connecting.

### Claim the session

`POST {baseUrl}/capture/v1/claim`

Headers: `Authorization: Bearer <pairingToken>`, `Content-Type: application/json`.

```json
{ "sessionId": "<opaque-session-id>", "claimId": "<client-generated-UUID>" }
```

The server atomically consumes the pairing token. The same token and claim ID can retry the original claim while it remains valid; another claim ID receives `409`. Successful response:

```json
{
  "sessionId": "<opaque-session-id>",
  "uploadToken": "<session-scoped-secret>",
  "expiresAt": "2026-09-19T21:00:00.000Z",
  "maxBytes": 10485760,
  "maxScanBytes": 134217728
}
```

The pairing token expires after 10 minutes. The upload token expires 60 minutes after pairing, permits one room upload, and grants no room reads or unrelated writes. Server time is authoritative. Keep upload credentials in memory; reconnect if the app restarts.

### Send layout only, legacy endpoint

New phones use the complete-scan flow below by default. This endpoint remains for older phones and the explicit layout-only fallback.

`POST {baseUrl}/capture/v1/room?sessionId=<URL-encoded-session-id>`

Headers:

- `Authorization: Bearer <uploadToken>`
- `Content-Type: application/json`
- `Idempotency-Key: <client-generated-UUID>`

Body: the exact bytes of `JSONEncoder().encode(finalCapturedRoom)`. No envelope, field filtering, coordinate conversion, or photos embedded in the JSON. Use the same bytes and idempotency key for retries; do not re-encode on retry. Enforce the returned size limit before sending.

Successful response, including an identical retry:

```json
{ "sessionId": "<opaque-session-id>", "status": "uploaded" }
```

An accepted upload means the file was received and validated, not that furniture fit or scan accuracy is verified. The browser reacts to the session change, imports the file, and presents the room for review. Keep the local scan available after upload.

### Errors

Errors have the shape `{ "error": { "code": "TOKEN_EXPIRED", "message": "Reconnect to Rumi and try again." } }`.

| HTTP      | Meaning                                                | Native behavior                                 |
| --------- | ------------------------------------------------------ | ----------------------------------------------- |
| 400       | Invalid request or unsupported protocol                | Show the error; retain the scan                 |
| 401 / 403 | Invalid credentials or disallowed session              | Reconnect                                       |
| 409       | Session claimed or a different upload already accepted | Start a new pairing session                     |
| 410       | Expired or canceled session                            | Reconnect                                       |
| 413       | File exceeds the returned limit                        | Offer file export                               |
| 422       | Invalid or unsupported RoomPlan data                   | Show error and offer file export                |
| 429 / 5xx | Temporary failure                                      | Bounded retries with backoff; honor Retry-After |

Only retry network failures, 429, and 5xx automatically. A user cancel must stop retries. Never discard the completed room on an upload error.

## Web and backend responsibilities

- Session creation, subscription, cancellation, and retrieval of the file URL require the authenticated owner's identity. The session ID alone grants no access. The storage download URL is a bearer link; never log or share it.
- Store raw JSON in Convex file storage; store its storage ID and bounded metadata in the capture-session table. Avoid putting room files into table documents.
- Limit file size while reading, validate the supported RoomPlan structure, and enforce expiration on the server. Reject malformed geometry.
- Use transactional claim/completion operations and payload digests to prevent two claims or retries from replacing an accepted scan. Clean up orphaned uploads and expired sessions.
- Keep tokens out of logs and client-visible session query results. Store credential verifiers rather than bearer secrets, with an explicit secure approach for retrying claim responses.
- Allow at most five sessions per owner per ten minutes and twenty upload attempts per session. A claim is single-use except for retries with the same claim ID. Revoke credentials when canceling waiting or paired sessions. Cancellation after upload is a no-op so closing the web dialog cannot delete an accepted room before import. Delete session records and stored capture files 24 hours after session creation.
- Show waiting for phone, paired, loading the accepted upload, import success/failure, and unavailable/expired states. Do not present an inactive QR service as connected.

Authentication configuration and deployment ownership must be established before exposing these endpoints. Do not deploy a public anonymous session-creation endpoint as a shortcut.

## Implementation and rollout

The native implementation is in `ios/RumiCapture/CaptureClient.swift`, `CaptureConnection.swift`, and `PairingScreen.swift`. A confirmed claim closes the QR camera before starting a new room scan. Completed/restored scans can pair and send without rescanning. The web QR includes a quiet border and instructions matching these controls.

Sync the updated `convex/captures.ts` to the owner's deployment before testing the close/upload race fix. No schema migration is required. Install the updated iPhone app through Xcode. Fedora checks cover TypeScript and backend behavior; the updated native app still requires Xcode tests and a physical device handoff. See [the native checklist](../ios/README.md#physical-device-checklist).

## Testing the handoff

Native development can use a mocked transport conforming to this contract, explicitly labeled as a simulation. Keep real JSON export available. End-to-end verification requires a deployed backend, an authenticated browser session, and a physical phone. Exercise expired QR codes, simultaneous claims, canceled sessions, interrupted uploads, idempotent retries, and unauthorized file access.

## Complete scan transfer

The claim response advertises `maxScanBytes: 134217728` alongside the legacy JSON limit. Older phones ignore the added field and keep using `/capture/v1/room`. A new phone refuses to silently downgrade a complete scan if the server lacks this capability.

1. The phone hashes its saved ZIP on a background task and retains its file URL and UUID idempotency key. It sends `POST /capture/v1/scan/start` with the upload bearer token and JSON `{ sessionId, idempotencyKey, digest, size }`. `digest` is the Base64 SHA-256 of the exact ZIP bytes. The maximum is 128 MiB.
2. The server reserves those immutable values and returns `{ uploaded, uploadUrl, storageId, contentType }`. An accepted retry returns `uploaded: true`. An attached but unfinished file returns `storageId` so the phone can resume validation. Otherwise the phone posts the file directly to the returned Convex storage URL using the returned `contentType`, `application/zip; rumi-session=<sessionId>`. The non-secret MIME parameter lets expiry cleanup find uploads even if their storage-ID response is lost. It uses a disk upload with progress, refuses redirects, and only accepts the paired deployment's `.convex.cloud` storage-upload path. The bearer token is never sent to that URL.
3. The phone retains the storage response's `storageId` and sends `POST /capture/v1/scan/complete` with the upload bearer token and JSON `{ sessionId, idempotencyKey, storageId }`. The server checks expiration, reserved digest and size, creation time, and exclusive file association before reading the file. An internal Node action validates the whole package with the same validator as the browser. Only valid packages become `uploaded`.
4. The authenticated browser subscription includes `format: "zip"` and the file URL. The browser downloads with size limits and progress, awaits the existing import worker, saves the original ZIP in IndexedDB, and opens captured surfaces. Import errors remain retryable; a download alone is not reported as success. JSON transfers retain `format: "json"`.

Control requests retry network failures, 429, and 5xx up to three attempts. A disk-upload failure retains the file and key for a manual retry. Retrying confirmation after a successful storage response does not upload the file again. The complete operation rechecks cancellation and expiration before committing. There are at most twenty upload URL requests and twenty validation attempts per session. Registered unfinished files, accepted files, and tagged uploads whose response was lost expire after 24 hours. Cleanup scans storage metadata within the session’s possible upload window in bounded pages and deletes only files carrying that session’s tag, plus its explicitly registered files.

### Rollout and verification

Deploy the updated schema, `captures.ts`, `capturePackages.ts`, and `http.ts` together on the owner's development deployment, then ship the web frontend and install the updated iPhone app. All new table fields are optional; existing sessions remain valid and old phone JSON transfers remain supported. These changes have not been deployed by this task.

Local verification covers authenticated ZIP completion, unchanged source bytes, confirmation retries, content substitution, invalid packages, cancellation, expiration, legacy JSON, and bounded browser download. Browser verification uses a clearly labeled synthetic phone handoff through the real download/import functions, then reload, furniture edit, and ZIP download. The Swift transport tests cover disk upload, storage-origin validation, and confirmation retries, but require Xcode to execute. A physical phone transfer against the updated backend remains required.
