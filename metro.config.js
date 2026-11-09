// Expo (Android/web customer app). The separate PC admin panel in admin-web/
// has its own dependencies and build; keep Metro from scanning it.
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.blockList = [/admin-web\/.*/];
module.exports = config;
