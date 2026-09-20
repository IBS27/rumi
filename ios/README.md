# Rumi room capture

A SwiftUI iPhone app that pairs with the Rumi web app by QR code, scans one room with Apple's RoomPlan, and sends the completed room to the browser. Offline scanning and JSON export remain available. No native login or third-party dependencies are required. All app files live under `ios/`.

## Requirements

- Xcode 16 or later with an iOS 17+ SDK. Use an Xcode version that supports the iOS version on your phone. This checkout was built with Xcode 26.6.
- Deployment target: iOS 17.0. Swift 5 language mode with complete concurrency checking.
- A physical LiDAR-equipped iPhone. The app checks `RoomCaptureSession.isSupported` before creating a capture view and explicitly rejects the simulator. A simulator can verify onboarding and the unsupported-device screen only.
- A free Apple Account is sufficient for running on your own phone. No paid capabilities are required. Choose your own signing team in Xcode.

## Open and run on your phone

1. Open `ios/RumiCapture.xcodeproj` in Xcode. Select the **RumiCapture** scheme.
2. In **Xcode > Settings > Accounts**, add your Apple Account. Complete login and two-factor authentication yourself.
3. Select the project, then the **RumiCapture** app target and **Signing & Capabilities**. Leave **Automatically manage signing** enabled. Choose your **Personal Team**.
4. Change the bundle identifier from `com.example.rumi.RumiCapture` to a unique value, such as `com.yourname.rumi.capture`. The checked-in project has a development team selected; replace it with yours if needed. If running tests on the phone, also select your team and unique identifiers on both test targets.
5. Connect the iPhone to the Mac by USB, unlock it, and accept **Trust This Computer** on the phone. In **Window > Devices and Simulators**, wait for Xcode to finish pairing/preparing it.
6. On the iPhone, enable **Settings > Privacy & Security > Developer Mode**, restart when asked, then unlock and confirm enabling Developer Mode. Pair with Xcode first if the option is missing. See [Apple's Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
7. Select your physical iPhone as the run destination and press **Run** or `Command-R`. Allow Xcode to create the development signing profile. If iOS requests developer trust, open **Settings > General > VPN & Device Management**, select your developer profile, and trust it.
8. Open Rumi Capture and allow camera access when you tap **Start Scan**. If denied, use **Open Settings**, enable Camera, return, and tap **Check permission again**. Restricted permissions may need Screen Time or device-management changes.

Signing and initial setup may need an internet connection to Apple. Scanning and local export do not.

Free-account provisioning profiles expire after **7 days**. Reconnect the phone, select the same Personal Team and bundle identifier, and run the app from Xcode again to rebuild and reinstall with a fresh profile. Keep the existing app installed to preserve its saved scan. Deleting it also deletes its local data. Apple also limits free accounts to 10 App IDs, 3 devices, and 3 installed development apps per device. See [Apple's Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account).

## Pair, scan, and send

1. Sign in to the web app and choose **Scan with iPhone**. Keep the QR dialog open.
2. Open Rumi Capture on the iPhone and tap **Connect to Rumi**. Allow camera access and scan the web QR code.
3. Check the displayed destination, then tap **Connect to Rumi**. After the QR camera closes, RoomPlan starts automatically for a new room.
4. Scan the room and tap **Finish Scan**. Wait for processing and review the result.
5. Tap **Send to Rumi**. The browser imports the room automatically. The saved scan remains on the iPhone for export or reconnection.

You can also pair after an offline scan or after restoring a saved room. If a connection expires or the browser cancels it, show a new QR code and reconnect without discarding the scan. Pairing credentials stay in memory, so relaunching requires reconnection. One session accepts one room; starting over after an upload attempt requires a fresh session. Starting over before sending keeps the existing connection.

`CaptureClient.swift` implements [the version 1 handoff](../docs/room-capture-pairing.md). Its explicit `CapturePairing.allowedOrigins` currently includes only Srinivas's development backend, `https://utmost-cow-946.convex.site`. Add other reviewed deployment origins in that list before using them. Arbitrary QR destinations and HTTP redirects are rejected. Tokens, QR payloads, and room data are not logged.

Claim and upload requests retry network failures, HTTP 429, and HTTP 5xx at most three times. Short `Retry-After` values are honored; longer waits return an error without retrying early. Cancel stops the task and retry loop. A lost response can mean the server accepted the request, so manual retry preserves the original claim ID or exact upload bytes and idempotency key. Only completed, saved RoomPlan JSON can be sent. The server's upload size limit is enforced before sending.

## Scan and export

1. Tap **Start Scan**. Scan one well-lit room, moving slowly and following RoomPlan's built-in guidance. Aim at the walls, openings, and furniture from useful angles.
2. Tap **Finish Scan** once. Keep Rumi in the foreground while it processes. Export is unavailable until RoomPlan delivers the final processed `CapturedRoom`.
3. Review Apple's 3D preview with drag/pinch gestures and check the detected counts. A result with no walls is treated as a failed scan.
4. Tap **Export JSON**. In the native share sheet, choose **AirDrop**, then your Mac. Keep Wi-Fi and Bluetooth enabled on both devices and make the Mac discoverable in Finder's AirDrop view. Accept the transfer on the Mac; files normally arrive in Downloads. Saving to Files is another option.
5. Import that `.json` file in Rumi's browser workflow. This app does not implement or validate the browser importer.
6. **Start another scan** asks before discarding the current scan. Canceling the share sheet leaves the scan available for another export. Even a successful share leaves the local result available until you explicitly discard it.

The app saves the encoded result atomically under its private Application Support directory, excluded from cloud backup. The share sheet receives a file URL that stays valid through sharing and dismissal. The file is deleted only when you confirm starting over; starting over is disabled while sharing. Relaunching the app restores the saved room and export. The live RoomPlan preview is only available in the session that captured it; a restored room shows detected counts. If local saving fails, the UI retains the result in memory and lets you retry export. Do that before terminating the app.

## Export contract and web-agent handoff

The only producer of an exportable result is `RoomCaptureViewDelegate.captureView(didPresent:error:)`, with a nil error. The app encodes that final, nonoptional value directly:

```swift
savedURL = try store.save(JSONEncoder().encode(room))
```

`RoomFileStore` writes those bytes unchanged. The `.json` file is the `CapturedRoom` object itself, not a custom envelope. The app does not encode live updates or `CapturedRoomData`, wrap the object, rename/filter fields, convert to TypeScript contracts, or strip identifiers, categories, confidence, surfaces, objects, dimensions, transforms, or version information. Apple controls what its encoder emits on each OS. Restored exports reuse the original file bytes rather than decoding and re-encoding them.

Filenames look like `rumi-room-2026-09-19T20-30-00Z-a1b2c3d4.json`. UTC timestamp plus a UUID suffix prevents repeated exports/scans from colliding.

Coordinates, dimensions, transforms, and units remain as Apple encodes them. Apple documents object/surface dimensions in meters and transforms as the position/orientation in the scan's coordinate system. Do not assume Rumi's floor-corner origin, base-centered furniture, cardinal wall labels, or yaw-only representation. The browser importer owns validation, version compatibility, axis/matrix interpretation, origin changes, and all normalization. Preserve unknown Apple fields there as appropriate. No shared TypeScript shape changes are needed from this native app.

To inspect an actual transferred file without rewriting it:

```sh
python3 ios/scripts/inspect_room_json.py ~/Downloads/rumi-room-*.json
```

Use one filename if you have multiple exports. The checker reports root fields and version, checks surface/object arrays and each element's identifier, category, confidence, three dimensions, and 4x4 transform. Missing detections may be real; the checker cannot prove that dimensions match the physical room. No mock or downloaded room is presented as a successful capture or supplied as a verified handoff.

## Verification

The QR connection implementation was added on Fedora. TypeScript type checking, lint, and all 43 Bun tests pass, including a regression for closing the browser dialog while an upload completes. The private frontend preview responds, but no browser was connected to the automation runtime, so the updated web interaction was not exercised. Native compilation, the new XCTest cases, and physical QR/RoomPlan transfer have **not** been run for this change. The historical results below cover the earlier offline scanner only.

New native tests in `CaptureClientTests.swift` and `CaptureConnectionTests.swift` cover QR validation, request encoding, stable retry identities and bytes, retry limits, response validation, upload size checks, cancellation, and reconnection. Run the RumiCapture scheme's tests in Xcode, then use a physical LiDAR iPhone for the pairing checklist below.

The backend cancellation fix requires syncing `convex/captures.ts` to the deployment after ownership is checked. No schema migration is needed. Code generation does not deploy that fix.


Verified on 2026-09-19 on the Mac checkout at `/Users/srinivasib/Developer/rumi`, branch `feat/room-capture-ios`, with Xcode 26.6:

| Check | Result |
| --- | --- |
| iOS Simulator Debug build | Passed, iPhone 17 Pro / iOS 26.5 |
| Generic iPhone arm64 Debug build | Passed with signing disabled; no installation implied |
| Native unit tests | 7 passed: final-processing gate, duplicate taps, stale callbacks, interruption/retry, completed-result protection, file retention, unique names, and write failure |
| Native UI test | 1 passed: onboarding, Start Scan, unsupported simulator, repeated retry, terminate/relaunch |
| Desktop UI interaction | Opened the installed app in Simulator, tapped Start Scan and Check again, inspected both screens; no scan/export controls or mock result appeared on the unsupported destination |
| Project validation | `plutil -lint` passed; no development team or paid entitlements configured |
| Physical device / actual JSON | Not tested. The paired iPhone 15 Pro Max was unavailable/offline in `devicectl` and `xctrace`. No live capture or real exported JSON was available to inspect. |

There were no Swift compiler warnings on the final builds. Xcode emitted its standard skipped App Intents metadata warning because the app has no App Intents dependency. The file tests use arbitrary test bytes and do not constitute LiDAR or `CapturedRoom` integration testing. Camera permission UI, RoomPlan guidance/preview, real share-sheet cancellation, AirDrop, and interruption during an actual capture still require the phone checklist below.

Final native results are in ignored `ios/DerivedData/FinalTests.xcresult`. Build/test output is not required to open the project. No web production build, deployment, push, or merge was performed.

```sh
xcodebuild -project ios/RumiCapture.xcodeproj -scheme RumiCapture \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/DerivedData build CODE_SIGNING_ALLOWED=NO

xcodebuild -project ios/RumiCapture.xcodeproj -scheme RumiCapture \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath ios/DerivedData test CODE_SIGNING_ALLOWED=NO

xcodebuild -project ios/RumiCapture.xcodeproj -scheme RumiCapture \
  -configuration Debug -destination 'generic/platform=iOS' \
  -derivedDataPath ios/DerivedData/Device build CODE_SIGNING_ALLOWED=NO
```

Choose an installed simulator name from `xcrun simctl list devices available`. The generic device build checks compilation/linking only; it does not sign, install, or exercise LiDAR.

### Physical-device checklist

- In the web app, create a QR code. Scan it in Rumi Capture, confirm the displayed destination, and verify that the web app says the phone is connected before RoomPlan starts.
- Finish a real scan and send it. Confirm the browser renders the room, survives reload, and the phone still offers Export JSON.
- Scan an unrelated QR code, deny camera access, and try an expired or already claimed code. Confirm each error offers recovery without losing a saved room.
- Cancel the web dialog before sending; reconnect to a new code and send the same saved room. Close the web dialog just as an upload completes and verify an accepted room still imports.
- Interrupt networking during a send, retry, and confirm one room is imported. Cancel an upload retry, then retry manually. Relaunch and reconnect to send the retained file.

- Deny camera permission; verify Settings recovery. Rapidly tap Start/Finish and confirm only one scan/session runs.
- Scan a furnished room with walls and openings. Finish, wait for processing, inspect the preview and counts. Confirm Export is unavailable before final processing.
- Open Export JSON, cancel sharing, then export again. Confirm **Keep scan** cancels the start-over confirmation.
- AirDrop JSON to the Mac; run the inspector above. Check walls/openings/objects, dimensions and transforms, then import with the web workflow. Compare several dimensions with a tape measure.
- Relaunch Rumi and export the retained result again. Confirm starting another scan discards only after confirmation, and the new scan does not reuse the old session/result.
- During scanning and during processing, lock the phone or background the app. Return and confirm an interruption message and ability to start again. Backgrounding a completed scan must retain it.
- With Auto-Lock set to 30 seconds, leave the screen untouched during scanning and processing. Confirm the phone stays awake, then confirm auto-lock resumes after completion, failure, or discard.
- Test an export/save failure if practical, such as insufficient storage. The completed in-memory room must remain available to retry. Do not delete personal data to induce this test.

## Limitations

One room at a time. No multi-room merging, editing, measurements UI, USDZ export, photorealistic assets, or empty-space calculations. RoomPlan detects supported categories and approximate geometry; it can miss or misclassify objects. An interrupted active scan is discarded with an explanation; partial geometry is never labeled a completed room. Processing has a two-minute failure timeout with retry. Saved JSON remains private until you send it to the paired browser or choose an export destination. Uninstalling the app deletes its local result.

## Apple references

- [Official RoomPlan sample and overview](https://developer.apple.com/documentation/roomplan/create-a-3d-model-of-an-interior-room-by-guiding-the-user-through-an-ar-experience). Reviewed the downloadable sample's `RoomCaptureViewController.swift` and the installed SDK declarations.
- [Final-result delegate](https://developer.apple.com/documentation/roomplan/roomcaptureviewdelegate).
- [Processed preview behavior](https://developer.apple.com/documentation/roomplan/roomcaptureviewdelegate/captureview(shouldpresent:error:)).
- [CapturedRoom](https://developer.apple.com/documentation/roomplan/capturedroom).
- [Surface dimensions](https://developer.apple.com/documentation/roomplan/capturedroom/surface/dimensions) and [surface transform](https://developer.apple.com/documentation/roomplan/capturedroom/surface/transform).
