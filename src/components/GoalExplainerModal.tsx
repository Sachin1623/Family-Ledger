import { useLanguage } from '../context/LanguageContext';

// "What is a Goal?" — the goal-side counterpart to AccountsExplainerModal.tsx, same visual
// structure (title/What-it-does/Why-it-helps). Shown once, right before the guided Create Goal
// flow, as part of the new-user onboarding chain (see OnboardingTour.tsx's 'group-explore' finish
// handler and GoalWizard.tsx's `onboarding=1` chain marker).
export default function GoalExplainerModal({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-2xl">flag</span>
          <h3 className="text-base font-black text-primary">{t('goals.goalHelpTitle')}</h3>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.goalHelpWhatTitle')}</p>
          <p className="text-sm text-on-surface leading-relaxed">{t('goals.goalHelpWhatBody')}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-text-muted uppercase tracking-wider">{t('goals.goalHelpBenefitTitle')}</p>
          <p className="text-sm text-on-surface leading-relaxed">{t('goals.goalHelpBenefitBody')}</p>
        </div>
        <button onClick={onClose} className="w-full py-3 bg-primary text-white font-bold rounded-xl">
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}
