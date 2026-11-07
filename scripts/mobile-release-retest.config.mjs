import base from './mobile-release-playwright.config.mjs';
export default {
  ...base,
  reporter: [['list'], ['json', { outputFile: '../tmp/mobile/release-retest-results.json' }]],
  outputDir: '../tmp/mobile/release-retest-artifacts',
  webServer: { ...base.webServer, reuseExistingServer: true },
};
