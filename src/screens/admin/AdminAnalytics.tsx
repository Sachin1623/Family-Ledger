import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { adminGet } from '../../lib/adminApi';

interface TopEntry { groupId?: string; uid?: string; name: string; totalSpend: number; entryCount: number }
interface TrendPoint { day: string; logins: number; activeUsers: number }
interface InactiveUser { uid: string; email: string; displayName: string; daysInactive: number }
interface GameStats {
  key: string;
  label: string;
  totalGames: number;
  finishedGames: number;
  inProgressGames: number;
  uniquePlayers: number;
  totalHours: number;
}
interface GameStatsSummary { totalGames: number; totalUniquePlayers: number; totalHours: number }

export default function AdminAnalytics() {
  const [topGroups, setTopGroups] = useState<TopEntry[]>([]);
  const [topUsers, setTopUsers] = useState<TopEntry[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [inactive, setInactive] = useState<InactiveUser[]>([]);
  const [gameStats, setGameStats] = useState<GameStats[]>([]);
  const [gameStatsSummary, setGameStatsSummary] = useState<GameStatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      adminGet('/api/admin/analytics/top'),
      adminGet('/api/admin/analytics/usage-trend?days=30'),
      adminGet('/api/admin/analytics/inactive'),
      adminGet('/api/admin/analytics/games'),
    ])
      .then(([top, usage, inactiveData, games]) => {
        setTopGroups(top.topGroups);
        setTopUsers(top.topUsers);
        setTrend(usage.trend);
        setInactive(inactiveData.users);
        setGameStats(games.games);
        setGameStatsSummary(games.summary);
      })
      .catch((err) => setError(err.message));
  }, []);

  const agingBuckets = [
    { label: '0-2 days', min: 0, max: 2 },
    { label: '3-5 days', min: 3, max: 5 },
    { label: '6-14 days', min: 6, max: 14 },
    { label: '15-30 days', min: 15, max: 30 },
    { label: '30+ days', min: 31, max: Infinity },
  ].map((bucket) => ({
    ...bucket,
    count: inactive.filter((u) => u.daysInactive >= bucket.min && u.daysInactive <= bucket.max).length,
  }));

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-black text-primary">Analytics</h1>
        <Link to="/admin" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>

      {error && <div className="p-4 bg-red-50 text-red-700 text-sm rounded-xl border border-red-200">{error}</div>}

      <section className="bg-white rounded-2xl border border-border-subtle p-5">
        <h2 className="text-lg font-bold text-primary mb-4">Usage Trend (last 30 days)</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="day" fontSize={10} tick={{ fill: '#6B7280' }} />
              <YAxis fontSize={10} tick={{ fill: '#6B7280' }} />
              <Tooltip />
              <Line type="monotone" dataKey="logins" stroke="#0f4761" strokeWidth={2} dot={false} name="Logins" />
              <Line type="monotone" dataKey="activeUsers" stroke="#16A34A" strokeWidth={2} dot={false} name="Active Users" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <section className="bg-white rounded-2xl border border-border-subtle p-5">
          <h2 className="text-lg font-bold text-primary mb-4">Top Groups by Spend</h2>
          <div className="space-y-2">
            {topGroups.map((g) => (
              <div key={g.groupId} className="flex justify-between text-sm border-b border-border-subtle last:border-0 py-2">
                <span className="truncate">{g.name}</span>
                <span className="font-bold shrink-0 ml-2">{g.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({g.entryCount})</span>
              </div>
            ))}
            {topGroups.length === 0 && <p className="text-sm text-text-muted">No data yet.</p>}
          </div>
        </section>

        <section className="bg-white rounded-2xl border border-border-subtle p-5">
          <h2 className="text-lg font-bold text-primary mb-4">Top Individuals by Spend</h2>
          <div className="space-y-2">
            {topUsers.map((u) => (
              <div key={u.uid} className="flex justify-between text-sm border-b border-border-subtle last:border-0 py-2">
                <span className="truncate">{u.name}</span>
                <span className="font-bold shrink-0 ml-2">{u.totalSpend.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({u.entryCount})</span>
              </div>
            ))}
            {topUsers.length === 0 && <p className="text-sm text-text-muted">No data yet.</p>}
          </div>
        </section>
      </div>

      <section className="bg-white rounded-2xl border border-border-subtle p-5">
        <h2 className="text-lg font-bold text-primary mb-4">Inactive User Aging</h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={agingBuckets} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis dataKey="label" fontSize={10} tick={{ fill: '#6B7280' }} />
              <YAxis fontSize={10} tick={{ fill: '#6B7280' }} />
              <Tooltip />
              <Bar dataKey="count" fill="#0f4761" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 max-h-64 overflow-y-auto space-y-1">
          {inactive.slice(0, 30).map((u) => (
            <div key={u.uid} className="flex justify-between text-sm border-b border-border-subtle last:border-0 py-2">
              <span>{u.displayName || u.email}</span>
              <span className="text-text-muted">{u.daysInactive} days inactive</span>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white rounded-2xl border border-border-subtle p-5">
        <h2 className="text-lg font-bold text-primary mb-1">Game Stats</h2>
        <p className="text-xs text-text-muted mb-4">
          "Hours" only counts finished games (time from creation to finish) — an abandoned or still-open game has no real end time to measure.
        </p>
        {gameStatsSummary && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="bg-surface rounded-xl p-3">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Games Played</p>
              <p className="text-2xl font-black text-primary mt-0.5">{gameStatsSummary.totalGames}</p>
            </div>
            <div className="bg-surface rounded-xl p-3">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Unique Players</p>
              <p className="text-2xl font-black text-primary mt-0.5">{gameStatsSummary.totalUniquePlayers}</p>
            </div>
            <div className="bg-surface rounded-xl p-3">
              <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">Hours Played</p>
              <p className="text-2xl font-black text-primary mt-0.5">{gameStatsSummary.totalHours.toLocaleString()}</p>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-left text-text-muted border-b border-border-subtle">
                <th className="p-2">Game</th>
                <th className="p-2">Total</th>
                <th className="p-2">Finished</th>
                <th className="p-2">In Progress</th>
                <th className="p-2">Unique Players</th>
                <th className="p-2">Hours Played</th>
              </tr>
            </thead>
            <tbody>
              {gameStats.map((g) => (
                <tr key={g.key} className="border-b border-border-subtle last:border-0">
                  <td className="p-2 font-bold text-primary">{g.label}</td>
                  <td className="p-2">{g.totalGames}</td>
                  <td className="p-2">{g.finishedGames}</td>
                  <td className="p-2">{g.inProgressGames}</td>
                  <td className="p-2">{g.uniquePlayers}</td>
                  <td className="p-2 font-bold">{g.totalHours.toLocaleString()}</td>
                </tr>
              ))}
              {gameStats.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-3 text-text-muted text-center">No games played yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
