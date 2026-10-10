import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { auth } from '../../lib/firebase';
import { adminGet } from '../../lib/adminApi';
import { shareOrDownloadFile } from '../../lib/fileShare';

interface Build {
  name: string;
  sizeBytes: number;
  updatedAt: string | null;
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Test builds (APK / AAB), kept in a private bucket. Listing and downloading both go through admin-only
// endpoints, so nobody who isn't an app admin can see or fetch them.
export default function AdminBuilds() {
  const [builds, setBuilds] = useState<Build[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    adminGet('/api/admin/builds')
      .then((data) => setBuilds(data.builds || []))
      .catch((err) => setError(err.message || 'Unable to load builds.'))
      .finally(() => setLoading(false));
  }, []);

  const download = async (name: string) => {
    setDownloading(name);
    setError(null);
    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error('Not signed in.');
      const res = await fetch(`/api/admin/builds/download?name=${encodeURIComponent(name)}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Download failed (${res.status}).`);
      }
      const blob = await res.blob();
      await shareOrDownloadFile(blob, name, name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream');
    } catch (err: any) {
      setError(err.message || 'Download failed.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-primary">App Builds</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>
      <p className="text-sm text-text-muted">
        Test APKs and release bundles. Only app admins can see or download these — to install an APK on a phone,
        open this page on that phone, tap Download, then open the file (you may need to allow installs from your browser).
      </p>

      {error && <p className="text-sm font-bold text-error">{error}</p>}
      {loading && <p className="text-center text-text-muted py-10">Loading…</p>}
      {!loading && builds.length === 0 && !error && <p className="text-center text-text-muted py-10">No builds uploaded yet.</p>}

      <div className="space-y-3">
        {builds.map((b) => (
          <div key={b.name} className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center gap-3">
            <span className="material-symbols-outlined text-3xl text-primary shrink-0">{b.name.endsWith('.apk') ? 'android' : 'inventory_2'}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-on-surface break-all">{b.name}</p>
              <p className="text-xs text-text-muted">
                {formatSize(b.sizeBytes)}{b.updatedAt ? ` · ${new Date(b.updatedAt).toLocaleString()}` : ''}
              </p>
            </div>
            <button
              onClick={() => download(b.name)}
              disabled={downloading !== null}
              className="px-4 py-2 bg-primary text-white text-sm font-bold rounded-xl shrink-0 disabled:opacity-50"
            >
              {downloading === b.name ? 'Downloading…' : 'Download'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
