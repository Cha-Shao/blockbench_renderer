const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {chromium} = require('playwright-core');
const {PNG} = require('pngjs');
const T = require('three');
const {dimensions,sampleCount} = require('../renderer.bundle.js');
assert.deepEqual(dimensions(-1, 99999, 'low'), [64, 2048]);
assert.equal(sampleCount(1),20); assert.equal(sampleCount(20),20); assert.equal(sampleCount(128),128); assert.equal(sampleCount(10000),4096);
const png = value => {const p = new PNG({width: 4, height: 4}); for(let i=0;i<p.data.length;i+=4){p.data[i]=p.data[i+1]=p.data[i+2]=value;p.data[i+3]=255;}return 'data:image/png;base64,'+PNG.sync.write(p).toString('base64');};
const box = new T.BoxGeometry(1, 1, 1).toNonIndexed();
const vertices = [], uvs = [];
for(let i=0;i<box.attributes.position.count;i++){vertices.push([box.attributes.position.getX(i),box.attributes.position.getY(i),box.attributes.position.getZ(i)+0.5]);uvs.push([box.attributes.uv.getX(i),box.attributes.uv.getY(i)]);}
const data = {meshes:[{vertices,uvs,material:'test'}],materials:{test:{color:png(180),roughness:png(100),metallic:png(200)}},lights:[],camera:{position:[2.5,-3,2],target:[0,0,0.5],ortho:false,fov:45,scale:3}};
const bundle = fs.readFileSync('renderer.bundle.js','utf8');
const server = http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<canvas id="c"></canvas><script>var module={exports:{}};'+bundle+';window.API=module.exports;</script>');});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try {
  const page=await browser.newPage(); const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('console', m=>{if(m.type()==='error') errors.push(m.text());});
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async data=>{window.statuses=[];window.session=new API.RenderSession(document.querySelector('canvas'),s=>statuses.push(s));await session.load(data,{mode:'low',width:128,height:128,samples:4,world:0.7,ground:true,transparent:false});},data);
  await page.waitForFunction(()=>session.ready&&statuses.some(s=>s.startsWith('低精')));
  const low=await page.evaluate(()=>session.getPNG());
  fs.writeFileSync('tests/low.png',Buffer.from(low.split(',')[1],'base64'));
  await page.evaluate(()=>session.setMode('high'));
  await page.waitForFunction(()=>session.completed||session.failed,{},{timeout:180000});
  const state=await page.evaluate(()=>({samples:session.pathTracer.samples,failed:session.failed,status:statuses.at(-1)}));
  assert.equal(state.failed,false,JSON.stringify({state,errors})); assert.ok(state.samples>=20);
  const high=await page.evaluate(()=>session.getPNG());fs.writeFileSync('tests/high.png',Buffer.from(high.split(',')[1],'base64'));
  for(const file of ['low','high']){const image=PNG.sync.read(fs.readFileSync('tests/'+file+'.png')); const values=new Set();for(let i=0;i<image.data.length;i+=4)values.add(image.data[i]);assert.ok(values.size>20,file+' output must contain rendered shading');}
  assert.notEqual(low,high,'engines must produce different images');
  await page.evaluate(()=>{session.setMode('low');session.setSize(160,128);session.reset();});
  await page.waitForFunction(()=>session.canvas.width===160&&!session.dirty);
  assert.equal(await page.evaluate(()=>session.renderer.info.render.triangles>0),true);
  await page.evaluate(()=>session.dispose()); assert.equal(await page.evaluate(()=>session.disposed&&session.resources.size===0),true);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({ok:true,low:'tests/low.png',high:'tests/high.png',...state}));
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
