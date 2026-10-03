import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

export interface FabAction {
  icon: string;
  label: string;
  onClick: () => void;
}

interface FabActionContextType {
  fabAction: FabAction | null;
  setFabAction: (action: FabAction | null) => void;
}

const FabActionContext = createContext<FabActionContextType>({
  fabAction: null,
  setFabAction: () => {},
});

// A single, app-lifetime instance (mounted once in App.tsx, like ShopModeContext) rather than one
// scoped per AuthenticatedLayout — avoids a remount flash of "no action registered yet" every time
// the route swaps to a fresh AuthenticatedLayout instance.
export const FabActionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [fabAction, setFabAction] = useState<FabAction | null>(null);
  return (
    <FabActionContext.Provider value={{ fabAction, setFabAction }}>
      {children}
    </FabActionContext.Provider>
  );
};

export const useFabAction = () => useContext(FabActionContext);

// Lets a screen register the action Navigation.tsx's floating "+" button should perform while
// that screen is mounted — e.g. Medicine Reminders swaps the button's target from the default
// "Add Expense" to "Add Incident" (calling that screen's own openAddIncident). `onClick` is read
// through a ref so callers don't need to useCallback it — only a genuine icon/label change
// re-registers. Cleared on unmount so leaving the page can never leak a stale action onto whatever
// screen loads next; Navigation falls back to its own default (Add Expense, or nothing) once the
// action clears.
export function usePageFabAction(icon: string, label: string, onClick: () => void) {
  const { setFabAction } = useFabAction();
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  useEffect(() => {
    setFabAction({ icon, label, onClick: () => onClickRef.current() });
    return () => setFabAction(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icon, label]);
}
