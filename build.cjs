const esbuild = require('esbuild');
const fs = require('node:fs');
esbuild.buildSync({entryPoints: ['renderer.js'], bundle: true, outfile: 'renderer.bundle.js', format: 'cjs', platform: 'browser', target: 'chrome100', minify: true, legalComments: 'eof'});
const bundle = fs.readFileSync('renderer.bundle.js', 'utf8');
const plugin = fs.readFileSync('plugin.js', 'utf8').replace('/* LIGHT_SYSTEM */', () => fs.readFileSync('lights.js', 'utf8')).replace('/* VIEWPORT_SYSTEM */', () => fs.readFileSync('viewport.js', 'utf8'));
const notices = ['three', 'three-mesh-bvh', 'three-gpu-pathtracer'].map(name => name + '\n' + fs.readFileSync('node_modules/' + name + '/LICENSE', 'utf8')).join('\n\n');
fs.writeFileSync('THIRD_PARTY_NOTICES.txt', notices);
fs.mkdirSync('dist', {recursive:true});
fs.writeFileSync('dist/blockbench_renderer.js', plugin.replace('const runtime = NATIVE_RENDERER;', () => 'const runtime = (function(){const module={exports:{}};const exports=module.exports;\n' + bundle + '\nreturn module.exports;})();') + '\n/* Third-party licenses\n' + notices.replace(/\*\//g, '* /') + '\n*/\n');
