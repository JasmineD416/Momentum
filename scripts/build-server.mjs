// Bundle the Node server into one file (dist/server/main.mjs); the server image then needs no node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
console.log('Built dist/server/main.mjs');