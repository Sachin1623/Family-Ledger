import Foundation
import Capacitor
import UIKit
import Vision
import PDFKit

/**
 * Reads a payment receipt (PhonePe, Google Pay, Paytm …) that another app handed to FamilyLedger as a file
 * ("Copy to FamilyLedger" in the share sheet; see CFBundleDocumentTypes in Info.plist) and returns the same
 * shape as the Android plugin (ReceiptSharePlugin.java): the text read from the picture, where each line sits, and
 * a small compressed copy of the picture so it can be attached to the expense.
 *
 * The text is read ON THE DEVICE with Apple's Vision framework — nothing is uploaded. A file that was copied into
 * the app's own "Inbox" is deleted as soon as it has been read.
 */
@objc(ReceiptSharePlugin)
public class ReceiptSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReceiptSharePlugin"
    public let jsName = "ReceiptShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "processFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingShare", returnType: CAPPluginReturnPromise)
    ]

    // On iOS the JS side learns about a shared file through the App plugin's `appUrlOpen` event and then calls
    // processFile, so there's never anything "pending" here — kept so both platforms share one JS interface.
    @objc func getPendingShare(_ call: CAPPluginCall) {
        call.resolve([:])
    }

    @objc func processFile(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url") else {
            call.reject("url is required.")
            return
        }
        let url: URL = urlString.hasPrefix("file:") ? (URL(string: urlString) ?? URL(fileURLWithPath: urlString)) : URL(fileURLWithPath: urlString)

        DispatchQueue.global(qos: .userInitiated).async {
            let started = Date()
            var out: [String: Any] = ["pluginVersion": 3, "action": "open"]

            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }

            guard let data = try? Data(contentsOf: url) else {
                out["mime"] = ""
                out["error"] = "read: could not open the file"
                call.resolve(out)
                return
            }
            out["name"] = url.lastPathComponent
            out["sizeBytes"] = data.count

            let isPdf = url.pathExtension.lowercased() == "pdf" || data.starts(with: [0x25, 0x50, 0x44, 0x46])
            var picture: UIImage?
            if isPdf {
                out["mime"] = "application/pdf"
                out["kind"] = "pdf"
                if let doc = PDFDocument(data: data), let page = doc.page(at: 0) {
                    out["pages"] = doc.pageCount
                    let bounds = page.bounds(for: .mediaBox)
                    let width: CGFloat = 1500
                    let height = max(1, bounds.height * width / max(bounds.width, 1))
                    picture = page.thumbnail(of: CGSize(width: width, height: height), for: .mediaBox)
                }
            } else {
                out["mime"] = url.pathExtension.lowercased() == "png" ? "image/png" : "image/jpeg"
                out["kind"] = "image"
                picture = UIImage(data: data)
            }

            // Redraw upright so the text positions below are in the picture's own top-left coordinates.
            guard let source = picture, let upright = ReceiptSharePlugin.upright(source), let cg = upright.cgImage else {
                out["error"] = "image: could not decode"
                self.cleanUp(url)
                call.resolve(out)
                return
            }
            let width = Double(cg.width)
            let height = Double(cg.height)
            out["width"] = cg.width
            out["height"] = cg.height

            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = false // amounts and ids, not prose
            request.recognitionLanguages = ["en-US"]
            let handler = VNImageRequestHandler(cgImage: cg, options: [:])
            do {
                try handler.perform([request])
                let observations = request.results ?? []
                var lines: [[String: Any]] = []
                var text: [String] = []
                for obs in observations {
                    guard let best = obs.topCandidates(1).first else { continue }
                    let b = obs.boundingBox // normalised, origin bottom-left
                    lines.append([
                        "text": best.string,
                        "top": Int((1.0 - Double(b.maxY)) * height),
                        "left": Int(Double(b.minX) * width),
                        "bottom": Int((1.0 - Double(b.minY)) * height),
                        "right": Int(Double(b.maxX) * width)
                    ])
                    text.append(best.string)
                }
                out["lines"] = lines
                out["ocrText"] = text.joined(separator: "\n")
            } catch {
                out["error"] = "ocr: \(error.localizedDescription)"
            }
            out["ocrMs"] = Int(Date().timeIntervalSince(started) * 1000)

            // A small compressed copy for the expense's receipt photo (long side 1100 px, JPEG).
            let longSide = max(width, height)
            let scale = min(1.0, 1100.0 / longSide)
            let target = CGSize(width: width * scale, height: height * scale)
            let renderer = UIGraphicsImageRenderer(size: target)
            let small = renderer.image { _ in upright.draw(in: CGRect(origin: .zero, size: target)) }
            if let jpeg = small.jpegData(compressionQuality: 0.62) {
                let base64 = jpeg.base64EncodedString()
                out["imageData"] = "data:image/jpeg;base64," + base64
                out["imageChars"] = base64.count
            } else {
                out["imageError"] = "could not compress the picture"
            }

            self.cleanUp(url)
            call.resolve(out)
        }
    }

    /// Only files copied into the app's own Inbox are ours to delete (never a file opened in place from Files).
    private func cleanUp(_ url: URL) {
        if url.path.contains("/Inbox/") {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private static func upright(_ image: UIImage) -> UIImage? {
        if image.imageOrientation == .up { return image }
        let renderer = UIGraphicsImageRenderer(size: image.size)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: image.size)) }
    }
}
