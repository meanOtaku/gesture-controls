plugins {
    id("com.android.application")
}

android {
    namespace = "com.gesturecontrols.wearwatch"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.gesturecontrols.wearwatch"
        // Wear OS 3 (Galaxy Watch 4) ships API 30.
        minSdk = 30
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.wear:wear:1.3.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    // Samsung Health Sensor SDK 1.4.1, vendored under `vendor/` at the repo root
    // (not duplicated into this module). Provides raw PPG_CONTINUOUS on Galaxy
    // Watch 4+ Samsung Wear OS; see PpgCollector.kt.
    implementation(files("../../../vendor/samsung-health-sensor-sdk/1.4.1/libs/samsung-health-sensor-api-1.4.1.aar"))
}
