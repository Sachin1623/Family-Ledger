import React, { useState } from 'react';
import { clsx } from 'clsx';

// A member's round picture, or their first letter when they have none (or it does not load).
export default function MemberAvatar({ name, photo, size = 28, className }: { name?: string; photo?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.44) };
  if (photo && !failed) {
    return <img src={photo} alt="" onError={() => setFailed(true)} style={style} className={clsx('rounded-full object-cover shrink-0 border border-border-subtle', className)} />;
  }
  return (
    <span style={style} className={clsx('rounded-full shrink-0 inline-flex items-center justify-center bg-primary/10 text-primary font-black uppercase', className)}>
      {(name || '?').trim().charAt(0) || '?'}
    </span>
  );
}
