// Makes a new deploy actually reach a phone that keeps the app open for days.
//
// The app registers a service worker that serves the previous version's files instantly. A browser only looks for a newer
// service worker on a full page load, and the installed Android / iOS app is one long-lived page that is simply backgrounded and
// resumed — so after a deploy it kept showing the old version until the app was killed twice. This asks for a newer one when
// the app is opened or resumed (and every half hour), and once the new version has taken over it reloads:
//   · straight away if the app has only just opened or nobody is looking at it,
//   · otherwise the next time the app is brought back to the front (never in the middle of someone typing).
export function keepAppFresh() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  let hadController = !!navigator.serviceWorker.controller;
  let reloadOnResume = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true; // the very first install — nothing old to replace
      return;
    }
    if (document.hidden || performance.now() < 20000) window.location.reload();
    else reloadOnResume = true;
  });

  const checkForUpdate = () => {
    navigator.serviceWorker.getRegistration().then((reg) => reg?.update()).catch(() => {});
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (reloadOnResume) {
      window.location.reload();
      return;
    }
    checkForUpdate();
  });

  window.addEventListener('load', checkForUpdate);
  window.setInterval(checkForUpdate, 30 * 60 * 1000);
}
