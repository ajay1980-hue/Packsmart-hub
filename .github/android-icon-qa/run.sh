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
debug_key="${ANDROID_USER_HOME:-$HOME/.android}/debug.keystore"

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

adb install -r "$repo_root/app/build/outputs/apk/debug/app-debug.apk"
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
screen_size="$(adb shell wm size | tr -d '\r' | sed -n 's/.*: \([0-9]*x[0-9]*\)/\1/p' | tail -1)"
screen_width="${screen_size%x*}"
screen_height="${screen_size#*x}"
adb shell input swipe "$((screen_width / 2))" "$((screen_height * 9 / 10))" \
  "$((screen_width / 2))" "$((screen_height / 5))" 500
adb shell uiautomator dump /sdcard/icon-qa-launcher.xml
adb exec-out cat /sdcard/icon-qa-launcher.xml > "$qa_output/launcher.xml"
adb exec-out screencap -p > "$qa_output/launcher.png"
read -r icon_x icon_y < <(python3 - "$qa_output/launcher.xml" <<'PY'
import re, sys, xml.etree.ElementTree as ET
nodes = ET.parse(sys.argv[1]).getroot().iter('node')
for node in nodes:
    if node.get('text') == 'Packsmart Solutions' or node.get('content-desc', '').startswith('Packsmart Solutions'):
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds', '')))
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
else:
    raise SystemExit('Packsmart launcher icon was not visible')
PY
)
adb shell input tap "$icon_x" "$icon_y"
adb shell dumpsys activity activities > "$qa_output/launcher-tap.txt"
grep -Eq '(topResumedActivity|mResumedActivity).*com.packsmartsolutions.app.multiphoto' \
  "$qa_output/launcher-tap.txt"
adb shell dumpsys package com.packsmartsolutions.app.multiphoto > "$qa_output/package.txt"
adb logcat -d -b crash > "$qa_output/crash.txt"
if grep -q 'Process: com.packsmartsolutions.app.multiphoto' "$qa_output/crash.txt"; then
  echo 'App crashed during launcher QA' >&2
  exit 1
fi
