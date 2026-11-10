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

# EXPERIMENT (TestFlight 1.0.2 builds 29/30): Google sign-in stalls after "Continue" on 1.0.2 but works on App Store build 23. The native
# analytics plugin (@capacitor-firebase/analytics) is new since build 23, so it is left out of the iPhone app for this build. The JS calls
# are all .catch()-guarded, so they simply do nothing. Android is unaffected. If sign-in then works, the plugin is the cause; if not,
# delete this block (and the experiment) and look at the other October native changes instead.
# (Done by editing the CI copy of package.json: `cap sync` stops with an error if a listed plugin is missing from node_modules.)
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.dependencies['@capacitor-firebase/analytics'];fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
rm -rf node_modules/@capacitor-firebase/analytics

npx cap sync ios
