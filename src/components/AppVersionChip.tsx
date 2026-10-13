import React from 'react';
import { Capacitor } from '@capacitor/core';
import { useAppUpdate } from '../lib/useAppUpdate';

// Profile page, top right: always shows which version/build is installed, and turns into an
// "Update" button the moment a newer version is available on the store.
export default function AppVersionChip() {
  const { installed, updateAvailable, latestVersionName, startUpdate } = useAppUpdate();
  const native = Capacitor.isNativePlatform();

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold text-text-muted bg-white border border-border-subtle rounded-full px-2.5 py-1 whitespace-nowrap">
        {native && installed ? `v${installed.versionName} (${installed.build})` : 'Web app'}
      </span>
      {updateAvailable && (
        <button
          onClick={startUpdate}
          className="flex items-center gap-1 bg-success text-white text-[11px] font-black rounded-full pl-2 pr-3 py-1 shadow-sm active:scale-95 transition-transform"
          title={latestVersionName ? `Version ${latestVersionName} is available` : 'A new version is available'}
        >
          <span className="material-symbols-outlined text-[15px]">system_update</span>
          Update{latestVersionName ? ` to ${latestVersionName}` : ''}
        </button>
      )}
    </div>
  );
}
