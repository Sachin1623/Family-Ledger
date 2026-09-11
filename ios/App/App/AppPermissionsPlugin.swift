import Foundation
import Capacitor
import UserNotifications
import Contacts
import AVFoundation
import UIKit

/**
 * JS-facing bridge for the "some permissions are missing" reminder (see
 * src/components/AppPermissionsReminder.tsx / src/lib/appPermissions.ts). Reports current grant
 * status for the handful of permissions this app actually asks for, and opens Settings to fix
 * them. There's no iOS equivalent of Android's exact-alarm-scheduling permission or battery-
 * optimization exemption, so those two just fall back to the general app Settings page too — a
 * shared JS call site still does something sensible on both platforms without needing a branch.
 */
@objc(AppPermissionsPlugin)
public class AppPermissionsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppPermissionsPlugin"
    public let jsName = "AppPermissions"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExactAlarmSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openBatteryOptimizationSettings", returnType: CAPPluginReturnPromise)
    ]

    @objc func checkAll(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let notificationsGranted = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            let contactsGranted = CNContactStore.authorizationStatus(for: .contacts) == .authorized
            let microphoneGranted = AVAudioSession.sharedInstance().recordPermission == .granted

            call.resolve([
                "notifications": notificationsGranted,
                "contacts": contactsGranted,
                "microphone": microphoneGranted
                // exactAlarm / batteryOptimization: Android-only concepts, deliberately omitted —
                // the JS side treats a missing key as "nothing to fix" on this platform.
            ])
        }
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
            call.resolve()
        }
    }

    @objc func openExactAlarmSettings(_ call: CAPPluginCall) {
        openAppSettings(call)
    }

    @objc func openBatteryOptimizationSettings(_ call: CAPPluginCall) {
        openAppSettings(call)
    }
}
