const esbuild = require('esbuild');
const fs = require('node:fs');
async function main(){
await esbuild.build({entryPoints: ['renderer.js'], bundle: true, outfile: 'renderer.bundle.js', format: 'cjs', platform: 'browser', target: 'chrome100', minify: true, legalComments: 'eof',plugins:[{name:'embedded-small-oidn',setup(build){build.onResolve({filter:/^oidn-small-weights$/},()=>({path:'small',namespace:'oidn-weights'}));build.onLoad({filter:/.*/,namespace:'oidn-weights'},()=>({contents:'export default '+JSON.stringify(fs.readFileSync('vendor/rt_hdr_alb_nrm_small.tza').toString('base64'))+';',loader:'js'}));}}]});
const bundle = fs.readFileSync('renderer.bundle.js', 'utf8');
const plugin = fs.readFileSync('plugin.js', 'utf8').replace('/* LIGHT_SYSTEM */', () => fs.readFileSync('lights.js', 'utf8')).replace('/* VIEWPORT_SYSTEM */', () => fs.readFileSync('viewport.js', 'utf8'));
const notices = ['three', 'three-mesh-bvh', 'three-gpu-pathtracer','oidn-webgpu','@petamoriken/float16'].map(name => name + '\n' + fs.readFileSync('node_modules/' + name + '/LICENSE', 'utf8')).join('\n\n')+'\n\nOIDN Small weights (Intel Corporation)\n'+fs.readFileSync('vendor/OIDN-WEIGHTS-LICENSE.txt','utf8');
fs.writeFileSync('THIRD_PARTY_NOTICES.txt', notices);
fs.mkdirSync('dist', {recursive:true});
fs.writeFileSync('dist/blockbench_renderer.js', plugin.replace('const runtime = NATIVE_RENDERER;', () => 'const runtime = (function(){const module={exports:{}};const exports=module.exports;\n' + bundle + '\nreturn module.exports;})();') + '\n/* Third-party licenses\n' + notices.replace(/\*\//g, '* /') + '\n*/\n');

}
main().catch(error=>{console.error(error);process.exitCode=1;});
