import { clsx } from 'clsx';
import { useLanguage } from '../context/LanguageContext';
import type { SharePicker } from '../lib/useSharePicker';

// Renders the group/family/friend share picker driven by a useSharePicker() instance — the same
// JSX GoalWizard.tsx and AccountsHub.tsx each hand-roll inline, factored out here so a third
// feature (Policy Vault) doesn't become a third copy-paste. `shareWithDesc` is passed in rather
// than hardcoded since each feature's own explanation of what View/Edit means differs (goals: "see
// progress only" / "can also add funds"; policies: "see policy details" / "can also update it").
export default function SharePickerFields({ picker, groups, shareWithDesc }: { picker: SharePicker; groups: { id: string; name: string }[]; shareWithDesc: string }) {
  const { t } = useLanguage();
  const {
    shareGroupId, setShareGroupId, shareGroupRole, setShareGroupRole,
    shareFriendUids, friendSearch, setFriendSearch,
    myFamilies, membersByFamilyId, acceptedFriends, friendUsersByUid,
    isFamilyFullySelected, toggleFamily, toggleFriend, setFriendRole, filteredFriends,
  } = picker;

  return (
    <div className="space-y-1.5 pt-1 border-t border-border-subtle">
      <label className="text-[10px] font-bold text-text-muted px-1 uppercase tracking-wider">{t('goals.shareWith')}</label>
      <p className="text-[11px] text-text-muted px-1">{shareWithDesc}</p>
      <select
        value={shareGroupId || ''}
        onChange={(e) => setShareGroupId(e.target.value || null)}
        className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm font-bold text-primary outline-none"
      >
        <option value="">{t('goals.noGroupShare')}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
      {shareGroupId && (
        <div className="flex bg-surface rounded-lg border border-border-subtle p-0.5 gap-0.5">
          {(['view', 'edit'] as const).map((role) => (
            <button
              key={role} type="button" onClick={() => setShareGroupRole(role)}
              className={clsx('flex-1 py-1.5 rounded-md text-[10px] font-bold transition-all', shareGroupRole === role ? 'bg-primary text-white' : 'text-text-muted')}
            >
              {t(role === 'view' ? 'goals.shareRoleView' : 'goals.shareRoleEdit')}
            </button>
          ))}
        </div>
      )}
      {myFamilies.length > 0 && (
        <div className="space-y-1">
          {myFamilies.map((fam: any) => {
            const members = membersByFamilyId.get(fam.id) || [];
            const selected = isFamilyFullySelected(fam.id);
            return (
              <button
                key={fam.id} type="button" onClick={() => toggleFamily(fam.id)}
                className={clsx('w-full flex items-center justify-between px-2.5 py-2 rounded-lg border text-left transition-all', selected ? 'bg-primary/5 border-primary' : 'bg-white border-border-subtle')}
              >
                <span className="text-xs font-bold flex items-center gap-1.5">
                  <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                    {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                  </span>
                  {fam.name}
                </span>
                <span className="text-[10px] font-bold text-text-muted shrink-0">{members.length}</span>
              </button>
            );
          })}
        </div>
      )}
      {acceptedFriends.length > 0 && (
        <div className="space-y-1">
          <input
            type="text" value={friendSearch} onChange={(e) => setFriendSearch(e.target.value)} placeholder={t('health.searchFriends')}
            className="w-full bg-surface border border-border-subtle rounded-lg px-3 py-1.5 text-xs outline-none"
          />
          <div className="max-h-32 overflow-y-auto rounded-lg border border-border-subtle divide-y divide-border-subtle">
            {filteredFriends.length === 0 ? (
              <p className="text-[11px] text-text-muted text-center py-3">{t('health.noFriendsFound')}</p>
            ) : (
              filteredFriends.map(({ friendUid }) => {
                const friend = friendUsersByUid.get(friendUid);
                const selected = shareFriendUids.includes(friendUid);
                const role = picker.shareFriendRoles[friendUid] || 'view';
                return (
                  <div key={friendUid} className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-surface transition-colors">
                    <button type="button" onClick={() => toggleFriend(friendUid)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                      <img src={friend?.photoURL || `https://ui-avatars.com/api/?name=${friend?.displayName || '?'}`} className="w-6 h-6 rounded-full object-cover shrink-0" alt="" />
                      <span className="flex-1 min-w-0 text-xs font-bold truncate">{friend?.displayName || t('common.someone')}</span>
                      <span className={clsx('w-4 h-4 rounded border flex items-center justify-center shrink-0', selected ? 'bg-primary border-primary' : 'border-border-subtle')}>
                        {selected && <span className="material-symbols-outlined text-white text-[12px]">check</span>}
                      </span>
                    </button>
                    {selected && (
                      <div className="flex bg-surface rounded-md border border-border-subtle p-0.5 gap-0.5 shrink-0">
                        {(['view', 'edit'] as const).map((r) => (
                          <button
                            key={r} type="button" onClick={() => setFriendRole(friendUid, r)}
                            className={clsx('px-2 py-1 rounded text-[9px] font-bold transition-all', role === r ? 'bg-primary text-white' : 'text-text-muted')}
                          >
                            {t(r === 'view' ? 'goals.shareRoleView' : 'goals.shareRoleEdit')}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
