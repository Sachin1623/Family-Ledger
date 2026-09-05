import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getParentPath } from '../lib/navigationParents';
import { openCalculator } from '../lib/calculatorRef';

// The calculator is now the persistent floating widget (see FloatingCalculator.tsx, mounted
// globally in App.tsx) rather than its own full page — it stays open and usable while the rest of
// the app works, instead of blocking navigation like a dedicated screen would. This route only
// exists so anything still pointing at /calculator (search index, old favorites/bookmarks, direct
// links) keeps working: it opens the floating widget and immediately returns to wherever the user
// came from.
export default function Calculator() {
  const navigate = useNavigate();

  useEffect(() => {
    openCalculator();
    navigate(getParentPath('/calculator'), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
