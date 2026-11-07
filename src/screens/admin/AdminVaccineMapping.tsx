import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminGet, adminPost } from '../../lib/adminApi';
import { vaccineNamesMatch } from '../../lib/vaccinations';
import DetailSheet from '../../components/DetailSheet';

interface Entry { shotName: string; brand: string; vaccines: string[] }
interface UsedShot { name: string; brand: string; count: number }
interface UsedVaccine { name: string; count: number }
interface Check { shotName: string; brand: string; verdict: 'ok' | 'fix' | 'unsure'; suggestedVaccines: string[]; note: string }

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const entryKey = (e: { shotName: string; brand: string }) => `${e.shotName}|${e.brand}`.toLowerCase();

const nameMatches = vaccineNamesMatch;

const VERDICT_STYLE: Record<Check['verdict'], { label: string; icon: string; cls: string }> = {
  ok: { label: 'Looks right', icon: 'check_circle', cls: 'bg-green-50 text-green-700' },
  fix: { label: 'Needs a fix', icon: 'error', cls: 'bg-amber-50 text-amber-700' },
  unsure: { label: 'Not sure', icon: 'help', cls: 'bg-surface-container text-text-muted' },
};

export default function AdminVaccineMapping() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [saved, setSaved] = useState('[]');
  const [usedShots, setUsedShots] = useState<UsedShot[]>([]);
  const [usedVaccines, setUsedVaccines] = useState<UsedVaccine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'mapped' | 'unmapped'>('mapped');
  const [editing, setEditing] = useState<{ index: number | null; draft: Entry } | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [checkedBy, setCheckedBy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    adminGet('/api/admin/vaccine-mapping')
      .then((data) => {
        setEntries(data.entries);
        setSaved(JSON.stringify(data.entries));
        setUsedShots(data.usedShots);
        setUsedVaccines(data.usedVaccines);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const flash = (text: string) => { setToast(text); setTimeout(() => setToast(null), 2500); };
  const dirty = JSON.stringify(entries) !== saved;

  // shots people typed that no mapping row matches (by shot name or brand)
  const unmappedShots = useMemo(
    () => usedShots.filter((s) => !entries.some((e) => same(e.shotName, s.name) || (s.brand && same(e.brand, s.brand)) || same(e.brand, s.name))),
    [usedShots, entries],
  );
  // vaccines in use that no shot covers, so they can never be ticked by picking a shot
  const uncoveredVaccines = useMemo(
    () => usedVaccines.filter((v) => !entries.some((e) => e.vaccines.some((c) => nameMatches(c, v.name)))),
    [usedVaccines, entries],
  );
  const vaccineChoices = useMemo(() => {
    const names = new Map<string, string>();
    usedVaccines.forEach((v) => names.set(v.name.toLowerCase(), v.name));
    entries.forEach((e) => e.vaccines.forEach((v) => { if (!names.has(v.toLowerCase())) names.set(v.toLowerCase(), v); }));
    editing?.draft.vaccines.forEach((v) => { if (!names.has(v.toLowerCase())) names.set(v.toLowerCase(), v); });
    return [...names.values()];
  }, [usedVaccines, entries, editing]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await adminPost('/api/admin/vaccine-mapping', { entries });
      setEntries(data.entries);
      setSaved(JSON.stringify(data.entries));
      flash('Saved. Everyone sees it now.');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    try {
      const data = await adminPost('/api/admin/vaccine-mapping/verify', { entries, vaccineNames: vaccineChoices });
      const map: Record<string, Check> = {};
      (data.results as Check[]).forEach((r) => { map[entryKey(r)] = r; });
      setChecks(map);
      setCheckedBy(data.model);
      setTab('mapped');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setChecking(false);
    }
  };

  const applySuggestion = (entry: Entry, c: Check) => {
    setEntries((list) => list.map((e) => (entryKey(e) === entryKey(entry) ? { ...e, vaccines: c.suggestedVaccines } : e)));
    setChecks((m) => { const next = { ...m }; delete next[entryKey(entry)]; return next; });
  };

  const commitEdit = () => {
    if (!editing) return;
    const draft: Entry = { shotName: editing.draft.shotName.trim(), brand: editing.draft.brand.trim(), vaccines: editing.draft.vaccines };
    if (!draft.shotName) { alert('Give the shot a name.'); return; }
    if (draft.vaccines.length === 0) { alert('Choose at least one vaccine this shot covers.'); return; }
    if (entries.some((e, i) => i !== editing.index && entryKey(e) === entryKey(draft))) { alert('A shot with this name and brand is already mapped.'); return; }
    setEntries((list) => (editing.index === null ? [...list, draft] : list.map((e, i) => (i === editing.index ? draft : e))));
    setEditing(null);
  };

  const removeEdit = () => {
    if (!editing || editing.index === null) return;
    if (!window.confirm(`Remove "${editing.draft.shotName}" from the mapping?`)) return;
    setEntries((list) => list.filter((_, i) => i !== editing.index));
    setEditing(null);
  };

  const [extra, setExtra] = useState('');
  const toggleVaccine = (name: string) => {
    setEditing((ed) => {
      if (!ed) return ed;
      const has = ed.draft.vaccines.some((v) => same(v, name));
      return { ...ed, draft: { ...ed.draft, vaccines: has ? ed.draft.vaccines.filter((v) => !same(v, name)) : [...ed.draft.vaccines, name] } };
    });
  };
  const addExtra = () => {
    const name = extra.trim();
    if (!name) return;
    setEditing((ed) => (ed && !ed.draft.vaccines.some((v) => same(v, name)) ? { ...ed, draft: { ...ed.draft, vaccines: [...ed.draft.vaccines, name] } } : ed));
    setExtra('');
  };

  const sorted = useMemo(() => entries.map((e, index) => ({ e, index })).sort((a, b) => a.e.shotName.localeCompare(b.e.shotName)), [entries]);

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-4 pb-28 md:pb-28">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-black text-primary">Vaccine Mapping</h1>
        <Link to="/admin?tab=support" className="text-sm font-bold text-primary underline">Back to Admin</Link>
      </div>
      <p className="text-xs text-text-muted">Each shot (a product like Easysix) and the vaccines it covers. When a parent picks the shot while logging a visit, these vaccines are ticked off together.</p>

      {error && <p className="text-sm font-bold text-error">{error}</p>}
      {loading && <p className="text-sm text-text-muted">Loading…</p>}

      {!loading && !error && (
        <>
          <div className="flex gap-2">
            {([['mapped', `Mapped (${entries.length})`], ['unmapped', `Not mapped (${unmappedShots.length})`]] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex-1 py-2 rounded-xl text-xs font-black ${tab === id ? 'bg-primary text-white' : 'bg-white border border-border-subtle text-text-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => { setExtra(''); setEditing({ index: null, draft: { shotName: '', brand: '', vaccines: [] } }); }}
              className="flex-1 py-2.5 rounded-xl bg-white border border-border-subtle text-primary text-xs font-black flex items-center justify-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>Add a shot
            </button>
            <button
              onClick={handleCheck}
              disabled={checking || entries.length === 0}
              className="flex-1 py-2.5 rounded-xl bg-white border border-border-subtle text-primary text-xs font-black flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[18px]">auto_awesome</span>{checking ? 'Checking…' : 'Check with AI'}
            </button>
          </div>
          {checkedBy && <p className="text-[11px] text-text-muted">Checked by {checkedBy}. It only advises; nothing changes until you apply it and save.</p>}

          {tab === 'mapped' && (
            <div className="space-y-2">
              {sorted.map(({ e, index }) => {
                const c = checks[entryKey(e)];
                return (
                  <div key={entryKey(e)} className="bg-white border border-border-subtle rounded-2xl p-3.5 space-y-2">
                    <button
                      onClick={() => { setExtra(''); setEditing({ index, draft: { ...e, vaccines: [...e.vaccines] } }); }}
                      className="w-full text-left"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-primary truncate">{e.shotName}</p>
                          {e.brand && <p className="text-[11px] text-text-muted truncate">{e.brand}</p>}
                        </div>
                        <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">edit</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {e.vaccines.length === 0 && <span className="text-[11px] font-bold text-error">No vaccines chosen</span>}
                        {e.vaccines.map((v) => (
                          <span key={v} className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-bold">{v}</span>
                        ))}
                      </div>
                    </button>
                    {c && (
                      <div className={`rounded-xl px-3 py-2 text-[11px] ${VERDICT_STYLE[c.verdict].cls}`}>
                        <p className="font-black flex items-center gap-1">
                          <span className="material-symbols-outlined text-[14px]">{VERDICT_STYLE[c.verdict].icon}</span>{VERDICT_STYLE[c.verdict].label}
                        </p>
                        <p className="mt-0.5">{c.note}</p>
                        {c.verdict === 'fix' && c.suggestedVaccines.length > 0 && (
                          <>
                            <p className="mt-1 font-bold">Suggested: {c.suggestedVaccines.join(', ')}</p>
                            <button onClick={() => applySuggestion(e, c)} className="mt-1.5 px-3 py-1 rounded-lg bg-white text-primary font-black">Use this list</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {entries.length === 0 && <p className="text-center text-text-muted py-8 text-sm">Nothing mapped yet. Add a shot, or map one from the Not mapped tab.</p>}
            </div>
          )}

          {tab === 'unmapped' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Shots parents used that have no mapping</p>
                {unmappedShots.map((s) => (
                  <div key={`${s.name}|${s.brand}`} className="bg-white border border-border-subtle rounded-2xl p-3.5 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-black text-primary truncate">{s.name}</p>
                      <p className="text-[11px] text-text-muted truncate">{s.brand ? `${s.brand} · ` : ''}used {s.count} {s.count === 1 ? 'time' : 'times'}</p>
                    </div>
                    <button
                      onClick={() => { setExtra(''); setEditing({ index: null, draft: { shotName: s.name, brand: s.brand, vaccines: [] } }); }}
                      className="px-3.5 py-2 rounded-xl bg-primary text-white text-xs font-black shrink-0"
                    >
                      Map it
                    </button>
                  </div>
                ))}
                {unmappedShots.length === 0 && <p className="text-center text-text-muted py-4 text-sm">Every shot parents have used is mapped.</p>}
              </div>

              <div className="space-y-2">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Vaccines no shot covers yet</p>
                <div className="bg-white border border-border-subtle rounded-2xl p-3.5">
                  {uncoveredVaccines.length === 0 ? (
                    <p className="text-sm text-text-muted">Every vaccine in use is covered by at least one shot.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {uncoveredVaccines.map((v) => (
                        <span key={v.name} className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] font-bold">{v.name} · {v.count}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {dirty && (
        <div className="fixed left-0 right-0 z-[90] px-4" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 0.75rem)' }}>
          <div className="max-w-3xl mx-auto bg-primary text-white rounded-2xl shadow-2xl p-2 pl-4 flex items-center gap-2">
            <p className="flex-1 text-xs font-bold">You have unsaved changes</p>
            <button onClick={() => { setEntries(JSON.parse(saved)); setChecks({}); }} className="px-3 py-2 rounded-xl text-xs font-black text-white/80">Discard</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-xl bg-white text-primary text-xs font-black disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed left-0 right-0 flex justify-center z-[95] pointer-events-none" style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom) + 5rem)' }}>
          <div className="bg-slate-900 text-white text-xs font-bold px-4 py-2 rounded-full shadow-xl">{toast}</div>
        </div>
      )}

      {editing && (
        <DetailSheet
          aboveNav
          title={editing.index === null ? 'Map a shot' : 'Edit shot'}
          onClose={() => setEditing(null)}
          onDone={commitEdit}
          doneLabel="Done"
          onDelete={editing.index !== null ? removeEdit : undefined}
          deleteInHeader
        >
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Shot name</label>
            <input
              value={editing.draft.shotName}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, shotName: e.target.value } })}
              placeholder="e.g. Easysix"
              maxLength={80}
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Brand (optional)</label>
            <input
              value={editing.draft.brand}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, brand: e.target.value } })}
              placeholder="e.g. Panacea Biotec"
              maxLength={80}
              className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">Vaccines it covers ({editing.draft.vaccines.length})</label>
            <div className="flex flex-wrap gap-1.5">
              {vaccineChoices.map((v) => {
                const on = editing.draft.vaccines.some((x) => same(x, v));
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => toggleVaccine(v)}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold border ${on ? 'bg-primary text-white border-primary' : 'bg-white text-text-muted border-border-subtle'}`}
                  >
                    {on && <span className="material-symbols-outlined text-[12px] align-middle mr-0.5">check</span>}{v}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <input
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } }}
                placeholder="Another vaccine name"
                maxLength={60}
                className="flex-1 min-w-0 bg-surface p-2.5 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button type="button" onClick={addExtra} className="px-4 rounded-xl bg-surface-container text-primary text-xs font-black">Add</button>
            </div>
          </div>
        </DetailSheet>
      )}
    </div>
  );
}
