import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet, adminPost } from '../../lib/adminApi';

export default function AdminAppVersion() {
  const [latestVersionCode, setLatestVersionCode] = useState('');
  const [latestVersionName, setLatestVersionName] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [current, setCurrent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminGet('/api/admin/app-version')
      .then((data) => {
        setCurrent(data);
        if (data.latestVersionCode) setLatestVersionCode(String(data.latestVersionCode));
        if (data.latestVersionName) setLatestVersionName(data.latestVersionName);
        if (data.releaseNotes) setReleaseNotes(data.releaseNotes);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await adminPost('/api/admin/app-version', {
        latestVersionCode: Number(latestVersionCode),
        latestVersionName,
        releaseNotes,
      });
      setSaved(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-primary">App Version</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>
      <p className="text-sm text-text-muted">
        Users on an Android build older than this versionCode see an "Update Available" prompt
        with the release notes below every time they open the app, until they update.
      </p>

      {loading && <p className="text-center text-text-muted py-10">Loading…</p>}

      {!loading && (
        <form onSubmit={handleSave} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
          {current?.updatedAt && (
            <p className="text-[11px] text-text-muted">
              Last updated {new Date(current.updatedAt).toLocaleString()} by {current.updatedBy || 'unknown'}
            </p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Latest versionCode</label>
              <input
                type="number"
                value={latestVersionCode}
                onChange={(e) => setLatestVersionCode(e.target.value)}
                placeholder="e.g. 6"
                required
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Version name</label>
              <input
                type="text"
                value={latestVersionName}
                onChange={(e) => setLatestVersionName(e.target.value)}
                placeholder="e.g. 1.2.0"
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Release notes</label>
            <textarea
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              rows={6}
              placeholder="What's new in this version?"
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
            />
          </div>
          {error && <div className="p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}
          {saved && <div className="p-3 bg-success/10 text-success text-sm rounded-xl border border-success/20">Saved.</div>}
          <button
            type="submit"
            disabled={saving || !latestVersionCode}
            className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </div>
  );
}
