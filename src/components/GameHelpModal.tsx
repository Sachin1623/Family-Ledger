import React from 'react';

export interface GameHelpSection {
  heading: string;
  body: string[]; // one paragraph or bullet per entry — rendered as a <p>
}

export interface GameHelpContent {
  title: string;
  sections: GameHelpSection[];
}

// Shared help/rules modal for every game — matches the visual language already established by
// each game's own end-of-game overlays (bg-black/60 backdrop-blur-sm, bg-white rounded-3xl
// shadow-2xl), not the app-wide ExpenseQuickView modal, so it feels native to the games screens.
export const GameHelpModal: React.FC<{ content: GameHelpContent; onClose: () => void }> = ({ content, onClose }) => {
  return (
    <div className="fixed inset-0 z-[280] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden">
        <div className="p-4 border-b border-border-subtle flex items-center justify-between shrink-0">
          <h2 className="text-base font-black text-primary">{content.title}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-surface rounded-full text-text-muted">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {content.sections.map((s, i) => (
            <div key={i} className="space-y-1">
              <p className="text-xs font-bold text-primary uppercase tracking-wider">{s.heading}</p>
              {s.body.map((p, j) => (
                <p key={j} className="text-sm text-on-surface leading-relaxed">{p}</p>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Bare icon (no pill/circle background) so it reads as a plain header control rather than a
// colored button — matches the "only icons" treatment used for every game's header actions.
export const HelpButton: React.FC<{ onClick: () => void; className?: string }> = ({ onClick, className }) => (
  <button
    onClick={onClick}
    className={`p-2 text-primary shrink-0 ${className || ''}`}
    aria-label="Help & rules"
  >
    <span className="material-symbols-outlined text-[22px] block">help</span>
  </button>
);
