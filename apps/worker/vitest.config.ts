import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig({
  test: {
    env: {
      ...loadEnv('test', '../../', ''),
      ENV_SSRF_ALLOW_IPS: '',     // no exceptions: test the production setting
      ENV_ALLOW_HTTP: 'false',
    },
  },
});
