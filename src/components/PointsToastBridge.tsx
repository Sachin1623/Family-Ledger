import { useEffect } from 'react';
import { useNotification } from '../context/NotificationContext';
import { setPointsToastFn } from '../lib/pointsToastRef';

// Renders nothing — just registers this session's addNotification into the module-level ref so
// pointsApi.ts's claimPoints (called from plain event handlers, not components) can show a toast.
// Mirrors Header.tsx's setOpenFeedPanelFn registration.
export default function PointsToastBridge() {
  const { addNotification } = useNotification();
  useEffect(() => {
    setPointsToastFn(addNotification);
    return () => setPointsToastFn(null);
  }, [addNotification]);
  return null;
}
