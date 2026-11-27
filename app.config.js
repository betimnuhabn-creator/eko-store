// Dynamic additions to app.json (Expo reads both).
//
// Android push notifications need Firebase Cloud Messaging. The Firebase
// file is NOT committed (the repository is public):
//   * EAS builds: upload it as a "file" environment variable named
//     GOOGLE_SERVICES_JSON (expo.dev → project → Environment variables).
//   * Local builds: put google-services.json in the project root.
// Without it the app still works; only push notifications are unavailable.
const fs = require('fs');

module.exports = ({ config }) => {
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_JSON || (fs.existsSync('./google-services.json') ? './google-services.json' : undefined);
  return {
    ...config,
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
  };
};
