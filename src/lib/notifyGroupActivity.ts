import { auth, db } from './firebase';
import { addDoc, collection } from 'firebase/firestore';

type GroupActivityAction =
  | 'added' | 'updated' | 'deleted' | 'commented' | 'recurring_created' | 'recurring_changed'
  | 'recurring_deleted' | 'shopping_list_created' | 'member_left' | 'todo_created' | 'todo_completed'
  | 'budget_set' | 'income_added';

// Actions that already write their own purpose-built doc to `activities` at the call site
// (add_expense/edit_expense/delete_expense, add_income, leave) — logging here too would
// double them up in the Activity Feed. Everything else previously only ever fired a push
// notification and never appeared in the Feed at all, even though the push claimed it happened.
const ALREADY_LOGGED_ELSEWHERE = new Set<GroupActivityAction>(['added', 'updated', 'deleted', 'income_added', 'member_left']);

const ACTIVITY_TYPE: Partial<Record<GroupActivityAction, string>> = {
  commented: 'comment',
  recurring_created: 'recurring_created',
  recurring_changed: 'recurring_changed',
  recurring_deleted: 'recurring_deleted',
  shopping_list_created: 'shopping_list_created',
  todo_created: 'todo_created',
  todo_completed: 'todo_completed',
  budget_set: 'budget_set',
};

// Fire-and-forget push notification (and, for actions not already logged elsewhere, a matching
// Activity Feed entry) after a group-relevant change. Never blocks or throws into the caller —
// a failure here shouldn't fail the underlying write, which has already succeeded by this point.
export function notifyGroupActivity(params: {
  groupId: string;
  action: GroupActivityAction;
  description?: string;
  amount?: number;
  actorName?: string;
  contextLabel?: string;
  listId?: string;
  expenseId?: string;
  // budget_set only — the month the budget applies to, as a raw Date.getMonth()/getFullYear()
  // pair rather than a pre-formatted label, so FeedList.tsx can render the month name in
  // whichever language the *viewer* (not the actor) has selected.
  month?: number;
  year?: number;
}) {
  try {
    auth.currentUser
      ?.getIdToken()
      .then((idToken) =>
        fetch('/api/notify-group-activity', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        }),
      )
      .catch((err) => console.error('notify-group-activity failed:', err));

    const type = ACTIVITY_TYPE[params.action];
    const currentUser = auth.currentUser;
    if (!type || ALREADY_LOGGED_ELSEWHERE.has(params.action) || !currentUser) return;

    // Firestore's addDoc() validates synchronously and throws on any literal `undefined` field
    // value (before returning a promise) — most actions only ever pass a subset of these, so the
    // other keys must be dropped entirely rather than written as undefined. Raw, untranslated
    // values only (the description text itself, amounts, dates) — FeedList.tsx is what composes
    // the actual sentence, in the *viewer's* language, from `type` + these fields at render time.
    const data: Record<string, any> = {};
    if (params.description !== undefined) data.description = params.description;
    if (params.amount !== undefined) data.amount = params.amount;
    if (params.contextLabel !== undefined) data.contextLabel = params.contextLabel;
    if (params.listId !== undefined) data.listId = params.listId;
    if (params.expenseId !== undefined) data.expenseId = params.expenseId;
    if (params.month !== undefined) data.month = params.month;
    if (params.year !== undefined) data.year = params.year;

    addDoc(collection(db, 'activities'), {
      groupId: params.groupId,
      userId: currentUser.uid,
      userName: params.actorName || currentUser.displayName || 'Someone',
      userPhoto: currentUser.photoURL || '',
      type,
      // Kept only as a plain-text fallback for contexts that read `description` directly instead
      // of composing from `data` (e.g. a future admin view) — the Feed itself ignores this for
      // every type it knows how to render and builds a localized sentence from `data` instead.
      description: params.description || '',
      data,
      createdAt: new Date().toISOString(),
    }).catch((err) => console.error('activity log failed:', err));
  } catch (err) {
    // Belt-and-suspenders: this function is called fire-and-forget from save flows that have
    // already succeeded by this point (see callers) — it must never throw synchronously into
    // them, or a caller's own try/catch would wrongly report its real save as failed.
    console.error('notifyGroupActivity failed:', err);
  }
}
