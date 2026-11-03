// wx-spektrafilm — app entry
// Film modeling powered by spektrafilm (https://github.com/andreavolpato/spektrafilm)

const Privacy = require('./utils/privacy.js');

App({
  onLaunch() {
    // The privacy listener is registered as early as possible: a privacy
    // scoped interface stays pending until the listener resolves it, so a
    // late registration would freeze the first call.
    Privacy.getPrivacyGuard().install();
    // LUTs are loaded lazily by pages/index after the first photo is chosen.
  },
  globalData: {},
});
