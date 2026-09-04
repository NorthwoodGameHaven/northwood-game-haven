plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "guru.gamehaven.tv"
    compileSdk = 34
    defaultConfig {
        applicationId = "guru.gamehaven.tv"
        minSdk = 26          // Google TV Streamer 4K ships Android 14; 26 covers older ATV too
        targetSdk = 34
        versionCode = 2
        versionName = "2026-09-04a"
    }
    buildTypes {
        release {
            isMinifyEnabled = false   // tiny app; keep the build one-click simple
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
}
