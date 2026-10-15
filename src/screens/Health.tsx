import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { FavoriteButton } from '../components/FavoriteButton';
import { ProgressRing, StatusChip, Tone } from '../components/HealthKit';
import { todayLocalDateString } from '../lib/dateUtils';
import { isMedicineDueOn, type Medicine } from '../lib/medicines';
import { isGlucoseInRange, targetForWindow, glucoseWindowOf, defaultGlucoseTargetMap } from '../lib/health';
import { bpRangeStatus, DEFAULT_BP_TARGET } from '../lib/bloodPressure';
import { useVaccineCaregivers } from '../lib/useVaccineCaregivers';

const TOOLS = [
  { to: '/health/medicines', favKey: 'medicine-tracker', icon: '💊', bg: 'bg-emerald-50', titleKey: 'medicine.tracker' },
  { to: '/health/glucose', favKey: 'glucose-tracker', icon: '🩸', bg: 'bg-red-50', titleKey: 'health.glucoseTracker' },
  { to: '/health/blood-pressure', favKey: 'bp-tracker', icon: '❤️', bg: 'bg-blue-50', titleKey: 'bp.tracker' },
  { to: '/baby-vaccinations', favKey: 'baby-vaccinations', icon: '👶', bg: 'bg-pink-50', titleKey: 'babyVax.tracker' },
];

const agoLabel = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return days <= 0 ? `today ${time}` : days === 1 ? `yesterday ${time}` : `${days} days ago`;
};

