#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
qa_source="$repo_root/.github/android-icon-qa"
qa_work="$(mktemp -d)"
qa_output="$repo_root/app/build/reports/icon-qa"
mkdir -p "$qa_work/classes" "$qa_work/dex" "$qa_output"
trap 'rm -rf "$qa_work"' EXIT

sdk_path="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Android SDK must be set}}"
build_tools="$sdk_path/build-tools/35.0.0"
android_jar="$sdk_path/platforms/android-36/android.jar"
debug_key="$qa_work/debug.keystore"
# Gradle's cache can restore the APK without restoring its signing keystore.
# Use one disposable QA key for the app copy and its instrumentation probe.
keytool -genkeypair -keystore "$debug_key" -alias androiddebugkey \
  -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 1 \
  -dname 'CN=Android Debug,O=Android,C=US' >/dev/null 2>&1

javac -source 8 -target 8 -classpath "$android_jar" -d "$qa_work/classes" \
  "$qa_source/IconQaInstrumentation.java"
"$build_tools/d8" --lib "$android_jar" --min-api 26 --output "$qa_work/dex" \
  "$qa_work/classes/com/packsmartsolutions/iconqa/IconQaInstrumentation.class"
"$build_tools/aapt2" link -I "$android_jar" --manifest "$qa_source/AndroidManifest.xml" \
  -o "$qa_work/probe.apk"
python3 - "$qa_work/probe.apk" "$qa_work/dex/classes.dex" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'a', zipfile.ZIP_DEFLATED) as apk:
    apk.write(sys.argv[2], 'classes.dex')
PY
"$build_tools/apksigner" sign --ks "$debug_key" --ks-key-alias androiddebugkey \
  --ks-pass pass:android --key-pass pass:android "$qa_work/probe.apk"
"$build_tools/apksigner" sign --ks "$debug_key" --ks-key-alias androiddebugkey \
  --ks-pass pass:android --key-pass pass:android --out "$qa_work/app-debug.apk" \
  "$repo_root/app/build/outputs/apk/debug/app-debug.apk"

adb install -r "$qa_work/app-debug.apk"
adb install -r -t "$qa_work/probe.apk"
adb shell am instrument -w com.packsmartsolutions.iconqa/.IconQaInstrumentation \
  | tee "$qa_output/instrumentation.txt"
grep -q 'ICON_QA_PASS:' "$qa_output/instrumentation.txt"
for icon in ic_launcher ic_launcher_round; do
  adb exec-out run-as com.packsmartsolutions.app.multiphoto cat "cache/$icon.png" \
    > "$qa_output/$icon.png"
done
adb uninstall com.packsmartsolutions.iconqa

adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
adb shell am start -W -n com.packsmartsolutions.app.multiphoto/com.packsmartsolutions.app.MainActivity \
  | tee "$qa_output/launch.txt"
grep -q 'Status: ok' "$qa_output/launch.txt"
test -n "$(adb shell pidof com.packsmartsolutions.app.multiphoto | tr -d '\r')"
adb exec-out screencap -p > "$qa_output/app-launch.png"
adb shell input keyevent KEYCODE_HOME
# Wait for the launcher to become idle before opening its app drawer.
adb shell uiautomator dump /sdcard/icon-qa-home.xml
adb exec-out cat /sdcard/icon-qa-home.xml > "$qa_output/home.xml"
adb exec-out screencap -p > "$qa_output/home.png"
screen_size="$(adb shell wm size | tr -d '\r' | sed -n 's/.*: \([0-9]*x[0-9]*\)/\1/p' | tail -1)"
screen_width="${screen_size%x*}"
screen_height="${screen_size#*x}"
# The bottom Google search widget consumes this gesture on Android 16.
# Start in the open wallpaper area above the dock instead.
adb shell input swipe "$((screen_width / 2))" "$((screen_height * 3 / 5))" \
  "$((screen_width / 2))" "$((screen_height / 5))" 500
for qa_attempt in $(seq 1 6); do
  adb shell uiautomator dump /sdcard/icon-qa-launcher.xml
  adb exec-out cat /sdcard/icon-qa-launcher.xml > "$qa_output/launcher.xml"
  if icon_coordinates="$(python3 - "$qa_output/launcher.xml" "$screen_width" "$screen_height" <<'PY'
import re, sys, xml.etree.ElementTree as ET
width, height = map(int, sys.argv[2:4])
nodes = ET.parse(sys.argv[1]).getroot().iter('node')
for node in nodes:
    if node.get('text') == 'Packsmart Solutions' or node.get('content-desc', '').startswith('Packsmart Solutions'):
        bounds = list(map(int, re.findall(r'-?\d+', node.get('bounds', ''))))
        if len(bounds) != 4 or node.get('clickable') != 'true' or node.get('enabled') != 'true':
            continue
        x1, y1, x2, y2 = bounds
        x, y = (x1 + x2) // 2, (y1 + y2) // 2
        if x2 <= x1 or y2 <= y1 or not (0 <= x < width and 0 <= y < height):
            continue
        print(x, y)
        break
else:
    raise SystemExit('Packsmart launcher icon was not visible')
PY
)"; then
    break
  fi
  # Scroll the open drawer if the app's alphabetical row is below the viewport.
  adb shell input swipe "$((screen_width / 2))" "$((screen_height * 4 / 5))" \
    "$((screen_width / 2))" "$((screen_height / 3))" 300
done
adb exec-out screencap -p > "$qa_output/launcher.png"
test -n "${icon_coordinates:-}"
read -r icon_x icon_y <<< "$icon_coordinates"
adb shell input tap "$icon_x" "$icon_y"
for qa_attempt in $(seq 1 20); do
  adb shell dumpsys activity activities > "$qa_output/launcher-tap.txt"
  if grep -Eq '(topResumedActivity|mResumedActivity).*com.packsmartsolutions.app.multiphoto' \
    "$qa_output/launcher-tap.txt"; then
    break
  fi
  sleep 0.5
done
grep -Eq '(topResumedActivity|mResumedActivity).*com.packsmartsolutions.app.multiphoto' \
  "$qa_output/launcher-tap.txt"
adb shell dumpsys package com.packsmartsolutions.app.multiphoto > "$qa_output/package.txt"
adb logcat -d -b crash > "$qa_output/crash.txt"
if grep -q 'Process: com.packsmartsolutions.app.multiphoto' "$qa_output/crash.txt"; then
  echo 'App crashed during launcher QA' >&2
  exit 1
fi
