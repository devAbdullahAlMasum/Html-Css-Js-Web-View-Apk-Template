const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const [tools, output] = process.argv.slice(2);
if (!tools || !output) throw new Error('Expected SDK tool directory and output directory');
const requireTool = createRequire(path.join(tools, 'package.json'));
const esbuild = requireTool('esbuild');
const web = path.join(tools, 'node_modules/@ui-sdk/web/dist');
const entries = Object.fromEntries(fs.readdirSync(path.join(web, 'entries'))
  .filter(name => name.endsWith('.js'))
  .map(name => [name.slice(0, -3), path.join(web, 'entries', name)]));

async function main() {
  // The published browser package omits agent.js. Package it with the same kernel as every component.
  await esbuild.build({
    entryPoints: { ...entries, core: path.join(web, 'browser-core.js'), agent: path.join(web, 'agent.js') },
    outdir: path.join(output, 'web'),
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    chunkNames: 'chunks/[hash]',
    nodePaths: [path.join(tools, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
