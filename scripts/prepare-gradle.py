#!/usr/bin/env python3
"""Generate the Gradle project used by cloud CI. Legacy Android files stay untouched."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SETTINGS = """\
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { url 'https://jitpack.io' }
    }
}
rootProject.name = 'Orbit'
include ':shell'
"""

ROOT_BUILD = """\
plugins {
    id 'com.android.application' version '8.5.2' apply false
}
"""

SHELL_BUILD = """\
plugins {
    id 'com.android.application'
}

android {
    namespace 'app.orbit.music'
    compileSdk 34

    defaultConfig {
        applicationId 'app.orbit.music'
        minSdk 23
        targetSdk 34
        versionCode 1
        versionName '1.0'
    }

    buildTypes {
        release {
            minifyEnabled false
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_1_8
        targetCompatibility JavaVersion.VERSION_1_8
        coreLibraryDesugaringEnabled true
    }

    androidResources {
        noCompress += 'wav'
    }

    sourceSets {
        getByName('main') {
            manifest.srcFile '../AndroidManifest.xml'
            java.srcDirs '../src'
            res.srcDirs '../res'
            assets.srcDirs '../app'
        }
    }
}

dependencies {
    // NewPipeExtractor v0.27.1 uses Java 17-era APIs and requires the NIO desugar set below API 33.
    coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs_nio:2.1.4'
    implementation 'com.github.TeamNewPipe:NewPipeExtractor:v0.27.1'
}
"""


def main():
    shell = ROOT / "shell"
    shell.mkdir(parents=True, exist_ok=True)
    (ROOT / "settings.gradle").write_text(SETTINGS, encoding="utf-8")
    (ROOT / "build.gradle").write_text(ROOT_BUILD, encoding="utf-8")
    (shell / "build.gradle").write_text(SHELL_BUILD, encoding="utf-8")
    print("Generated Gradle 8.7 / AGP 8.5.2 project for app.orbit.music")


if __name__ == "__main__":
    main()
