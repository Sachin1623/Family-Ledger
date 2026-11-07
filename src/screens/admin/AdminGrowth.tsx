import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { adminGet } from '../../lib/adminApi';

interface WeekBucket {
  total: number;
  byChannel: Record<string, number>;
}

interface GrowthResponse {
  invites: { thisWeek: WeekBucket; previousWeek: WeekBucket };
  shares: { thisWeek: WeekBucket; previousWeek: WeekBucket };
  dailyTrend: { day: string; invites: number; shares: number; registered: number }[];
  series?: { days: string[]; data: Record<string, number[]> };
  conversion: { emailInvited: number; emailRegistered: number; emailJoined: number; registeredLast14: number; inAppInvited: number; inAppJoined: number; waRegistered: number; smsRegistered: number };
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

// Counts from a 56-day series (oldest first, last entry = today in Indian time). "Week" is the last 7 days, "last week" the 7 before that.
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
function windows(a: number[]) {
  const n = a.length;
  return { today: a[n - 1] || 0, yesterday: a[n - 2] || 0, week: sum(a.slice(n - 7)), lastWeek: sum(a.slice(n - 14, n - 7)) };
}
function weeklyTotals(a: number[]): number[] {
  const out: number[] = [];
  for (let k = 8; k >= 1; k--) out.push(sum(a.slice(a.length - 7 * k, a.length - 7 * (k - 1))));
  return out;
}

function TrendPill({ current, previous }: { current: number; previous: number }) {
  const pct = pctChange(current, previous);
  if (pct === null) return <span className="text-[11px] font-bold text-primary">new</span>;
  if (pct === 0) return <span className="text-[11px] font-bold text-text-muted">— steady</span>;
  const up = pct > 0;
  return <span className={`text-[11px] font-bold ${up ? 'text-success' : 'text-error'}`}>{up ? '▲' : '▼'} {Math.abs(pct)}%</span>;
}

// A tiny line of the last 28 days, so a row shows its general direction at a glance.
function Spark({ values }: { values: number[] }) {
  const v = values.slice(-28);
  const max = Math.max(1, ...v);
  const w = 56, h = 18;
  const pts = v.map((y, i) => `${(i / (v.length - 1)) * w},${h - 2 - (y / max) * (h - 4)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="#0f4761" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Figures({ values, bold = false }: { values: number[]; bold?: boolean }) {
  const w = windows(values);
  const cell = (n: number) => (
    <span className={`text-center tabular-nums ${bold ? 'font-black text-primary' : 'font-bold text-on-surface'} ${n === 0 ? 'opacity-40' : ''}`}>{n}</span>
  );
  return (
    <div className={`grid grid-cols-4 gap-1 ${bold ? 'text-xl' : 'text-sm'}`}>
      {cell(w.today)}{cell(w.yesterday)}{cell(w.week)}{cell(w.lastWeek)}
    </div>
  );
}

function ColumnHeads() {
  return (
    <div className="grid grid-cols-4 gap-1 text-[10px] font-bold uppercase tracking-wide text-text-muted text-center">
      <span>Today</span><span>Yesterday</span><span>This week</span><span>Last week</span>
    </div>
  );
}

function MetricCard({
  title,
  subtitle,
  totalKey,
  channelLabels,
  data,
  totalLabel,
}: {
  title: string;
  subtitle: string;
  totalKey: string;
  channelLabels: Record<string, string>;
  data: Record<string, number[]>;
  totalLabel: string;
}) {
  const total = data[totalKey] || [];
  const tw = windows(total);
  const channels = Object.keys(channelLabels)
    .map((key) => ({ key, label: channelLabels[key], values: data[key] || [] }))
    .sort((a, b) => sum(b.values.slice(-7)) - sum(a.values.slice(-7)) || sum(b.values) - sum(a.values));

  return (
    <section className="bg-white rounded-2xl border border-border-subtle p-5">
      <h2 className="text-lg font-bold text-primary">{title}</h2>
      <p className="text-xs text-text-muted">{subtitle}</p>
      <p className="text-[10px] text-text-muted mt-1">This week = the last 7 days, last week = the 7 days before. Indian time. The line shows the last 28 days.</p>

      <div className="mt-4 mb-1"><ColumnHeads /></div>
      <div className="rounded-xl bg-surface p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-sm font-black text-primary">{totalLabel}</span>
          <span className="flex items-center gap-2"><Spark values={total} /><TrendPill current={tw.week} previous={tw.lastWeek} /></span>
        </div>
        <Figures values={total} bold />
      </div>

      <div className="mt-2">
        {channels.map((c) => {
          const w = windows(c.values);
          return (
            <div key={c.key} className="py-2.5 border-b border-border-subtle last:border-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-on-surface">{c.label}</span>
                <span className="flex items-center gap-2"><Spark values={c.values} /><TrendPill current={w.week} previous={w.lastWeek} /></span>
              </div>
              <Figures values={c.values} />
            </div>
          );
        })}
        {channels.every((c) => sum(c.values) === 0) && <p className="text-sm text-text-muted pt-2">Nothing in the last 8 weeks.</p>}
      </div>
    </section>
  );
}

const NEW_USER_LABELS: Record<string, string> = {
  reg_email: 'Email invite',
  reg_wa: 'WhatsApp link',
  reg_sms: 'SMS link',
};

function fmtDay(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function TrendsCard({ series }: { series: { days: string[]; data: Record<string, number[]> } }) {
  const metrics = [
    { key: 'invites', label: 'Invites sent', color: '#0f4761' },
    { key: 'shares', label: 'Spread the Word shares', color: '#16A34A' },
    { key: 'registered', label: 'New users via invites', color: '#F59E0B' },
  ];
  const n = series.days.length;
  const weekStarts = Array.from({ length: 8 }, (_, i) => fmtDay(series.days[n - 7 * (8 - i)]));
  const weekly = metrics.map((m) => weeklyTotals(series.data[m.key] || []));
  const chart = weekStarts.map((label, i) => ({ label: i === 7 ? 'This wk' : label, ...Object.fromEntries(metrics.map((m, j) => [m.key, weekly[j][i]])) }));

  const lines = metrics.map((m, j) => {
    const w = weekly[j];
    const recent = sum(w.slice(4));
    const before = sum(w.slice(0, 4));
    const avg = Math.round((sum(w) / 8) * 10) / 10;
    const best = Math.max(...w);
    const bestAt = weekStarts[w.indexOf(best)];
    const pct = pctChange(recent, before);
    let direction: string;
    if (sum(w) === 0) direction = 'No activity in 8 weeks.';
    else if (pct === null) direction = 'Picking up: nothing in the 4 weeks before.';
    else if (pct === 0) direction = 'Steady against the 4 weeks before.';
    else direction = `${pct > 0 ? 'Up' : 'Down'} ${Math.abs(pct)}% over the last 4 weeks compared with the 4 before (${recent} vs ${before}).`;
    return { ...m, text: `${direction} Average ${avg} a week. Best week ${best}${best > 0 ? `, starting ${bestAt}` : ''}.` };
  });

  return (
    <section className="bg-white rounded-2xl border border-border-subtle p-5">
      <h2 className="text-lg font-bold text-primary">General trends (last 8 weeks)</h2>
      <p className="text-xs text-text-muted mb-4">Each bar is one week of 7 days, labelled by the day it started.</p>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chart} margin={{ top: 5, right: 10, left: -25, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
            <XAxis dataKey="label" fontSize={10} tick={{ fill: '#6B7280' }} interval={0} />
            <YAxis fontSize={10} tick={{ fill: '#6B7280' }} allowDecimals={false} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {metrics.map((m) => <Bar key={m.key} dataKey={m.key} name={m.label} fill={m.color} radius={[3, 3, 0, 0]} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 space-y-3">
        {lines.map((l) => (
          <div key={l.key} className="flex gap-2.5">
            <span className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: l.color }} />
            <p className="text-sm text-on-surface"><span className="font-bold text-primary">{l.label}.</span> {l.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function AdminGrowth({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<GrowthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminGet('/api/admin/analytics/growth')
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className={embedded ? 'space-y-6' : 'p-4 md:p-8 max-w-5xl mx-auto space-y-6 pb-24 md:pb-24'}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-black text-primary">Growth</h1>
            <p className="text-sm text-text-muted font-medium">Are invites and "Spread the Word" actually getting used?</p>
          </div>
          <Link to="/admin?tab=growth" className="text-sm font-bold text-primary underline shrink-0">Back to Admin</Link>
        </div>
      )}

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}

      {data && (
        <>
          {data.series ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <MetricCard
                  title="Group Invites Sent"
                  subtitle="WhatsApp, SMS, email, and in-app invites sent from any group"
                  totalKey="invites"
                  channelLabels={INVITE_CHANNEL_LABELS}
                  data={data.series.data}
                  totalLabel="All invites"
                />
                <MetricCard
                  title={'"Spread the Word" Shares'}
                  subtitle="Profile page share-the-app clicks, by channel"
                  totalKey="shares"
                  channelLabels={SHARE_CHANNEL_LABELS}
                  data={data.series.data}
                  totalLabel="All shares"
                />
              </div>
              <MetricCard
                title="New Users via Invites"
                subtitle="People who signed up after an email invite, or through a WhatsApp or SMS join link"
                totalKey="registered"
                channelLabels={NEW_USER_LABELS}
                data={data.series.data}
                totalLabel="All new users"
              />
              <TrendsCard series={data.series} />
            </>
          ) : (
            <p className="text-sm text-text-muted">The server is on an older version and has no daily figures yet.</p>
          )}

          <section className="bg-white rounded-2xl border border-border-subtle p-5">
            <h2 className="text-lg font-bold text-primary">Did invites bring new users?</h2>
            <p className="text-xs text-text-muted mb-4">Email invites are matched by address; WhatsApp and SMS by a tag inside the link.</p>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-surface rounded-xl p-3">
                <p className="text-2xl font-black text-primary">{data.conversion.emailInvited}</p>
                <p className="text-[11px] text-text-muted font-bold">People emailed</p>
              </div>
              <div className="bg-surface rounded-xl p-3">
                <p className="text-2xl font-black text-success">{data.conversion.emailRegistered}</p>
                <p className="text-[11px] text-text-muted font-bold">Registered</p>
              </div>
              <div className="bg-surface rounded-xl p-3">
                <p className="text-2xl font-black text-primary">
                  {data.conversion.emailInvited > 0 ? Math.round(( data.conversion.emailRegistered / data.conversion.emailInvited) * 100) : 0}%
                </p>
                <p className="text-[11px] text-text-muted font-bold">Signed up</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-center mt-3">
              <div className="bg-surface rounded-xl p-3">
                <p className="text-2xl font-black text-success">{data.conversion.waRegistered}</p>
                <p className="text-[11px] text-text-muted font-bold">Registered via WhatsApp link</p>
              </div>
              <div className="bg-surface rounded-xl p-3">
                <p className="text-2xl font-black text-success">{data.conversion.smsRegistered}</p>
                <p className="text-[11px] text-text-muted font-bold">Registered via SMS link</p>
              </div>
            </div>
            <p className="text-sm text-on-surface mt-4">
              <span className="font-bold text-primary">{data.conversion.registeredLast14}</span> new {data.conversion.registeredLast14 === 1 ? 'user' : 'users'} registered through an invite in the last 14 days.
            </p>
            <p className="text-sm text-on-surface mt-2">
              <span className="font-bold text-primary">{data.conversion.inAppJoined}</span> of {data.conversion.inAppInvited} in-app invites were accepted. These go to people who already have an account, so they can't be new registrations.
            </p>
            <p className="text-xs font-bold text-text-muted uppercase tracking-wider mt-5 mb-2">New users via invites, per day</p>
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.dailyTrend} margin={{ top: 5, right: 10, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
                  <XAxis dataKey="day" fontSize={10} tick={{ fill: '#6B7280' }} tickFormatter={(d: string) => d.slice(5)} />
                  <YAxis fontSize={10} tick={{ fill: '#6B7280' }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="registered" fill="#F59E0B" radius={[4, 4, 0, 0]} name="New users" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[11px] text-text-muted mt-3">WhatsApp and SMS count only links shared since tracking began, and only when the person signs up on the web or in the app. Someone who installs from the Play Store after tapping the link can't be matched yet.</p>
          </section>

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
                  <Line type="monotone" dataKey="registered" stroke="#F59E0B" strokeWidth={2.5} dot={{ r: 2 }} name="New users via invites" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {data.dailyTrend.every((d) => d.invites + d.shares + d.registered === 0) && <p className="text-sm text-text-muted mt-2">No invite or share activity recorded yet — tracking started when this tab shipped, so history will build up from here.</p>}
          </section>
        </>
      )}
    </div>
  );
}
