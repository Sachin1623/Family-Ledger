// Opens a direct or group chat as a popup over WHATEVER screen you're on (see GlobalChatPopup.tsx),
// so tapping a message notification mid-game shows the chat on top of the game instead of navigating
// away to Home / the group page. Closing it just dismisses the popup — you're still where you were.
export type ChatTarget = { kind: 'dm'; uid: string } | { kind: 'group'; groupId: string };
type Listener = (t: ChatTarget) => void;

let listener: Listener | null = null;
let pending: ChatTarget | null = null; // a notification tapped before the app finished mounting

export function setChatPopupListener(l: Listener | null) {
  listener = l;
  if (l && pending) {
    const p = pending;
    pending = null;
    l(p);
  }
}

export function openChatPopup(target: ChatTarget) {
  if (listener) listener(target);
  else pending = target;
}

// Turns an in-app deep link into a popup target, or null if the link isn't a chat.
export function chatTargetFromPath(path: string): ChatTarget | null {
  try {
    const u = new URL(path, 'http://x');
    const dm = u.searchParams.get('dm');
    if (u.pathname === '/' && dm) return { kind: 'dm', uid: dm };
    const m = u.pathname.match(/^\/groups\/([^/]+)$/);
    if (m && u.searchParams.get('chat') === '1') return { kind: 'group', groupId: m[1] };
  } catch {
    // not a parseable path
  }
  return null;
}
