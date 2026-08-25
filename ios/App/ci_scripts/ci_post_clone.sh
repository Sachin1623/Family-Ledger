#!/bin/sh
set -e

# Xcode Cloud's build machine has no Node.js by default, and Capacitor's local Swift Package
# (CapApp-SPM, referenced by App.xcodeproj) points each plugin's iOS code at a relative path
# inside node_modules/ — which is gitignored, so it doesn't exist yet on a fresh clone. Without
# this script, Xcode Cloud can't resolve that package dependency at all and fails immediately
# with "Failed to analyze workspace," before any build ever starts.
brew install node

cd "$CI_PRIMARY_REPOSITORY_PATH"
npm install
npm run build
npx cap sync ios
