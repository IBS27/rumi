# iPhone capture handoff

This is the version 1 integration contract implemented in this branch. The QR service is deployed on Srinivas's personal development backend at `https://utmost-cow-946.convex.site`. Use this origin in the native app's development allowlist. The browser importer and the iPhone exporter can be developed independently against this document.

## Native app responsibilities

The native app keeps the JSON export/share workflow and provides an in-app **Connect to Rumi** QR scanner and a **Send to Rumi** action for a completed RoomPlan scan. Use Apple's camera APIs for QR recognition; a universal link or App Store release is not required. Never send an unfinished capture.

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
  "maxBytes": 10485760
}
```

The pairing token expires after 10 minutes. The upload token expires 60 minutes after pairing, permits one room upload, and grants no room reads or unrelated writes. Server time is authoritative. Keep upload credentials in memory; reconnect if the app restarts.

### Send the completed room

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

## Detailed scan transfer

New claim responses also include `maxPackageBytes: 134217728`. Old native clients ignore this optional field and continue sending JSON. New native clients keep ZIP export available if the server does not advertise package support. They do not silently replace a detailed scan with a layout.

For a completed, saved ZIP, **Send to Rumi** uses three requests. JSON-only scans still use `/capture/v1/room`.

1. `POST /capture/v1/package/begin` with the upload bearer token and JSON `{sessionId, idempotencyKey}`. The response contains `{uploadUrl, contentType, maxBytes, uploaded}`. The URL is a short-lived direct Convex storage upload URL. The random MIME subtype binds the file to this capture grant. Retain the same package file and idempotency key for retries.
2. `POST` the exact ZIP bytes to `uploadUrl`, with the returned `Content-Type` and **no Authorization header**. The native client streams from the saved file, rejects redirects, and accepts only the matching allowlisted deployment's HTTPS `.convex.cloud/api/storage/upload` destination. Storage returns `{storageId}`.
3. `POST /capture/v1/package/complete` with the upload bearer token and JSON `{sessionId, idempotencyKey, storageId}`. The backend checks session authorization/expiration, file binding, size, and stored SHA-256 digest before accepting the file. Response: `{sessionId, status: "uploaded"}`. Identical retries preserve the accepted file; different payloads or keys cannot replace it. A repeat begin after acceptance returns `uploaded: true` and `uploadUrl: null`.

The owner-only session query adds `format: "json" | "zip"`, defaulting old records to JSON. The browser bounds the download, imports ZIPs through the same validating worker used for file import, and waits for processing and local persistence before reporting success. The server validates the storage envelope, not ZIP contents; a receipt is not proof of a valid reconstruction. The browser validates all archive contents before decoding images or displaying geometry.

Direct upload URLs are required because Convex HTTP actions limit request bodies to 20 MB. Accepted scans are capped at 128 MiB. Upload-URL issuance shares the twenty-attempt limit. URLs already issued can still receive data after client cancellation, but completion rejects canceled/expired grants. A daily, paginated cleanup removes unattached Rumi package files older than 24 hours, including uploads whose response was lost. Attached scans retain the existing session cleanup policy. Unrelated storage objects are excluded.

Rollout requires syncing `schema.ts`, `captures.ts`, `http.ts`, and `crons.ts` to the deployment owner’s backend, then updating the web and iPhone apps. Added schema fields are optional; existing capture records require no backfill. The schema adds `captures.by_storageId`. No deployment was performed as part of the realism implementation.
