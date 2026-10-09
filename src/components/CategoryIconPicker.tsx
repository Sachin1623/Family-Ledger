import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../context/LanguageContext';

const ICON_CHOICES: string[] = [
  '🏷️', '🧾', '💰', '💵', '💳', '🏦', '📈', '💼', '🎁', '🔄',
  '🏠', '🔑', '🛋️', '🧹', '🔧', '💡', '🚰', '📶', '📱', '💻',
  '🍽️', '🍕', '🍔', '☕', '🍺', '🛒', '🥦', '🍎', '🥛', '🍰',
  '🚗', '⛽', '🚌', '🚆', '✈️', '🏍️', '🚕', '🅿️', '🧳', '🏖️',
  '👕', '👟', '💄', '💇', '🛍️', '⌚', '👜', '🧴', '🪒', '🧼',
  '💊', '🩺', '🏥', '🦷', '👓', '🏋️', '🧘', '🩹', '🐶', '🐱',
  '👶', '🍼', '🧸', '🎒', '📚', '🎓', '✏️', '🎨', '🎮', '🎬',
  '🎵', '🎉', '🎂', '🎟️', '⚽', '🏏', '🎲', '📷', '🛠️', '🌱',
  '📞', '✉️', '🏛️', '🧑‍🤝‍🧑', '🙏', '❤️', '⭐', '🔔', '🧰', '✨',
];

// A tap-to-pick emoji chooser for a custom category's icon — replaces a bare text box where the
// person had to know to open their phone's emoji keyboard (and where typing anything else, like a
// letter, would be saved as the "icon"). Renders through a portal so the sheet isn't clipped by, or
// mispositioned inside, a scrolling/transformed modal like Manage Categories.
export default function CategoryIconPicker({
  value,
  onChange,
  className = '',
}: {
  value: string;
  onChange: (icon: string) => void;
  className?: string;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('category.chooseIcon')}
        className={`w-10 h-8 flex items-center justify-center rounded-lg border border-border-subtle bg-white text-base shrink-0 active:scale-95 transition-all ${className}`}
      >
        {value || '🏷️'}
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative w-full max-w-sm bg-white rounded-t-3xl sm:rounded-3xl p-4 pb-6 shadow-2xl max-h-[70vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-bold text-primary">{t('category.chooseIcon')}</p>
              <button type="button" onClick={() => setOpen(false)} className="p-1.5 rounded-full hover:bg-surface">
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <div className="grid grid-cols-8 gap-1">
              {ICON_CHOICES.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => { onChange(icon); setOpen(false); }}
                  className={`h-10 flex items-center justify-center rounded-lg text-xl active:scale-90 transition-all ${icon === value ? 'bg-primary/15 ring-2 ring-primary' : 'hover:bg-surface'}`}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
