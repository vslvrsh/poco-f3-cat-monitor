plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.purrcam.app"
    compileSdk = 37
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.purrcam.app"
        minSdk = 28
        targetSdk = 35
        versionCode = 2
        versionName = "1.1.0"
    }

    val releaseKeystorePath = (project.findProperty("PURRCAM_KEYSTORE_PATH") as? String)
        ?: System.getenv("PURRCAM_KEYSTORE_PATH")
    val releaseKeystorePassword = (project.findProperty("PURRCAM_KEYSTORE_PASSWORD") as? String)
        ?: System.getenv("PURRCAM_KEYSTORE_PASSWORD")
    val releaseKeyAlias = (project.findProperty("PURRCAM_KEY_ALIAS") as? String)
        ?: System.getenv("PURRCAM_KEY_ALIAS")
    val releaseKeyPassword = (project.findProperty("PURRCAM_KEY_PASSWORD") as? String)
        ?: System.getenv("PURRCAM_KEY_PASSWORD")
    val hasReleaseSigning = !releaseKeystorePath.isNullOrBlank() &&
        file(releaseKeystorePath).exists() &&
        !releaseKeystorePassword.isNullOrBlank() &&
        !releaseKeyAlias.isNullOrBlank() &&
        !releaseKeyPassword.isNullOrBlank()

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        release {
            isDebuggable = false
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        aidl = false
        buildConfig = true
        shaders = false
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.stream.webrtc.android)

    testImplementation(libs.junit)
}
