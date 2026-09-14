import { useLanguage } from '../context/LanguageContext';
import { openPermissionSettings, PermissionKey } from '../lib/appPermissions';

// Shared "here's what's missing, here's an Enable button per one" rows — used by both
// AppPermissionsReminder.tsx (the auto-popup that appears on its own) and Header.tsx's
// always-available "App Permissions" menu entry, so the two surfaces never drift apart.
export default function MissingPermissionsList({
  missing,
  onEnable,
}: {
  missing: PermissionKey[];
  onEnable?: (key: PermissionKey) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="space-y-2">
      {missing.map((key) => (
        <div key={key} className="flex items-center justify-between gap-3 bg-surface rounded-2xl p-3 border border-border-subtle">
          <div className="min-w-0">
            <p className="text-sm font-bold text-on-surface">{t(`permissions.${key}`)}</p>
            <p className="text-[11px] text-text-muted">{t(`permissions.${key}Why`)}</p>
          </div>
          <button
            type="button"
            onClick={() => { openPermissionSettings(key); onEnable?.(key); }}
            className="shrink-0 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-bold active:scale-95 transition-all"
          >
            {t('permissions.enable')}
          </button>
        </div>
      ))}
    </div>
  );
}
