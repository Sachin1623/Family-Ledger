import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';

interface ShopModeContextType {
  hasShopAccess: boolean;
  shopId: string | null;
  shopRole: 'owner' | 'staff' | null;
  shopMode: boolean;
  setShopMode: (on: boolean) => void;
}

const ShopModeContext = createContext<ShopModeContextType>({
  hasShopAccess: false,
  shopId: null,
  shopRole: null,
  shopMode: false,
  setShopMode: () => {},
});

const STORAGE_KEY = 'fl_shop_mode';

// Whether the header's mode toggle shows at all is driven by `profile.shopId` (set only by
// server.ts's admin-approval/add-staff endpoints — see firestore.rules, the client can never
// write this itself). Which mode is currently *active* is a lightweight, device-local UI
// preference (localStorage, not Firestore) — restored on next launch so switching to Shopkeeper
// mode sticks across app restarts instead of always resetting to the personal view.
export const ShopModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { profile } = useAuth();
  const hasShopAccess = !!profile?.shopId;
  const shopId = profile?.shopId || null;
  const shopRole = profile?.shopRole || null;

  const [shopMode, setShopModeState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!hasShopAccess && shopMode) setShopModeState(false);
  }, [hasShopAccess, shopMode]);

  const setShopMode = (on: boolean) => {
    setShopModeState(on);
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      // ignore
    }
  };

  return (
    <ShopModeContext.Provider value={{ hasShopAccess, shopId, shopRole, shopMode: shopMode && hasShopAccess, setShopMode }}>
      {children}
    </ShopModeContext.Provider>
  );
};

export const useShopMode = () => useContext(ShopModeContext);
