import React, { useState } from 'react';
import { KIND_STYLE, kindOf } from '../lib/groupKindStyle';

// A group chooser that shows each group's type (Monthly / Event / Payments) as a coloured badge in front of its name, the same
// colours the Dashboard uses. A native <select> cannot show badges, so this is a button that opens a full-screen list.
export const KindBadge: React.FC<{ group: any }> = ({ group }) => {
  const k = KIND_STYLE[kindOf(group)];
  return (
    <span className="shrink-0 text-[9px] font-black uppercase tracking-wider rounded-full px-1.5 py-0.5 leading-none" style={{ background: k.tint, color: k.dark, border: `1px solid ${k.acc}` }}>
      {k.label}
    </span>
  );
};

export const GroupPicker: React.FC<{ groups: any[]; value: string; onChange: (id: string) => void }> = ({ groups, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const current = groups.find((g) => g.id === value);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full h-12 bg-surface pl-3 pr-8 rounded-xl border border-border-subtle font-bold text-primary text-left outline-none flex items-center gap-2 min-w-0"
      >
        {current && <KindBadge group={current} />}
        <span className="truncate">{current?.name || 'Select group'}</span>
      </button>
      <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-text-muted text-lg pointer-events-none">expand_more</span>
      {open && (
        <div className="fixed inset-0 z-[400] bg-black/50 flex items-end sm:items-center justify-center" onClick={() => setOpen(false)}>
          <div className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl max-h-[75vh] overflow-y-auto pb-4" onClick={(e) => e.stopPropagation()}>
            <p className="px-5 pt-4 pb-2 text-xs font-black uppercase tracking-wider text-text-muted">Choose group</p>
            {groups.map((g) => {
              const selected = g.id === value;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => { onChange(g.id); setOpen(false); }}
                  className="w-full flex items-center gap-3 px-5 py-3.5 border-t border-border-subtle text-left"
                >
                  <KindBadge group={g} />
                  <span className="flex-1 min-w-0 truncate text-base font-bold text-primary">{g.name}</span>
                  <span className="material-symbols-outlined text-xl" style={{ color: selected ? KIND_STYLE[kindOf(g)].acc : '#9ca3af' }}>
                    {selected ? 'radio_button_checked' : 'radio_button_unchecked'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};
