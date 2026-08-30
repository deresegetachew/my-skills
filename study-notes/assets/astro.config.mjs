import { defineConfig } from 'astro/config';
import captureInbox from './capture-inbox.mjs';

export default defineConfig({
  // Static output — `bun run build` produces plain HTML in dist/
  output: 'static',
  // Dev-only capture inbox for the study-notes Chrome extension (see
  // CAPTURE.md). Registers Vite dev middleware only — never present in the
  // production build. Remove this integration if the extension isn't wanted.
  integrations: [captureInbox()],
});
