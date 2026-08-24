import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { db } from '../lib/firebase';
import { collection, query, where, addDoc } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { clsx } from 'clsx';
import { notifyGroupActivity } from '../lib/notifyGroupActivity';
import { EXPENSE_CATEGORIES } from '../lib/constants';
import { useLanguage } from '../context/LanguageContext';

export default function ShoppingLists() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useLanguage();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('food');
  const [groupId, setGroupId] = useState('');
  const [scheduledInput, setScheduledInput] = useState('');
  const [saving, setSaving] = useState(false);

  const [membershipsValue] = useCollection(
    user ? query(collection(db, 'members'), where('userId', '==', user.uid)) : null,
  );
  const groupIds = membershipsValue?.docs.map((d) => d.data().groupId) || [];
  const [groupsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'groups'), where('__name__', 'in', groupIds)) : null,
  );
  const groups = groupsValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  const [allMembersValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'members'), where('groupId', 'in', groupIds)) : null,
  );
  const allMembers = allMembersValue?.docs.map((d) => d.data() as any) || [];

  const [myListsValue, myLoading, myError] = useCollection(
    user ? query(collection(db, 'shoppingLists'), where('userId', '==', user.uid)) : null,
  );
  const [sharedListsValue] = useCollection(
    groupIds.length > 0 ? query(collection(db, 'shoppingLists'), where('groupId', 'in', groupIds)) : null,
  );
  const listsById = new Map<string, any>();
  myListsValue?.docs.forEach((d) => listsById.set(d.id, { id: d.id, ...d.data() }));
  sharedListsValue?.docs.forEach((d) => listsById.set(d.id, { id: d.id, ...d.data() }));
  const lists = Array.from(listsById.values()).sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setCategory('food');
    setGroupId('');
    setScheduledInput('');
    setShowForm(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    const trimmedDescription = description.trim();
    if (!user || !trimmed || !trimmedDescription) return;

    setSaving(true);
    try {
      const scheduledAt = scheduledInput ? new Date(scheduledInput).toISOString() : null;
      const docRef = await addDoc(collection(db, 'shoppingLists'), {
        userId: user.uid,
        title: trimmed,
        description: trimmedDescription,
        category,
        groupId: groupId || null,
        scheduledAt,
        completed: false,
        createdAt: new Date().toISOString(),
      });
      if (groupId) {
        notifyGroupActivity({
          groupId,
          action: 'shopping_list_created',
          description: trimmed,
          contextLabel: scheduledAt ? new Date(scheduledAt).toLocaleString() : undefined,
          actorName: user.displayName || 'Someone',
          listId: docRef.id,
        });
      }
      resetForm();
      navigate(`/shopping-lists/${docRef.id}`);
    } catch (err) {
      console.error('Failed to create shopping list:', err);
      alert(t('shoppingLists.failedToCreate'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-primary">{t('tools.shoppingLists')}</h1>
          <p className="text-sm text-text-muted mt-1">
            {t('shoppingLists.subtitle')}
          </p>
        </div>

        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            data-tour="shopping-add"
            className="w-full py-3.5 bg-primary/5 border border-primary/20 text-primary font-bold rounded-2xl flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined">add_shopping_cart</span>
            {t('shoppingLists.newList')}
          </button>
        ) : (
          <form onSubmit={handleCreate} className="bg-white rounded-2xl border border-border-subtle p-6 space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('shoppingLists.listName')}</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('shoppingLists.listNamePlaceholder')}
                maxLength={150}
                required
                autoFocus
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('addExpense.description')}</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('shoppingLists.descPlaceholder')}
                maxLength={200}
                required
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
              <p className="text-[10px] text-text-muted px-1">
                {t('shoppingLists.descHelp')}
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('common.category')}</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>{t(`category.${c.id}`)}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('shoppingLists.scheduledTime')}</label>
              <input
                type="datetime-local"
                value={scheduledInput}
                onChange={(e) => setScheduledInput(e.target.value)}
                className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>

            {groups.length > 0 && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-wider px-1">{t('todo.shareWithGroupOptional')}</label>
                <select
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                  className="w-full bg-surface p-3 rounded-xl border border-border-subtle text-sm outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">{t('todo.justMe')}</option>
                  {groups.map((g: any) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-text-muted px-1">
                  {t('shoppingLists.sharingHelp')}
                </p>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetForm}
                className="flex-1 py-3 rounded-xl font-bold text-text-muted border border-border-subtle"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || !title.trim() || !description.trim()}
                className="flex-1 py-3 bg-primary text-white font-bold rounded-xl disabled:opacity-50"
              >
                {saving ? t('shoppingLists.creating') : t('shoppingLists.create')}
              </button>
            </div>
          </form>
        )}

        <section className="space-y-2">
          {myLoading && <p className="text-sm text-text-muted px-1">{t('common.loading')}</p>}
          {myError && (
            <p className="text-sm text-error px-1">{t('shoppingLists.couldntLoad', { error: myError.code || myError.message })}</p>
          )}
          {!myLoading && !myError && lists.length === 0 && (
            <p className="text-sm text-text-muted italic px-1">{t('shoppingLists.noListsYet')}</p>
          )}
          {lists.map((list: any) => {
            const group = groups.find((g: any) => g.id === list.groupId);
            const creator = allMembers.find((m: any) => m.userId === list.userId);
            const scheduledPast = list.scheduledAt && new Date(list.scheduledAt) < new Date();
            return (
              <div
                key={list.id}
                onClick={() => navigate(`/shopping-lists/${list.id}`)}
                className="bg-white rounded-2xl border border-border-subtle p-4 flex items-center gap-3 cursor-pointer hover:bg-surface-container/20 transition-colors"
              >
                <div className={clsx(
                  "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                  list.completed ? "bg-success/10 text-success" : "bg-primary/5 text-primary"
                )}>
                  <span className="material-symbols-outlined text-lg">{list.completed ? 'task_alt' : 'shopping_cart'}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className={clsx("font-bold text-sm truncate", list.completed ? "text-text-muted line-through" : "text-primary")}>{list.title}</p>
                  <p className="text-[11px] text-text-muted truncate">
                    {group ? t('todo.shared', { name: group.name }) : t('shoppingLists.personal')}
                    {group && list.userId !== user?.uid && ` · ${t('todo.addedBy', { name: creator?.displayName || t('todo.aMember') })}`}
                  </p>
                  {list.scheduledAt && (
                    <p className={clsx('text-[10px] font-bold', scheduledPast ? 'text-error' : 'text-text-muted')}>
                      {t('shoppingLists.scheduledLabel', { date: new Date(list.scheduledAt).toLocaleString() })}
                    </p>
                  )}
                </div>
                <span className="material-symbols-outlined text-text-muted">chevron_right</span>
              </div>
            );
          })}
        </section>
      </main>
    </div>
  );
}
