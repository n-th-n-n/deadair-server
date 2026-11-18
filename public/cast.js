// Chromecast sending with Google's Cast SDK. It exists only in Chrome and Edge (desktop and
// Android); everywhere else castReady() resolves false and no Cast button is shown.
// The TV uses Google's Default Media Receiver, which plays the MP4 links from /api/cast/link.
const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

let ready = null;

export function castReady() {
  ready ||= new Promise((resolve) => {
    // Firefox and Safari can't cast; don't load Google's script there at all.
    if (!window.chrome || /firefox|fxios/i.test(navigator.userAgent)) return resolve(false);
    window.__onGCastApiAvailable = (ok) => {
      if (!ok) return resolve(false);
      window.cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      resolve(true);
    };
    const s = document.createElement('script');
    s.src = SDK;
    s.onerror = () => resolve(false);
    document.head.append(s);
    setTimeout(() => resolve(false), 15000);
  });
  return ready;
}
