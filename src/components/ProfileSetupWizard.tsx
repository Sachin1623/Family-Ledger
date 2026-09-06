import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { CURRENCY_SYMBOLS, COUNTRIES, NUMBER_SYSTEMS, NumberSystem } from '../lib/constants';

// A 6-step guided setup for a genuinely brand-new account: display name -> currency -> country ->
// number format -> date of birth -> hand off into Create Group. Mounted once, globally, in
// App.tsx (same idiom as OnboardingTour.tsx) so it survives navigation; gated on
// `hasCompletedProfileSetup === false` (set explicitly `false` at account creation in
// AuthContext.tsx, same pattern as `hasSeenOnboarding`) so it only ever auto-launches for a
// first-time login, not an established user whose doc predates this field. Runs BEFORE the
// dashboard spotlight tour — see OnboardingTour.tsx's own auto-launch condition, which now waits
// on this field too, so a new user never sees both overlays at once.
//
// Unlike OnboardingTour (a read-only spotlight over existing UI), this actually collects data and
// writes it through the exact same Firestore paths Profile.tsx's own name/currency/country/
// number-format/DOB editors use, so opening Profile afterward shows the same values with no
// separate sync step.
const MAX_DOB = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d.toISOString().split('T')[0];
})();

const TOTAL_STEPS = 6;

