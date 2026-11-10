#!/bin/sh
set -e

# Xcode Cloud's build machine has no Node.js by default, and Capacitor's local Swift Package
# (CapApp-SPM, referenced by App.xcodeproj) points each plugin's iOS code at a relative path
# inside node_modules/ — which is gitignored, so it doesn't exist yet on a fresh clone. Without
# this script, Xcode Cloud can't resolve that package dependency at all and fails immediately
# with "Failed to analyze workspace," before any build ever starts.
#
# Node is downloaded straight from nodejs.org instead of `brew install node`: on the Xcode 26.x build machines (Intel Macs) Homebrew has no
# ready-made packages, so it compiles Node and ~38 dependencies from source and fails ("C compiler cannot create executables"). The
# download works on both Intel and Apple Silicon. Same version as the one used on the development PC.
NODE_VERSION=24.15.0
case "$(uname -m)" in
  arm64) NODE_ARCH=arm64 ;;
  *) NODE_ARCH=x64 ;;
esac
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz" -o /tmp/node.tar.gz
mkdir -p "$HOME/node"
tar -xzf /tmp/node.tar.gz -C "$HOME/node" --strip-components=1
export PATH="$HOME/node/bin:$PATH"
node -v
npm -v

cd "$CI_PRIMARY_REPOSITORY_PATH"
npm install
npm run build
npx cap sync ios
