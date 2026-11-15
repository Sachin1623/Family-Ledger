import UIKit
import Capacitor

// FamilyLedger's own native plugins (ReceiptSharePlugin, AppPermissionsPlugin) live in this app target, not in a Capacitor package, so
// `cap sync` never lists them in capacitor.config.json's packageClassList and the bridge cannot find them on its own. Without this,
// Capacitor.isPluginAvailable('ReceiptShare') is false on iPhone and a shared payment receipt just opened the dashboard. They are
// registered here, once the bridge has loaded.
class FamilyLedgerBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ReceiptSharePlugin())
        bridge?.registerPluginInstance(AppPermissionsPlugin())
        bridge?.registerPluginInstance(SpeechRecognitionPlugin())
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = FamilyLedgerBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
