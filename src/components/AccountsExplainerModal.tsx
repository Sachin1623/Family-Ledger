import { useLanguage } from '../context/LanguageContext';

// "What are Accounts for?" — originally GoalsHub.tsx's own `showAccountsHelp` modal (its help-icon
// button still opens this), extracted here so the new-user onboarding chain can show the exact
// same explainer right before the guided Add Account flow (see OnboardingTour.tsx's
// 'group-explore' finish handler and AccountsHub.tsx's `onboarding=1` chain marker) without
// duplicating the copy or the markup.
export default function AccountsExplainerModal({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-2xl">account_balance</span>
          <h3 className="text-base font-black text-primary">{t('goals.accountsHelpTitle')}</h3>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.accountsHelpWhatTitle')}</p>
          <p className="text-sm text-on-surface leading-relaxed">{t('goals.accountsHelpWhatBody')}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.accountsHelpBenefitTitle')}</p>
          <p className="text-sm text-on-surface leading-relaxed">{t('goals.accountsHelpBenefitBody')}</p>
        </div>
        <button onClick={onClose} className="w-full py-3 bg-primary text-white font-bold rounded-xl">
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
