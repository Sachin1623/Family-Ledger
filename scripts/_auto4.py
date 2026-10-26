def load(p):
    raw=open(p,'rb').read().decode('utf-8'); return '\r\n' in raw, raw.replace('\r\n','\n')
def save(p,s,c):
    if c: s=s.replace('\n','\r\n')
    open(p,'wb').write(s.encode('utf-8'))
def one(s,a,b):
    assert s.count(a)==1,(a[:70],s.count(a)); return s.replace(a,b)
p='src/screens/ManageGroup.tsx'; c,s=load(p)
first,rest=s.split('\n',1)
s=first+"\nimport RecurringQuickEdit from '../components/RecurringQuickEdit';\n"+rest
s=one(s,"  const [recurringTypeFilter, setRecurringTypeFilter] = useState<'all' | 'expense' | 'income'>('all');","  const [recurringTypeFilter, setRecurringTypeFilter] = useState<'all' | 'expense' | 'income'>('all');\n  const [recurringAutoFilter, setRecurringAutoFilter] = useState<'all' | 'auto' | 'ask'>('all'); // all, only the ones added automatically, or only the ones that ask first\n  const [editingRecurringId, setEditingRecurringId] = useState<string | null>(null); // the rule being edited inside the panel")
# the panel body: when a rule is being edited show the editor instead of the list
s=one(s,"""              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-primary">{t('search.recurringExpenses')}</h3>
                <button type="button" onClick={() => setShowRecurringPanel(false)} className="text-text-muted">
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>
              <div className="flex items-center justify-between gap-2">""","""              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-primary">{t('search.recurringExpenses')}</h3>
                <button type="button" onClick={() => { setShowRecurringPanel(false); setEditingRecurringId(null); }} className="text-text-muted">
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>
              {editingRecurringId && (() => {
                const rule: any = recurringRules.find((r: any) => r.id === editingRecurringId);
                if (!rule) return null;
                return (
                  <RecurringQuickEdit
                    key={rule.id}
                    rule={rule}
                    groupId={groupId!}
                    currencySymbol={getCurrencySymbol(group.currency)}
                    canSetAutoAdd={rule.userId === user?.uid}
                    actorName={user?.displayName || 'Someone'}
                    onClose={() => setEditingRecurringId(null)}
                    onMoreOptions={() => { setShowRecurringPanel(false); setEditingRecurringId(null); navigate(`/recurring-expenses?groupId=${groupId}&edit=${rule.id}`); }}
                  />
                );
              })()}
              {!editingRecurringId && (<>
              <div className="flex items-center justify-between gap-2">""")
s=one(s,"""                  {t('manageGroup.manage')}
                </button>
              </div>
              <div className="space-y-2">
                {recurringRules
                  .filter((rule: any) => recurringTypeFilter === 'all' || (recurringTypeFilter === 'income' ? rule.type === 'income' : rule.type !== 'income'))""","""                  {t('manageGroup.manage')}
                </button>
              </div>
              <div className="flex items-center gap-1 bg-surface-container rounded-lg p-1 w-fit">
                {([['all', 'All'], ['auto', 'Auto-added'], ['ask', 'Asks first']] as const).map(([opt, label]) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setRecurringAutoFilter(opt)}
                    className={clsx('px-3 py-1.5 rounded-md text-xs font-bold transition-all', recurringAutoFilter === opt ? 'bg-white text-primary shadow-sm' : 'text-text-muted')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                {recurringRules
                  .filter((rule: any) => recurringTypeFilter === 'all' || (recurringTypeFilter === 'income' ? rule.type === 'income' : rule.type !== 'income'))
                  .filter((rule: any) => recurringAutoFilter === 'all' || (recurringAutoFilter === 'auto' ? rule.autoAdd === true : rule.autoAdd !== true))""")
# each row is tappable and shows an Auto badge
s=one(s,"""                    <div
                      key={rule.id}
                      className={clsx(
                        "flex items-center gap-3 p-2 rounded-xl border border-border-subtle",
                        !rule.active && "opacity-50"
                      )}
                    >""","""                    <div
                      key={rule.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditingRecurringId(rule.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setEditingRecurringId(rule.id); }}
                      className={clsx(
                        "flex items-center gap-3 p-2 rounded-xl border border-border-subtle cursor-pointer active:bg-surface-container/50 transition-colors",
                        !rule.active && "opacity-50"
                      )}
                    >""")
s=one(s,"""                          {describeFrequency(rule)}{!rule.active && ` · ${t('manageGroup.paused')}`}""","""                          {rule.autoAdd === true && <span className="mr-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-primary">Auto</span>}
                          {describeFrequency(rule)}{!rule.active && ` · ${t('manageGroup.paused')}`}""")
save(p,s,c)
print('ok')
