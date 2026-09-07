# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# --- FamilyLedger-specific rules (added when minifyEnabled was first turned on for release) ---
# REQUIRED whenever any code reads annotations reflectively at runtime, which Capacitor's own core
# does for every plugin — Plugin.checkPermissions() reads each plugin's @CapacitorPlugin(permissions
# = {...}) off the class object via getAnnotation() to know what to check. Without this, R8 strips
# annotations' runtime-visible values entirely (even the class hosting them is kept and un-renamed,
# the ANNOTATION DATA itself still goes) — silent at build time, a NullPointerException inside
# Capacitor's own getPermissionStates() at first launch. This is what actually crashed the first
# minified build.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# Capacitor core already ships its own consumer ProGuard rules that keep plugin classes and
# @PluginMethod-annotated methods reachable via its Bridge's reflection-based dispatch — these
# rules are deliberately redundant with that, not a substitute for it, since this app's OWN plugin
# (AlarmClockPlugin, not a third-party one) is the one piece of reflection-sensitive code Capacitor
# itself has no way to know about in advance.
-keep class com.familyledger.app.AlarmClockPlugin { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.CapacitorPlugin *;
    @com.getcapacitor.PluginMethod <methods>;
}

# Manifest-declared components (AlarmActivity/AlarmReceiver/AlarmRingingService/AlarmBootReceiver,
# MainActivity) are already auto-kept by AGP's default consumer rules — nothing extra needed for
# those. This one covers AlarmScheduler/AlarmReceiver's own Intent extras, which are plain String
# constants (EXTRA_ID etc.), not reflection targets, so no rule is needed there either.

# @capacitor-firebase/authentication supports several sign-in providers, Facebook among them, and
# its FacebookAuthProviderHandler references the real Facebook SDK's classes unconditionally —
# but this app only ever uses Google Sign-In (see the SSO-only rename of this whole app/repo), so
# the Facebook SDK itself was never added as a dependency. R8's full-mode class analysis fails the
# BUILD (not just a runtime warning) when it can't resolve a referenced class, even one that's
# genuinely never reached at runtime for a provider this app doesn't use — `-dontwarn` tells it
# that's expected here, not a real problem to fail on.
-dontwarn com.facebook.**
