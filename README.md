# Packsmart Solutions Android Mirror App

Native Android WebView wrapper for https://packsmartsolutions.com.

## Prepared update
- Version name: 2.1.4
- Version code: 104
- Package: com.packsmartsolutions.app
- Target SDK: 36
- Java: 17
- Website content stays live because the app mirrors packsmartsolutions.com
- Multi-photo file selection is enabled for image uploads
- Social links open in their native/external apps
- Offline fallback page included

Google Play's existing internal release is 103 / 2.1.3. Version 104 was selected
after inspecting all 15 uploaded versions on 6 October 2026. See
[release reconciliation and QA](docs/android-icon-release-2.1.4.md) for the source
history and release gates. A successful compilation alone does not establish
Play readiness.

## Build outputs
GitHub Actions creates:
- Packsmart-Mirror-v2.1.4-debug — sideload QA APK using the .multiphoto package suffix
- Packsmart-Mirror-v2.1.4-Play-unsigned — release AAB for the existing Packsmart Play upload key
- Packsmart-Mirror-v2.1.4-lint — standalone debug/release lint reports
- Packsmart-Mirror-v2.1.4-icon-qa-api26 / api36 — emulator assertions and screenshots

The private Play upload keystore must never be committed to this repository.
