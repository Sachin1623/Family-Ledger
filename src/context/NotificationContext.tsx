import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot, orderBy, limit, Timestamp } from 'firebase/firestore';
import { useAuth } from './AuthContext';
import { Bell, Info, AlertCircle, CheckCircle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  icon: string;
  createdAt: string;
}

interface NotificationContextType {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id' | 'createdAt' | 'icon'> & { icon?: string }) => void;
  removeNotification: (id: string) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const useNotification = () => {
  const context = useContext(NotificationContext);
  if (!context) throw new Error('useNotification must be used within a NotificationProvider');
  return context;
};

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const { user, profile } = useAuth();
  const seenActivityIds = useRef<Set<string>>(new Set());

  const addNotification = (notification: Omit<Notification, 'id' | 'createdAt' | 'icon'> & { icon?: string }) => {
    const id = Math.random().toString(36).substring(7);
    const newNotification = {
      ...notification,
      id,
      icon: notification.icon || 'notifications',
      createdAt: new Date().toISOString()
    };
    setNotifications(prev => [...prev, newNotification]);

    // Auto remove after 6 seconds
    setTimeout(() => {
      removeNotification(id);
    }, 6000);
  };

  const removeNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  // Listen for new activities in user's groups
  useEffect(() => {
    if (!user || !profile?.notificationsEnabled) {
      return;
    }

    // 1. Get user's groups
    const membersQuery = query(collection(db, 'members'), where('userId', '==', user.uid));
    
    let unsubscribeActivities: (() => void) | undefined;

    const unsubscribeMembers = onSnapshot(membersQuery, (snapshot) => {
      const groupIds = snapshot.docs.map(doc => doc.data().groupId);
      
      if (unsubscribeActivities) unsubscribeActivities();

      if (groupIds.length === 0) return;

      const activitiesQuery = query(
        collection(db, 'activities'),
        where('groupId', 'in', groupIds),
        limit(20)
      );

      // Firestore's onSnapshot reports the *entire* initial result set as `type: 'added'` on its
      // first callback, not just documents added after the listener attached — without this
      // guard, opening the app (or switching groups) would fire a toast for whatever activity
      // already existed, briefly popping up and auto-dismissing a few seconds later. Every
      // `added` change from the second callback onward is genuinely new, so only that range needs
      // to raise a toast.
      let isInitialSnapshot = true;

      unsubscribeActivities = onSnapshot(activitiesQuery, (actSnapshot) => {
        if (isInitialSnapshot) {
          isInitialSnapshot = false;
          return;
        }
        actSnapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const data = change.doc.data();
            const activityId = change.doc.id;
            const isNotSelf = data.userId !== user.uid;

            if (isNotSelf && !seenActivityIds.current.has(activityId)) {
              seenActivityIds.current.add(activityId);

              addNotification({
                type: 'info',
                title: getNotificationTitle(data.type),
                message: data.description || 'New group activity',
                icon: getNotificationIcon(data.type)
              });
            }
          }
        });
      }, (error) => {
        console.error("Activities snapshot error:", error);
      });
    });

    return () => {
      unsubscribeMembers();
      if (unsubscribeActivities) unsubscribeActivities();
    };
  }, [user, profile?.notificationsEnabled]);

  const getNotificationTitle = (type: string) => {
    switch (type) {
      case 'add_expense': return 'New Expense';
      case 'edit_expense': return 'Expense Updated';
      case 'delete_expense': return 'Expense Deleted';
      case 'join': return 'New Member Joined';
      case 'create_group': return 'Group Created';
      case 'update_group_icon': return 'Group Icon Updated';
      case 'invite': return 'New Invitation';
      default: return 'Update';
    }
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'add_expense': return 'add_shopping_cart';
      case 'edit_expense': return 'edit_note';
      case 'delete_expense': return 'delete_sweep';
      case 'join': return 'person_add';
      case 'create_group': return 'groups_3';
      case 'update_group_icon': return 'palette';
      case 'invite': return 'mail';
      default: return 'notifications';
    }
  };

  return (
    <NotificationContext.Provider value={{ notifications, addNotification, removeNotification }}>
      {children}
      
      {/* Toast Container */}
      <div className="fixed top-0 left-0 right-0 z-[100] pointer-events-none flex flex-col items-center gap-3 pb-4 px-6 pt-[calc(1rem+env(safe-area-inset-top))] sm:px-4 sm:pt-[calc(1.5rem+env(safe-area-inset-top))]">
        <AnimatePresence>
          {notifications.map((notification) => (
            <motion.div
              key={notification.id}
              initial={{ opacity: 0, y: -40, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -40, scale: 0.8, transition: { duration: 0.2 } }}
              className="pointer-auto max-w-sm w-full bg-white/95 backdrop-blur-md rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-border-subtle p-4 flex items-center gap-4 pointer-events-auto active:scale-95 transition-transform"
            >
              <div className="shrink-0 p-2.5 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                <span className="material-symbols-outlined text-[20px]">{notification.icon}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-bold text-on-surface leading-none">{notification.title}</p>
                <p className="text-[11px] text-text-muted mt-1 truncate font-medium">{notification.message}</p>
              </div>
              <button 
                onClick={() => removeNotification(notification.id)}
                className="shrink-0 w-8 h-8 flex items-center justify-center text-text-muted hover:text-on-surface hover:bg-surface-container rounded-full transition-all"
              >
                <X size={16} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </NotificationContext.Provider>
  );
};
