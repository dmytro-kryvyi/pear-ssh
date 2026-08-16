// Pure-JVM SSH engine for the PearSsh Capacitor plugin. No Android APIs —
// everything here builds and tests with a plain JDK (`./gradlew test` against
// a scratch sshd), and the app module consumes it via includeBuild from
// mobile/android/settings.gradle.
plugins {
    kotlin("jvm") version "2.2.0"
}

group = "app.pear"
version = "0.1.0"

// Target 17 bytecode (safe for D8/desugaring on the app side) with whatever
// JDK runs the build — no toolchain auto-provisioning needed.
kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

repositories {
    mavenCentral()
    google()
}

dependencies {
    api("com.hierynomus:sshj:0.40.0")
    // sshj wants Bouncy Castle registered; Android ships a stripped "BC".
    // `api` on purpose: the app module registers BouncyCastleProvider itself,
    // so the classes must be on its compile classpath too.
    api("org.bouncycastle:bcprov-jdk18on:1.80")
    api("org.bouncycastle:bcpkix-jdk18on:1.80")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testRuntimeOnly("org.slf4j:slf4j-simple:2.0.16")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("org.slf4j.simpleLogger.defaultLogLevel", "warn")
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
