import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet, adminPost } from '../../lib/adminApi';

interface PlatformFields {
  latestVersionCode: string;
  latestVersionName: string;
  releaseNotes: string;
}

const EMPTY_PLATFORM: PlatformFields = { latestVersionCode: '', latestVersionName: '', releaseNotes: '' };

function PlatformSection({
  title,
  hint,
  required,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  required: boolean;
  value: PlatformFields;
  onChange: (next: PlatformFields) => void;
}) {
  return (
    <div className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
      <div>
        <h2 className="font-bold text-primary">{title}</h2>
        <p className="text-xs text-text-muted">{hint}</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">
            Latest build number{required ? '' : ' (optional)'}
          </label>
          <input
            type="number"
            value={value.latestVersionCode}
            onChange={(e) => onChange({ ...value, latestVersionCode: e.target.value })}
            placeholder="e.g. 6"
            required={required}
            className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Version name</label>
          <input
            type="text"
            value={value.latestVersionName}
            onChange={(e) => onChange({ ...value, latestVersionName: e.target.value })}
            placeholder="e.g. 1.2.0"
            className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Release notes</label>
        <textarea
          value={value.releaseNotes}
          onChange={(e) => onChange({ ...value, releaseNotes: e.target.value })}
          rows={4}
          placeholder="What's new in this version?"
          className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20 resize-none"
        />
      </div>
    </div>
  );
}

export default function AdminAppVersion() {
  const [android, setAndroid] = useState<PlatformFields>(EMPTY_PLATFORM);
  const [ios, setIos] = useState<PlatformFields>(EMPTY_PLATFORM);
  const [current, setCurrent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    adminGet('/api/admin/app-version')
      .then((data) => {
        setCurrent(data);
        // Back-compat: a doc saved before iOS existed has flat fields at the root, always meant
        // for Android — fall back to those if the new `android` key isn't there yet.
        const androidData = data.android ?? {
          latestVersionCode: data.latestVersionCode,
          latestVersionName: data.latestVersionName,
          releaseNotes: data.releaseNotes,
        };
        if (androidData?.latestVersionCode != null) {
          setAndroid({
            latestVersionCode: String(androidData.latestVersionCode),
            latestVersionName: androidData.latestVersionName || '',
            releaseNotes: androidData.releaseNotes || '',
          });
        }
        if (data.ios?.latestVersionCode != null) {
          setIos({
            latestVersionCode: String(data.ios.latestVersionCode),
            latestVersionName: data.ios.latestVersionName || '',
            releaseNotes: data.ios.releaseNotes || '',
          });
        }
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
        android: {
          latestVersionCode: Number(android.latestVersionCode),
          latestVersionName: android.latestVersionName,
          releaseNotes: android.releaseNotes,
        },
        ios: ios.latestVersionCode
          ? {
              latestVersionCode: Number(ios.latestVersionCode),
              latestVersionName: ios.latestVersionName,
              releaseNotes: ios.releaseNotes,
            }
          : null,
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
        Android and iOS build numbers are tracked separately — they come from completely
        different pipelines (Play Console vs. Xcode Cloud) and don't correspond to each other.
        A user on a build older than the number set for their platform sees an "Update Available"
        prompt with that platform's release notes every time they open the app, until they update.
      </p>

      {loading && <p className="text-center text-text-muted py-10">Loading…</p>}

      {!loading && (
        <form onSubmit={handleSave} className="space-y-4">
          {current?.updatedAt && (
            <p className="text-[11px] text-text-muted">
              Last updated {new Date(current.updatedAt).toLocaleString()} by {current.updatedBy || 'unknown'}
            </p>
          )}

          <PlatformSection
            title="Android"
            hint="Compared against Play Console's versionCode."
            required
            value={android}
            onChange={setAndroid}
          />

          <PlatformSection
            title="iOS"
            hint="Compared against the Xcode Cloud build number. Leave blank to never show the update prompt on iOS — TestFlight testers are already notified directly by TestFlight."
            required={false}
            value={ios}
            onChange={setIos}
          />

          {error && <div className="p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}
          {saved && <div className="p-3 bg-success/10 text-success text-sm rounded-xl border border-success/20">Saved.</div>}
          <button
            type="submit"
            disabled={saving || !android.latestVersionCode}
            className="w-full py-3.5 bg-primary text-white font-bold rounded-2xl disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </div>
  );
}
