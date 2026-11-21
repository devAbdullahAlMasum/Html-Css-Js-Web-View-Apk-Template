#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${ORBIT_CLOUD_CACHE:-/tmp/orbit-toolchain}"
mkdir -p "$CACHE"
verify() {
  printf '%s  %s\n' "$2" "$3" | "$1" -c -
}
JDK_ID='17.0.21.1_2'
JDK_ARCHIVE="$CACHE/jdk-$JDK_ID.tar.gz"
if [[ ! -f "$JDK_ARCHIVE" ]]; then
  curl -fL --retry 3 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21.1%2B2/OpenJDK17U-jdk_x64_linux_hotspot_17.0.21.1_2.tar.gz' -o "$JDK_ARCHIVE"
fi
verify sha256sum '0b0ac5eab6db6abaec68c9913bcddb31321e5da411c45073d520d9c125e6f7b4' "$JDK_ARCHIVE"
if [[ ! -x "$CACHE/jdk/bin/java" || "$(cat "$CACHE/jdk/.orbit-release" 2>/dev/null || true)" != "$JDK_ID" ]]; then
  mkdir -p "$CACHE/jdk"
  tar -xzf "$JDK_ARCHIVE" -C "$CACHE/jdk" --strip-components=1
  printf '%s\n' "$JDK_ID" > "$CACHE/jdk/.orbit-release"
fi
NODE_ID='22.23.4'
NODE_ARCHIVE="$CACHE/node-v$NODE_ID-linux-x64.tar.gz"
if [[ ! -f "$NODE_ARCHIVE" ]]; then
  curl -fL --retry 3 "https://nodejs.org/dist/v$NODE_ID/node-v$NODE_ID-linux-x64.tar.gz" -o "$NODE_ARCHIVE"
fi
verify sha256sum 'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406' "$NODE_ARCHIVE"
if [[ ! -x "$CACHE/node-v$NODE_ID-linux-x64/bin/node" ]]; then
  tar -xzf "$NODE_ARCHIVE" -C "$CACHE"
fi
export JAVA_HOME="$CACHE/jdk"
export ANDROID_HOME="$CACHE/android"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
if [[ ! -f "$CACHE/gradle.zip" ]]; then
  curl -fL --retry 3 'https://services.gradle.org/distributions/gradle-8.7-bin.zip' -o "$CACHE/gradle.zip"
fi
verify sha256sum '544c35d6bd849ae8a5ed0bcea39ba677dc40f49df7d1835561582da2009b961d' "$CACHE/gradle.zip"
if [[ ! -x "$CACHE/gradle-8.7/bin/gradle" ]]; then
  unzip -q -o "$CACHE/gradle.zip" -d "$CACHE"
fi
if [[ ! -f "$CACHE/android-tools.zip" ]]; then
  curl -fL --retry 3 'https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip' -o "$CACHE/android-tools.zip"
fi
verify sha1sum 'd313adb7aedccf6cf0cfca51ec180f0059f5f8f8' "$CACHE/android-tools.zip"
if [[ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]]; then
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  unzip -q -o "$CACHE/android-tools.zip" -d "$ANDROID_HOME/cmdline-tools"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi
export PATH="$CACHE/node-v$NODE_ID-linux-x64/bin:$JAVA_HOME/bin:$CACHE/gradle-8.7/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager 'platforms;android-34' 'build-tools;34.0.0'
cd "$ROOT"
sed -i 's/android:minSdkVersion="12"/android:minSdkVersion="23"/' AndroidManifest.xml
sed -i 's/android:targetSdkVersion="27"/android:targetSdkVersion="34"/' AndroidManifest.xml
python3 scripts/generate-audio.py
python3 scripts/generate-icons.py
python3 scripts/vendor-ui-sdk.py
python3 scripts/prepare-gradle.py
gradle --no-daemon --max-workers=1 \
  -Dorg.gradle.jvmargs='-Xmx448m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m -XX:+UseSerialGC -XX:ActiveProcessorCount=1 -Dfile.encoding=UTF-8' \
  -Dorg.gradle.parallel=false :shell:assembleDebug --stacktrace
mkdir -p artifacts
cp shell/build/outputs/apk/debug/shell-debug.apk artifacts/Orbit.apk
"$ANDROID_HOME/build-tools/34.0.0/apksigner" verify --verbose artifacts/Orbit.apk
"$ANDROID_HOME/build-tools/34.0.0/aapt" dump badging artifacts/Orbit.apk > artifacts/apk-info.txt
