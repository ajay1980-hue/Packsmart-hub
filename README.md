# Packsmart Solutions Android Mirror App

Native Android WebView wrapper for https://packsmartsolutions.com.

## Current release
- Version name: 2.1.1
- Version code: 101
- Package: com.packsmartsolutions.app
- Target SDK: 36
- Java: 17
- Website content stays live because the app mirrors packsmartsolutions.com
- Multi-photo file selection is enabled for image uploads
- Social links open in their native/external apps
- Offline fallback page included

## Build outputs
GitHub Actions creates:
- Packsmart-Mirror-v2.1.1-debug — sideload QA APK using the .multiphoto package suffix
- Packsmart-Mirror-v2.1.1-Play-unsigned — release AAB ready for signing with the Packsmart Play upload key

The private Play upload keystore must never be committed to this repository.