export default function ProfileSetupWizard() {
  const { user, profile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [active, setActive] = useState(false);

  const [nameInput, setNameInput] = useState('');
  const [currencyInput, setCurrencyInput] = useState<string | null>(null);
  const [countryInput, setCountryInput] = useState<string | null>(null);
  const [numberSystemInput, setNumberSystemInput] = useState<NumberSystem | null>(null);
  const [dobInput, setDobInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-launches only on landing at '/' (same route OnboardingTour watches) for a profile that
  // explicitly hasn't completed this yet — re-evaluates on every profile/route change so it picks
  // up the moment a brand-new account's doc finishes being created.
  useEffect(() => {
    if (!user || !profile || active) return;
    if (location.pathname === '/' && profile.hasCompletedProfileSetup === false) {
      setNameInput(profile.displayName && profile.displayName !== 'User' ? profile.displayName : '');
      setCurrencyInput(profile.currency || null);
      setCountryInput(profile.country || null);
      setNumberSystemInput(profile.numberSystem || null);
      setDobInput(profile.dateOfBirth || '');
      setStep(0);
      setActive(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, profile, location.pathname]);

  const finishSetup = async () => {
    if (!user) return;
    setActive(false);
    try {
      await updateDoc(doc(db, 'users', user.uid), { hasCompletedProfileSetup: true });
    } catch (err) {
      console.error('Failed to save profile-setup completion:', err);
    }
  };

  const handleSaveName = async () => {
    if (!user || !nameInput.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'users', user.uid), { displayName: nameInput.trim() });
      setStep(1);
    } catch (err) {
      console.error('Failed to save display name:', err);
      setError("Couldn't save that — try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCurrency = async () => {
    if (!user || !currencyInput || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'users', user.uid, 'private', 'info'), {
        currency: currencyInput,
        updatedAt: new Date().toISOString(),
      });
      setStep(2);
    } catch (err) {
      console.error('Failed to save currency:', err);
      setError("Couldn't save that — try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCountry = async () => {
    if (!user || !countryInput || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'users', user.uid, 'private', 'info'), {
        country: countryInput,
        updatedAt: new Date().toISOString(),
      });
      setStep(3);
    } catch (err) {
      console.error('Failed to save country:', err);
      setError("Couldn't save that — try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveNumberSystem = async () => {
    if (!user || !numberSystemInput || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'users', user.uid, 'private', 'info'), {
        numberSystem: numberSystemInput,
        updatedAt: new Date().toISOString(),
      });
      setStep(4);
    } catch (err) {
      console.error('Failed to save number format:', err);
      setError("Couldn't save that — try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDob = async () => {
    if (!user || !dobInput || saving) return;
    if (dobInput > MAX_DOB) {
      setError('Enter a valid date of birth — not in the future, and at least 3 years ago.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'users', user.uid, 'private', 'info'), {
        dateOfBirth: dobInput,
        updatedAt: new Date().toISOString(),
      });
      setStep(5);
    } catch (err) {
      console.error('Failed to save date of birth:', err);
      setError("Couldn't save that — try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!active) return null;

  return (
    <div className="fixed inset-0 z-[260] flex items-center justify-center p-4 bg-black/65">
      <div className="bg-white w-full max-w-sm rounded-3xl p-6 space-y-5 shadow-2xl">
        <div className="flex items-center gap-1.5">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div key={i} className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-surface-container'}`} />
          ))}
        </div>

        {step === 0 && (
          <div className="space-y-4">
            <div>
              <span className="text-3xl block mb-2">👋</span>
              <h2 className="text-lg font-black text-primary">Welcome to FamilyLedger!</h2>
              <p className="text-sm text-text-muted mt-1">Let's get your account set up — first, what should we call you?</p>
            </div>
            <input
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
              placeholder="Your name"
              className="w-full h-12 px-4 rounded-xl border border-border-subtle text-sm font-bold outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
            {error && <p className="text-xs text-error font-bold">{error}</p>}
            <button
              type="button"
              onClick={handleSaveName}
              disabled={!nameInput.trim() || saving}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Next'}
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <span className="text-3xl block mb-2">💱</span>
              <h2 className="text-lg font-black text-primary">Pick your currency</h2>
              <p className="text-sm text-text-muted mt-1">Used to total up amounts across your groups.</p>
            </div>
            <div className="grid grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
              {Object.keys(CURRENCY_SYMBOLS).map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => setCurrencyInput(code)}
                  className={`py-2.5 rounded-xl border text-xs font-bold transition-all ${
                    currencyInput === code ? 'bg-primary text-white border-primary' : 'bg-surface border-border-subtle text-on-surface hover:bg-surface-container'
                  }`}
                >
                  {CURRENCY_SYMBOLS[code]} {code}
                </button>
              ))}
            </div>
            {error && <p className="text-xs text-error font-bold">{error}</p>}
            <button
              type="button"
              onClick={handleSaveCurrency}
              disabled={!currencyInput || saving}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Next'}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <span className="text-3xl block mb-2">🌍</span>
              <h2 className="text-lg font-black text-primary">Where are you based?</h2>
              <p className="text-sm text-text-muted mt-1">Just for your profile — you can change this anytime.</p>
            </div>
            <div className="grid grid-cols-2 gap-1.5 max-h-56 overflow-y-auto pr-1">
              {COUNTRIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCountryInput(c)}
                  className={`px-3 py-2.5 rounded-xl border text-left text-xs font-bold transition-all truncate ${
                    countryInput === c ? 'bg-primary text-white border-primary' : 'bg-surface border-border-subtle text-on-surface hover:bg-surface-container'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            {error && <p className="text-xs text-error font-bold">{error}</p>}
            <button
              type="button"
              onClick={handleSaveCountry}
              disabled={!countryInput || saving}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Next'}
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <span className="text-3xl block mb-2">🔢</span>
              <h2 className="text-lg font-black text-primary">How should large amounts show?</h2>
              <p className="text-sm text-text-muted mt-1">Used to abbreviate big numbers across the app.</p>
            </div>
            <div className="space-y-2">
              {NUMBER_SYSTEMS.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setNumberSystemInput(n.id)}
                  className={`w-full px-4 py-3 rounded-xl border text-left transition-all flex items-center justify-between gap-2 ${
                    numberSystemInput === n.id ? 'bg-primary text-white border-primary' : 'bg-surface border-border-subtle text-on-surface hover:bg-surface-container'
                  }`}
                >
                  <span className="text-sm font-bold">{n.label}</span>
                  <span className={`text-sm font-black ${numberSystemInput === n.id ? 'text-white/80' : 'text-text-muted'}`}>{n.example}</span>
                </button>
              ))}
            </div>
            {error && <p className="text-xs text-error font-bold">{error}</p>}
            <button
              type="button"
              onClick={handleSaveNumberSystem}
              disabled={!numberSystemInput || saving}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Next'}
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div>
              <span className="text-3xl block mb-2">🎂</span>
              <h2 className="text-lg font-black text-primary">When's your birthday?</h2>
              <p className="text-sm text-text-muted mt-1">Just for your profile — you can change this anytime.</p>
            </div>
            <input
              type="date"
              value={dobInput}
              max={MAX_DOB}
              onChange={(e) => setDobInput(e.target.value)}
              className="w-full h-12 px-4 rounded-xl border border-border-subtle text-sm font-bold outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
            {error && <p className="text-xs text-error font-bold">{error}</p>}
            <button
              type="button"
              onClick={handleSaveDob}
              disabled={!dobInput || saving}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Next'}
            </button>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4 text-center">
            <span className="text-4xl block">🎉</span>
            <div>
              <h2 className="text-lg font-black text-primary">You're all set!</h2>
              <p className="text-sm text-text-muted mt-1">Last step — create a group to start tracking expenses or income with family, roommates, or friends.</p>
            </div>
            <button
              type="button"
              onClick={() => { finishSetup(); navigate('/create-group'); }}
              className="w-full py-3 bg-primary text-white font-bold rounded-xl flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-[18px]">group_add</span>
              Create your first group
            </button>
            <button type="button" onClick={finishSetup} className="w-full py-2 text-xs font-bold text-text-muted">
              I'll do this later
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
