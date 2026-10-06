# Packsmart Android icon update: 2.1.4 / 104

## Verified Play release source

On 6 October 2026, the existing Play Console app `com.packsmartsolutions.app`
contained 15 uploaded versions: codes 2–13, 101, 102 and 103. The highest code,
103 / 2.1.3, was active in internal testing and also used by a closed-testing
draft. Production was inactive. Code 104 was absent and is the next unused code
selected for this update; its version name is 2.1.4.

The original `103.aab` downloaded from Play has SHA-256:

```
5ed9093936a1d431d0a48c31241fe1e4f5da535631ad5c5164d099114efb4c96
```

It exactly matches the retained `Packsmart-Solutions-Mirror-v2.1.3-Recompiled.aab`.
Its embedded Git revision is `dac9d436f8d50cd44cfc80b9e742311b61b28af1`, the
29 August 2026 test merge of the v2.1.2 offline-screen correction. Release 103
was prepared by updating the compiled 102 bundle's icon and version; those
changes were not committed to the current Android source.

The accepted 103 bundle and retained 102 base have identical `classes.dex`
(SHA-256 `903ca7299b4f6fdcd8d56c71821e3a18c6414d0a0e8b3b03455dc0506df51f81`).
Comparing the embedded source revision with PR #62 shows identical Java,
offline asset, layout and styles. This update retains that application code
and changes launcher resources plus release and validation metadata.

## Validation

The Android workflow builds the existing debug flavor and unsigned release
bundle, then runs `gradle :app:lintDebug :app:lintRelease --stacktrace` as a
separate step. Lint remains a blocking check and its full reports are uploaded.
No lint baseline, disabled check or new suppression is introduced.

The local standalone lint run found one existing `NewApi` error in both
variants: `android:windowLightNavigationBar` at `res/values/styles.xml:9`
requires API 27 while the app supports API 26. This style is identical to
the verified Play source and current main. Resolving this theme compatibility
issue requires a scope decision; this icon update does not alter the theme.
The PR must remain draft until this error is resolved and emulator QA passes.

The workflow's API 26 and API 36 emulator jobs install the debug APK and a
temporary instrumentation APK. The probe asserts version, existing debug
package, SDK levels, exact permission set, launcher mapping and adaptive
launcher/round resources. It renders both icons with Android's actual drawable
implementation at six densities and checks that silver/gold artwork exists
and fits the device mask. The probe is removed before launcher screenshots;
the script then taps the installed Packsmart icon and verifies the existing
activity resumes without an app crash. The probe is never bundled with the app.

Inspect the current head's workflow results and evidence artifacts. Record
actual completion and artifact hashes in the PR; do not infer device acceptance
from static PNG checks or a successful build.

## Existing signing process

Keep the release package `com.packsmartsolutions.app` and the existing private
`Packsmart-Play-upload-key.jks`, alias `packsmart-upload`. The keystore and
passwords stay outside the repository and all release packs. Sign a clean
commit's Gradle-generated AAB using `jarsigner`, with password prompts or
environment/file inputs that do not put secrets in command arguments or logs.

The registered Play upload certificate was checked live on 6 October 2026.
The retained key's public certificate matches its SHA-256:

```
0E:22:9D:4E:5F:A3:02:7A:40:77:A1:F1:28:EC:EB:5D:40:5E:65:D2:6D:AC:F3:CD:5E:6D:3A:1B:E7:30:0D:E2
```

Verify the JAR signature and certificate, run `bundletool validate`, inspect
the final manifest for code 104 / name 2.1.4 and the unchanged release package
and permission set, and retain SHA-256 hashes with the final artifact. Recheck
the Play bundle inventory immediately before any upload if another release
has been prepared in the meantime. A signed candidate with an unresolved lint
gate must not be described as Play ready or published.
