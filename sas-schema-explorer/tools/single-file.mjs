/**
 * Bundle the Angular dist into one self-contained HTML file
 * (dist/sas-schema-explorer/single/index.html) — used for publishing the app
 * as a Claude Artifact and for "just open the file" distribution.
 *
 * Also emits `fragment.html` (same content without <html>/<head>/<body>
 * wrappers) for hosts that provide their own page skeleton.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/sas-schema-explorer/browser', import.meta.url).pathname;
const outDir = new URL('../dist/sas-schema-explorer/single', import.meta.url).pathname;

let html = readFileSync(join(dist, 'index.html'), 'utf-8');

html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_m, href) => {
  const css = readFileSync(join(dist, href), 'utf-8');
  return `<style>\n${css}\n</style>`;
});

html = html.replace(/<script\s+src="([^"]+)"([^>]*)><\/script>/g, (_m, src, attrs) => {
  const js = readFileSync(join(dist, src), 'utf-8').replace(/<\/script/gi, '<\\/script');
  return `<script${attrs}>\n${js}\n</script>`;
});

html = html.replace(/<link rel="icon"[^>]*>/g, '');
html = html.replace(/<base href="[^"]*">/g, '');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);

const fragment = html
  .replace(/^[\s\S]*?<head>/, '')
  .replace(/<\/head>\s*<body>/, '')
  .replace(/<\/body>\s*<\/html>\s*$/, '')
  .replace(/<meta[^>]*>/g, '')
  .trim();
writeFileSync(join(outDir, 'fragment.html'), fragment);

console.log(`single-file build: ${outDir}/index.html (${(html.length / 1024).toFixed(0)} KB)`);
