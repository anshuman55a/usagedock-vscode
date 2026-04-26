import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const options = {
  entryPoints: [path.join(rootDir, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(rootDir, 'dist', 'extension.js'),
  external: ['vscode', 'better-sqlite3'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching extension host sources...');
} else {
  await build(options);
}