export default function Health() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const { t } = useLanguage();
  const todayStr = todayLocalDateString();

  // Everything below is small, own-data-only reads (one reading each, today's doses, pending vaccine doses).
  const [glucoseValue] = useCollection(user ? query(collection(db, 'glucoseLogs'), where('userId', '==', user.uid), orderBy('loggedAt', 'desc'), limit(1)) : null);
  const [bpValue] = useCollection(user ? query(collection(db, 'bloodPressureLogs'), where('userId', '==', user.uid), orderBy('loggedAt', 'desc'), limit(1)) : null);
  const [medsValue] = useCollection(user ? query(collection(db, 'medicines'), where('userId', '==', user.uid)) : null);
  const [dosesLogValue] = useCollection(user ? query(collection(db, 'medicineLogs'), where('userId', '==', user.uid), where('dateStr', '==', todayStr)) : null);
  const { profiles: babies } = useVaccineCaregivers(user?.uid);
  const babyIds = useMemo(() => babies.map((b: any) => b.id), [babies]);
  const [vaxDosesValue] = useCollection(babyIds.length > 0 ? query(collection(db, 'vaccineDoses'), where('profileId', 'in', babyIds.slice(0, 30)), where('status', '==', 'pending')) : null);

  const lastGlucose = glucoseValue?.docs[0]?.data() as any;
  const lastBp = bpValue?.docs[0]?.data() as any;

  const glucoseTone: Tone | null = lastGlucose
    ? isGlucoseInRange(lastGlucose.value, targetForWindow(profile?.healthTargets?.glucose || defaultGlucoseTargetMap(), glucoseWindowOf(lastGlucose))) ? 'ok' : 'warn'
    : null;
  const bpStatus = lastBp ? bpRangeStatus(lastBp.systolic, lastBp.diastolic, profile?.bpTargets || DEFAULT_BP_TARGET) : null;

  const dosesToday = useMemo(() => {
    const meds = (medsValue?.docs || []).map((d) => ({ id: d.id, ...(d.data() as any) } as Medicine)).filter((m) => m.active !== false && isMedicineDueOn(m, todayStr));
    const total = meds.reduce((n, m) => n + (m.times?.length || 0), 0);
    const done = dosesLogValue?.docs.length || 0;
    return { total, done: Math.min(done, total), hasMeds: (medsValue?.docs.length || 0) > 0 };
  }, [medsValue, dosesLogValue, todayStr]);

  // The soonest pending vaccine visit across the babies this person looks after.
  const nextVax = useMemo(() => {
    let best: { name: string; label: string; due: string } | null = null;
    (vaxDosesValue?.docs || []).forEach((d) => {
      const x = d.data() as any;
      if (!best || x.dueDate < best.due) best = { name: babies.find((b: any) => b.id === x.profileId)?.name || 'Baby', label: x.visitLabel, due: x.dueDate };
    });
    return best as { name: string; label: string; due: string } | null;
  }, [vaxDosesValue, babies]);
  const vaxDays = nextVax ? Math.round((new Date(nextVax.due + 'T00:00:00').getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86400000) : null;

  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  const left = dosesToday.total - dosesToday.done;

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-3 md:p-8 max-w-xl mx-auto w-full space-y-3 pb-24">
        <div>
          <h1 className="text-2xl font-black text-slate-900">{t('health.title')}</h1>
          <p className="text-[12px] font-semibold text-slate-500">{dateLabel}</p>
        </div>

        {dosesToday.hasMeds && (
          <button onClick={() => navigate('/health/medicines')} className="w-full text-left rounded-3xl p-4 text-white shadow-md flex items-center gap-3" style={{ background: 'linear-gradient(135deg,#0f766e,#0e4f5c)' }}>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-extrabold tracking-[0.12em] text-teal-100">TODAY'S MEDICINES</p>
              <p className="text-[26px] font-black leading-tight">{dosesToday.total === 0 ? 'None due' : left === 0 ? 'All done' : `${left} dose${left === 1 ? '' : 's'} left`}</p>
              <p className="text-[11px] font-bold text-teal-100">{dosesToday.total === 0 ? 'Nothing scheduled today' : `${dosesToday.done} of ${dosesToday.total} done · tap to log`}</p>
            </div>
            {dosesToday.total > 0 && <ProgressRing done={dosesToday.done} total={dosesToday.total} track="rgba(255,255,255,0.25)" color="#7ff0b5" />}
          </button>
        )}

        <div className="grid grid-cols-2 gap-2.5">
          <button onClick={() => navigate('/health/glucose')} className="text-left rounded-2xl bg-white border border-slate-200 p-3 shadow-sm">
            <p className="text-[9.5px] font-extrabold tracking-[0.1em] text-slate-400">🩸 GLUCOSE</p>
            {lastGlucose ? (
              <>
                <p className="text-[22px] font-black text-slate-900 leading-tight">{lastGlucose.value} <span className="text-[10px] font-bold text-slate-400">mg/dL</span></p>
                <div className="flex items-center gap-1.5 mt-0.5"><StatusChip tone={glucoseTone || 'mute'}>{glucoseTone === 'ok' ? 'in range' : 'out of range'}</StatusChip><span className="text-[9.5px] font-semibold text-slate-400">{agoLabel(lastGlucose.loggedAt)}</span></div>
              </>
            ) : <p className="text-[12px] font-bold text-slate-500 mt-1">No readings yet — add one</p>}
          </button>
          <button onClick={() => navigate('/health/blood-pressure')} className="text-left rounded-2xl bg-white border border-slate-200 p-3 shadow-sm">
            <p className="text-[9.5px] font-extrabold tracking-[0.1em] text-slate-400">❤️ BLOOD PRESSURE</p>
            {lastBp ? (
              <>
                <p className="text-[22px] font-black text-slate-900 leading-tight">{lastBp.systolic}/{lastBp.diastolic}</p>
                <div className="flex items-center gap-1.5 mt-0.5"><StatusChip tone={bpStatus === 'inRange' ? 'ok' : 'warn'}>{bpStatus === 'inRange' ? 'normal' : bpStatus}</StatusChip><span className="text-[9.5px] font-semibold text-slate-400">{agoLabel(lastBp.loggedAt)}</span></div>
              </>
            ) : <p className="text-[12px] font-bold text-slate-500 mt-1">No readings yet — add one</p>}
          </button>
        </div>

        {nextVax && vaxDays !== null && vaxDays <= 30 && (
          <button onClick={() => navigate('/baby-vaccinations')} className={`w-full text-left rounded-2xl p-3 flex items-center gap-3 ${vaxDays < 0 ? 'bg-red-50 border border-red-200' : 'bg-blue-50 border border-blue-200'}`}>
            <span className="text-xl">💉</span>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-black text-slate-900">{nextVax.name}'s {nextVax.label} {vaxDays < 0 ? `is ${-vaxDays} day${vaxDays === -1 ? '' : 's'} overdue` : vaxDays === 0 ? 'is due today' : `is due in ${vaxDays} day${vaxDays === 1 ? '' : 's'}`}</p>
              <p className="text-[10.5px] font-semibold text-slate-500">Tap to plan the visit</p>
            </div>
            <span className="material-symbols-outlined text-slate-400">chevron_right</span>
          </button>
        )}

        <div className="rounded-3xl bg-white border border-slate-200 shadow-sm divide-y divide-slate-100 overflow-hidden">
          {TOOLS.map((tool) => (
            <div key={tool.to} onClick={() => navigate(tool.to)} className="p-3.5 flex items-center gap-3 cursor-pointer active:bg-slate-50">
              <div className={`w-11 h-11 rounded-2xl ${tool.bg} flex items-center justify-center text-xl shrink-0`}>{tool.icon}</div>
              <p className="flex-1 text-[13.5px] font-black text-slate-900">{t(tool.titleKey)}</p>
              <FavoriteButton itemKey={tool.favKey} />
              <span className="material-symbols-outlined text-slate-300">chevron_right</span>
            </div>
          ))}
        </div>

        <button onClick={() => navigate('/health/care-circle')} className="w-full rounded-2xl bg-teal-50 border border-teal-100 p-3.5 flex items-center gap-3 text-left">
          <span className="w-11 h-11 rounded-2xl bg-white flex items-center justify-center text-xl shrink-0">👨‍👩‍👧</span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-black text-slate-900">Care circle</p>
            <p className="text-[10.5px] font-semibold text-slate-500">Who can help with your health — and whose you help with</p>
          </div>
          <span className="material-symbols-outlined text-teal-700">chevron_right</span>
        </button>
      </main>
    </div>
  );
}
