import React from 'react';
import { useShopMode } from '../../context/ShopModeContext';
import { db } from '../../lib/firebase';
import { collection, query, orderBy, limit } from 'firebase/firestore';
import { useCollection } from 'react-firebase-hooks/firestore';
import { motion } from 'motion/react';

const ICONS: Record<string, string> = {
  sale_created: 'point_of_sale',
  sale_updated: 'edit',
  cost_set: 'payments',
  customer_created: 'person_add',
  credit_payment: 'undo',
  category_added: 'sell',
  staff_added: 'group_add',
  staff_removed: 'person_remove',
};

function timeAgo(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ShopActivity() {
  const { shopId } = useShopMode();

  const [activitiesValue, loading] = useCollection(
    shopId ? query(collection(db, 'shops', shopId, 'activities'), orderBy('createdAt', 'desc'), limit(100)) : null,
  );
  const activities = activitiesValue?.docs.map((d) => ({ id: d.id, ...d.data() } as any)) || [];

  return (
    <div className="flex flex-col min-h-screen bg-surface">
      <main className="flex-1 p-4 md:p-8 max-w-xl mx-auto w-full space-y-6 pb-24">
        <div>
          <h1 className="text-2xl font-black text-[#7C3AED]">Shop Activity</h1>
          <p className="text-sm text-text-muted mt-1">Everything the team has done in this shop.</p>
        </div>

        <div className="bg-white rounded-2xl border border-border-subtle divide-y divide-border-subtle overflow-hidden">
          {loading && <div className="p-8 text-center text-sm text-text-muted">Loading…</div>}
          {!loading && activities.length === 0 && (
            <div className="p-8 text-center text-sm text-text-muted italic">No activity yet.</div>
          )}
          {activities.map((a, idx) => (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.03 }}
              className="p-4 flex items-start gap-3"
            >
              <div className="w-9 h-9 rounded-full bg-[#7C3AED]/10 flex items-center justify-center text-[#7C3AED] shrink-0">
                <span className="material-symbols-outlined text-[18px]">{ICONS[a.type] || 'history'}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-on-surface">{a.description}</p>
                <p className="text-[10px] text-text-muted font-bold mt-0.5">{timeAgo(a.createdAt)}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </main>
    </div>
  );
}
