// A mutable ref to Header's FeedPanel-opening function, set by Header.tsx (mounted once, globally,
// on every screen). Mirrors navigationRef.ts's pattern — lets other components (a group card's
// Feed button, say) open the SAME slide-over panel Header's own Feed button opens, optionally
// pre-filtered to one group, without needing to lift that state into a shared context.
type OpenFeedPanelFn = (groupId?: string) => void;

let openFn: OpenFeedPanelFn | null = null;

export function setOpenFeedPanelFn(fn: OpenFeedPanelFn | null) {
  openFn = fn;
}

export function openFeedPanel(groupId?: string) {
  openFn?.(groupId);
}
