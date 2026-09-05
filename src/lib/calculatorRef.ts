// A mutable ref to FloatingCalculator's open function, set by FloatingCalculator.tsx (mounted
// once, globally, alongside Header — see App.tsx). Mirrors feedPanelRef.ts's pattern — lets other
// components (the header menu's "Calculator" item, Tools.tsx's Calculator entry) open the SAME
// persistent floating widget instead of navigating to a page, without lifting its state into a
// shared context.
type OpenCalculatorFn = () => void;

let openFn: OpenCalculatorFn | null = null;

export function setOpenCalculatorFn(fn: OpenCalculatorFn | null) {
  openFn = fn;
}

export function openCalculator() {
  openFn?.();
}
