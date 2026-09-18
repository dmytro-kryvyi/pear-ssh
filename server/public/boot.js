// Runs first, synchronously, on both UIs. Two builds live under one origin:
// the desktop workspace at / and the touch UI at /m/. Send each device to the
// one that suits it before the (multi-megabyte) module graph starts loading.
(function () {
  var mobile = location.pathname === '/m' || location.pathname.indexOf('/m/') === 0;
  var choice = null;
  try {
    // ?ui=desktop|mobile|auto sets the per-device override ("Switch UI" links).
    var asked = new URLSearchParams(location.search).get('ui');
    if (asked === 'auto') localStorage.removeItem('pear.ui');
    else if (asked === 'desktop' || asked === 'mobile') localStorage.setItem('pear.ui', asked);
    choice = localStorage.getItem('pear.ui');
  } catch (e) {
    /* storage blocked: fall through to detection */
  }

  if (choice !== 'desktop' && choice !== 'mobile') {
    // iPadOS claims to be a Mac in its user agent, so never sniff that. The
    // primary pointer does not lie: a finger is coarse. (A touchscreen laptop
    // stays on the desktop UI — its primary pointer is the trackpad.)
    var touch = matchMedia('(pointer: coarse)').matches;
    choice = touch || innerWidth < 900 ? 'mobile' : 'desktop';
  }
  if (choice === 'mobile' && !mobile) location.replace('/m/' + location.hash);
  else if (choice === 'desktop' && mobile) location.replace('/' + location.hash);
  else if (location.search.indexOf('ui=') !== -1)
    history.replaceState(null, '', location.pathname + location.hash);

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  }
})();
