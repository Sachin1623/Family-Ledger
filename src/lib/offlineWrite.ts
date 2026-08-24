// Firestore write promises (addDoc/setDoc/updateDoc/deleteDoc) only resolve once the *server*
// acknowledges the write — the SDK docs are explicit about this: "it won't resolve while you're
// offline." With offline persistence enabled (see firebase.ts), the write itself is already
// durably queued locally and guaranteed to sync automatically the moment connectivity returns —
// but a form that does `await addDoc(...); setSaving(false);` still gets its loading state stuck
// until then, because the await is on that same server-ack promise. This fires the write and lets
// the caller move on immediately (resetting a loading spinner, closing a form, navigating away),
// only logging if it eventually fails for a real reason (a permissions error, not "still offline").
export function fireWrite<T>(promise: Promise<T>, label: string): void {
  promise.catch((err) => console.error(`${label} failed:`, err));
}
