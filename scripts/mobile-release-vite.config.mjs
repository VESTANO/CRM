import { fileURLToPath } from 'node:url';
import { mergeConfig } from '../frontend/node_modules/vite/dist/node/index.js';
import baselineConfig from '../tmp/mobile-ui-live/frontend/vite.config.js';

// Local QA only: the release checkout reuses the workspace's installed modules.
// Permit their real paths without altering the deployed Vite configuration.
export default env => mergeConfig(baselineConfig(env), {
  server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
});
