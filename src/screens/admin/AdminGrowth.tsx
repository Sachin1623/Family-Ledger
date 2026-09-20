import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { adminGet } from '../../lib/adminApi';

interface WeekBucket {
  total: number;
  byChannel: Record<string, number>;
}

interface GrowthResponse {
  invites: { thisWeek: WeekBucket; previousWeek: WeekBucket };
  shares: { thisWeek: WeekBucket; previousWeek: WeekBucket };
  dailyTrend: { day: string; invites: number; shares: number }[];
}

const INVITE_CHANNEL_LABELS: Record<string, string> = {
  invite_whatsapp: 'WhatsApp',
  invite_sms: 'SMS',
  invite_email: 'Email',
  invite_inapp: 'In-app (existing user)',
};

const SHARE_CHANNEL_LABELS: Record<string, string> = {
  share_whatsapp: 'WhatsApp',
  share_facebook: 'Facebook',
  share_twitter: 'X (Twitter)',
  share_linkedin: 'LinkedIn',
  share_native: 'Native share sheet',
  share_link_only: 'Copy link only',
};

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function DeltaBadge({ current, previous }: { current: number; previous: number }) {
  const pct = pctChange(current, previous);
  if (pct === null) {
    return <span className="text-xs font-bold text-primary">new this week</span>;
  }
  const up = pct > 0;
  const flat = pct === 0;
  return (
    <span className={`text-xs font-bold ${flat ? 'text-text-muted' : up ? 'text-success' : 'text-error'}`}>
      {flat ? '—' : up ? '▲' : '▼'} {Math.abs(pct)}% vs last week
    </span>
  );
}

function WeekCompareCard({
  title,
  subtitle,
  thisWeek,
  previousWeek,
  channelLabels,
}: {
  title: string;
  subtitle: string;
  thisWeek: WeekBucket;
  previousWeek: WeekBucket;
  channelLabels: Record<string, string>;
}) {
  const channels = Object.keys(channelLabels)
    .map((key) => ({ key, label: channelLabels[key], count: thisWeek.byChannel[key] || 0, prev: previousWeek.byChannel[key] || 0 }))
    .sort((a, b) => b.count - a.count);

  return (
    <section className="bg-white rounded-2xl border border-border-subtle p-5">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h2 className="text-lg font-bold text-primary">{title}</h2>
          <p className="text-xs text-text-muted">{subtitle}</p>
        </div>
      </div>
      <div className="flex items-end gap-3 mt-3 mb-4">
        <p className="text-4xl font-black text-primary">{thisWeek.total}</p>
        <div className="pb-1">
          <DeltaBadge current={thisWeek.total} previous={previousWeek.total} />
          <p className="text-[11px] text-text-muted">{previousWeek.total} last week</p>
        </div>
      </div>
      <div className="space-y-2">
        {channels.map((c) => (
          <div key={c.key} className="flex items-center justify-between text-sm border-b border-border-subtle last:border-0 py-2">
            <span className="text-on-surface">{c.label}</span>
            <span className="flex items-center gap-2">
              <span className="font-bold text-primary">{c.count}</span>
              <span className="text-[11px] text-text-muted w-20 text-right">{c.prev} last wk</span>
            </span>
          </div>
        ))}
        {channels.every((c) => c.count === 0 && c.prev === 0) && (
          <p className="text-sm text-text-muted">No activity in the last 2 weeks.</p>
        )}
      </div>
    </section>
  );
}

export default function AdminGrowth() {
  const [data, setData] = useState<GrowthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminGet('/api/admin/analytics/growth')
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 pb-24">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black text-primary">Growth</h1>
          <p className="text-sm text-text-muted font-medium">Are invites and "Spread the Word" actually getting used?</p>
        </div>
        <Link to="/admin" className="text-sm font-bold text-primary underline shrink-0">Back to Admin</Link>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}

      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <WeekCompareCard
              title="Group Invites Sent"
              subtitle="WhatsApp, SMS, email, and in-app invites sent from any group"
              thisWeek={data.invites.thisWeek}
              previousWeek={data.invites.previousWeek}
              channelLabels={INVITE_CHANNEL_LABELS}
            />
            <WeekCompareCard
              title='"Spread the Word" Shares'
              subtitle="Profile page share-the-app clicks, by channel"
              thisWeek={data.shares.thisWeek}
              previousWeek={data.shares.previousWeek}
              channelLabels={SHARE_CHANNEL_LABELS}
            />
          </div>

          <section className="bg-white rounded-2xl border border-border-subtle p-5">
            <h2 className="text-lg font-bold text-primary mb-4">Daily Trend (last 14 days)</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.dailyTrend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis dataKey="day" fontSize={10} tick={{ fill: '#6B7280' }} />
                  <YAxis fontSize={10} tick={{ fill: '#6B7280' }} allowDecimals={false} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="invites" stroke="#0f4761" strokeWidth={2} dot={false} name="Invites" />
                  <Line type="monotone" dataKey="shares" stroke="#16A34A" strokeWidth={2} dot={false} name="Shares" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {data.dailyTrend.length === 0 && <p className="text-sm text-text-muted mt-2">No invite or share activity recorded yet — tracking started when this tab shipped, so history will build up from here.</p>}
          </section>
        </>
      )}
    </div>
  );
}
