/* Blockbench desktop plugin. MIT License. */
(function () {
 'use strict';
 const ID = 'blockbench_renderer';
 /* LIGHT_SYSTEM */
 /* VIEWPORT_SYSTEM */
 let lightSystem;
 let viewportSystem;
 let nativeRuntime;
 function captureFillCoverage(ctx, coverage, before) {
   const width=ctx.canvas.width,height=ctx.canvas.height,restorers=[];
   const mask=document.createElement('canvas');mask.width=width;mask.height=height;
   const maskCtx=mask.getContext('2d');maskCtx.setTransform(ctx.getTransform());
   const mark=(x,y)=>{if(x<0||y<0||x>=width||y>=height)return;const pixel=y*width+x;if(!Painter.lock_alpha||before.data[pixel*4+3]>0)coverage[pixel]=1;};
   function replace(name,wrap){const original=ctx[name],descriptor=Object.getOwnPropertyDescriptor(ctx,name);if(typeof original!=='function')return;ctx[name]=wrap(original);restorers.push(()=>{if(descriptor)Object.defineProperty(ctx,name,descriptor);else delete ctx[name];});}
   // Face / element / selection fills use paths and clipping. Replay only their geometry onto a mask.
   for(const name of ['save','restore','beginPath','closePath','rect','roundRect','moveTo','lineTo','arc','arcTo','ellipse','bezierCurveTo','quadraticCurveTo','clip','translate','scale','rotate','transform','setTransform','resetTransform']) {
     if(typeof maskCtx[name]!=='function')continue;
     replace(name,original=>function(...args){const result=original.apply(this,args);maskCtx[name](...args);return result;});
   }
   for(const name of ['fill','fillRect'])replace(name,original=>function(...args){
     const result=original.apply(this,args);
     if(BarItems.slider_brush_opacity.get()>0){maskCtx.fillStyle='#ffffff';maskCtx.globalAlpha=1;maskCtx.globalCompositeOperation='source-over';maskCtx[name](...args);}
     return result;
   });
   // Connected-color fills write selected pixels directly to ImageData, including identical RGBA.
   replace('getImageData',original=>function(x,y,w,h,...args){
     const image=original.call(this,x,y,w,h,...args),pixels=image.data;
     const proxy=new Proxy(pixels,{
       get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;},
       set(target,key,value){const index=typeof key==='string'&&/^\d+$/.test(key)?Number(key):-1;
         if(index>=0&&index<target.length&&BarItems.slider_brush_opacity.get()>0){const pixel=Math.floor(index/4);mark(Math.trunc(x)+pixel%image.width,Math.trunc(y)+Math.floor(pixel/image.width));}
         return Reflect.set(target,key,value,target);
       }
     });
     Object.defineProperty(image,'data',{value:proxy,configurable:true});return image;
   });
   return ()=>{
     for(const restore of restorers.reverse())restore();
     const pixels=maskCtx.getImageData(0,0,width,height).data;
     for(let p=0;p<coverage.length;p++)if(pixels[p*4+3])mark(p%width,Math.floor(p/width));
   };
 }
 function getNativeRuntime(){if(!nativeRuntime){const runtime = NATIVE_RENDERER;nativeRuntime=runtime;}return nativeRuntime;}
 let actions = [], panel, box, timer, originalEdit, originalInit, processHandle;
 let writing = false, lightPreview, renderWindow, pluginInstance, fileSystem;
 const listeners = [];
 const clamp = v => Math.max(0, Math.min(1, Number(v) || 0));
 const baseName = t => t.name.replace(/\.png$/i, '').replace(/_(roughness|metallic)$/i, '');
 const isMap = t => /_(roughness|metallic)(\.png)?$/i.test(t.name);
 const notify = s => Blockbench.showQuickMessage(s, 3500);
 function on(event, fn) { Blockbench.on(event, fn); listeners.push([event, fn]); }
 function source() { return Texture.selected && !isMap(Texture.selected) ? Texture.selected : null; }
 function map(t, channel, create = true) {
   const name = baseName(t) + '_' + channel;
   let result = Texture.all.find(x => x.name.replace(/\.png$/i, '') === name);
   if (!result && create) {
     const c = document.createElement('canvas'); c.width = t.width; c.height = t.height;
     const ctx = c.getContext('2d'), v = channel === 'roughness' ? 128 : 0;
     ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(0, 0, c.width, c.height);
     result = new Texture({name: name + '.png', keep_size: true}).fromDataURL(c.toDataURL()).add(false);
   }
   return result;
 }
 function values() { return {metallic: clamp(box.querySelector('[name=metallic]').value), roughness: clamp(box.querySelector('[name=roughness]').value)}; }
 function fillMaps() {
   const t = source(); if (!t) return notify('请先选择基础颜色贴图');
   const maps = ['metallic', 'roughness'].map(k => map(t, k));
   Undo.initEdit({textures: maps, bitmap: true});
   const v = values();
   maps.forEach((m, i) => m.edit(c => { const ctx = c.getContext('2d'), n = Math.round(v[i ? 'roughness' : 'metallic'] * 255); ctx.fillStyle = `rgb(${n},${n},${n})`; ctx.fillRect(0, 0, c.width, c.height); }, {no_undo: true}));
   Undo.finishEdit('设置 PBR 材质');
 }
 function saveMaps() {
   const t = source(); if (!t) return notify('请先选择基础颜色贴图');
   const fs = fileSystem || (fileSystem = require('fs', {message: '保存粗糙度和金属度 PNG。内置渲染不需要此权限。'})), path = require('path');
   if (!fs) return notify('未允许保存文件');
   const save = dir => {
     for (const k of ['roughness', 'metallic']) {
       const m = map(t, k), file = path.join(dir, baseName(t) + '_' + k + '.png');
       fs.writeFileSync(file, Buffer.from(m.getBase64(), 'base64')); m.path = file; m.saved = true;
     }
     notify('已保存粗糙度和金属度 PNG');
   };
   if (t.path && fs.existsSync(t.path)) save(path.dirname(t.path));
   else { const dir = Blockbench.pickDirectory({title: '选择 PBR 贴图保存目录'}); if (dir) save(dir); }
 }
 function refreshLights() { lightSystem?.refresh(); }
 function exportScene(dir) {
   const fs = dir ? require('fs') : null, path = dir ? require('path') : null, materials = {}, meshes = [];
   Texture.all.filter(t => !isMap(t)).forEach(t => {
     const entry = {};
     for (const k of ['color', 'roughness', 'metallic']) {
       const m = k === 'color' ? t : map(t, k, false); if (!m) continue;
       if (dir) { const file = path.join(dir, t.uuid + '_' + k + '.png'); fs.writeFileSync(file, Buffer.from(m.getBase64(), 'base64')); entry[k] = file; }
       else entry[k] = m.getDataURL();
     }
     materials[t.uuid] = entry;
   });
   Project.model_3d.updateMatrixWorld(true);
   Project.model_3d.traverse(obj => {
     if (!obj.isMesh || !obj.geometry || !obj.visible) return;
     for (let p=obj;p;p=p.parent) if(p.type==='pbr_light'||p.userData?.pbrLightGuide) return;
     for (let p = obj.parent; p; p = p.parent) if (!p.visible) return;
     const g = obj.geometry, pos = g.attributes.position, uv = g.attributes.uv;
     if (!pos) return;
     const idx = g.index, count = idx ? idx.count : pos.count;
     const groups = g.groups.length ? g.groups : [{start: 0, count, materialIndex: 0}];
     const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
     for (const group of groups) {
       const mat = Array.isArray(obj.material) ? mats[group.materialIndex] : mats[0]; if (!mat || mat.visible === false) continue;
       const texture = Texture.all.find(t => !isMap(t) && (t.uuid===mat.userData?.pbrTextureUUID || t.getOwnMaterial()?.map === mat.map));
       const vertices = [], uvs = [];
       for (let i = group.start; i < Math.min(group.start + group.count, count); i++) {
         const n = idx ? idx.getX(i) : i;
         const v = new THREE.Vector3().fromBufferAttribute(pos, n).applyMatrix4(obj.matrixWorld);
         vertices.push([v.x / 16, -v.z / 16, v.y / 16]);
         uvs.push(uv ? [uv.getX(n), uv.getY(n)] : [0, 0]);
       }
       if (obj.matrixWorld.determinant() < 0) for (let i = 0; i + 2 < vertices.length; i += 3) { [vertices[i+1], vertices[i+2]] = [vertices[i+2], vertices[i+1]]; [uvs[i+1], uvs[i+2]] = [uvs[i+2], uvs[i+1]]; }
       meshes.push({vertices, uvs, material: texture?.uuid, color: mat.color ? '#' + mat.color.getHexString() : '#ffffff'});
     }
   });
   const preview = Preview.selected, c = preview.camera; c.updateMatrixWorld(true);
   const position = new THREE.Vector3(); c.getWorldPosition(position);
   const convert = v => [v.x / 16, -v.z / 16, v.y / 16];
   return {meshes, materials, lights: lightSystem ? lightSystem.getLights() : [], camera: {position: convert(position), target: convert(preview.controls.target), ortho: c.isOrthographicCamera, fov: c.fov || 45, scale: c.isOrthographicCamera ? (c.top - c.bottom) / c.zoom / 16 : 1}};
 }
 function closeRenderWindow() {
   if (!renderWindow) return;
   clearTimeout(renderWindow.refreshTimer); renderWindow.session?.dispose(); renderWindow.forms?.forEach(f => f.delete()); renderWindow.dialog?.hide();
   pluginInstance.renderSession = null; renderWindow = null;
 }
 function nativeRender(mode = 'high') {
   if (!Project) return;
   if (renderWindow) { renderWindow.dialog.show(); return; }
   const runtime = getNativeRuntime();
   const root = document.createElement('div'); root.className = 'pbr_render_layout';
   root.innerHTML = `<style>
     #pbr_native_render .pbr_render_layout {padding:12px;display:grid;grid-template-columns:180px minmax(0,1fr);gap:20px;align-items:start}
     #pbr_native_render .pbr_settings {display:flex;flex-direction:column;gap:22px}
     #pbr_native_render .pbr_section {display:flex;flex-direction:column;gap:12px}
     #pbr_native_render .pbr_section h3 {font-size:14px;font-weight:600;margin:0;padding-bottom:8px;border-bottom:1px solid var(--color-border)}
     #pbr_native_render .pbr_settings .form_bar {margin-bottom:12px}
     #pbr_native_render .pbr_settings .numeric_input,#pbr_native_render .pbr_settings .bb-select {width:100%;max-width:100%;box-sizing:border-box}
     #pbr_native_render .pbr_preview {min-width:0;display:flex;flex-direction:column;gap:10px}
     #pbr_native_render [name=status] {height:20px;font-size:12px;color:var(--color-subtle_text);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
     #pbr_native_render [name=viewport] {background:repeating-conic-gradient(#333 0% 25%,#3b3b3b 0% 50%) 0/20px 20px;display:flex;justify-content:center;overflow:hidden}
     #pbr_native_render canvas {width:100%;max-height:58vh;object-fit:contain;aspect-ratio:1;touch-action:none}
     #pbr_native_render .pbr_buttons {display:flex;gap:8px}
     #pbr_native_render .pbr_buttons button {flex:1;min-height:30px}
     @media(max-width:650px) {#pbr_native_render .pbr_render_layout {grid-template-columns:140px minmax(0,1fr);gap:12px}}
   </style>
   <aside class="pbr_settings">
     <section class="pbr_section" name="render"><h3>渲染</h3>
     </section>
     <section class="pbr_section" name="output"><h3>输出</h3>
       <div>分辨率</div>
     </section>
     <section class="pbr_section" name="environment"><h3>环境</h3>
     </section>
   </aside>
   <main class="pbr_preview"><div name="status"></div><div name="viewport"><canvas></canvas></div>
     <div class="pbr_buttons"><button name="pause">暂停</button><button name="reset">重新采样</button><button name="export">导出 PNG</button></div>
   </main>`;
   const forms = [new InputForm({
     samples: {label: '采样次数', type: 'select', full_width: true, options: {'20':'20','32':'32','128':'128','512':'512','1024':'1024'}, value: '128'}
   }), new InputForm({
     width: {label: '宽', type: 'number', full_width: true, min:64, max:2048, step:1, force_step:true, value:512},
     height: {label: '高', type: 'number', full_width: true, min:64, max:2048, step:1, force_step:true, value:512}
   }), new InputForm({
     world: {label:'环境光', type:'number', full_width:true, min:0, max:10, step:0.1, value:0.7},
     transparent: {label:'透明背景', type:'checkbox', value:false}
   })];
   ['render','output','environment'].forEach((name,i) => root.querySelector('[name=' + name + ']').append(forms[i].node));
   const status = root.querySelector('[name=status]');
   const dialog = new Dialog({id: 'pbr_native_render', title: '渲染', width: 900, lines: [], buttons: ['关闭'], onConfirm: closeRenderWindow, onCancel: closeRenderWindow});
   dialog.show(); dialog.object.querySelector('.dialog_content').append(root);
   let session;
   try { session = new runtime.RenderSession(root.querySelector('canvas'), s => status.textContent = s); }
   catch (e) { status.textContent = '无法创建 GPU 渲染器：' + e.message; return; }
   renderWindow = {dialog, session, root, forms}; pluginInstance.renderSession = session;
   const options = () => { const v = Object.assign({}, ...forms.map(f => f.getResult())); return {...v, mode:'high', samples:Number(v.samples)}; };
   let loading = false;
   const refresh = async () => {
     if (loading) return;
     loading = true; root.querySelector('.pbr_settings').inert = true; root.querySelectorAll('button').forEach(el => el.disabled = true);
     try { await session.load(exportScene(), options()); }
     catch (e) { status.textContent = '渲染准备失败：' + e.message; }
     finally { loading = false; root.querySelector('.pbr_settings').inert = false; root.querySelectorAll('button').forEach(el => el.disabled = false); root.querySelector('[name=pause]').textContent = '暂停'; }
   };
   forms[0].on('change', ({changed_keys = []}) => { if (loading) return; if (changed_keys.includes('samples')) { session.samplesGoal = options().samples; session.reset(); } root.querySelector('[name=pause]').textContent = '暂停'; });
   forms[1].on('change', () => { if (loading) return; const o=options(); session.setSize(o.width,o.height); session.reset(); });
   forms[2].on('change', () => { if (loading) return; clearTimeout(renderWindow.refreshTimer); renderWindow.refreshTimer=setTimeout(refresh,200); });
   root.querySelector('[name=reset]').onclick = () => { session.reset(); root.querySelector('[name=pause]').textContent = '暂停'; };
   root.querySelector('[name=pause]').onclick = e => { session.paused = !session.paused; e.target.textContent = session.paused ? '继续' : '暂停'; };
   root.querySelector('[name=export]').onclick = () => { try { Blockbench.export({type: 'PNG', extensions: ['png'], savetype: 'image', name: baseName({name: Project.name || 'render'}) + '_' + session.mode, content: session.getPNG()}); } catch (e) { notify(e.message); } };
   refresh();
 }
 function render() {
   if (processHandle) return notify('已有渲染任务进行中');
   const dialog = new Dialog({id: 'cycles_render_options', title: 'Cycles 光追渲染', form: {
     blender: {label: 'Blender 可执行文件', type: 'text', value: localStorage.getItem(ID + '_blender') || 'blender'},
     width: {label: '宽度', type: 'number', min: 64, max: 8192, value: 1024}, height: {label: '高度', type: 'number', min: 64, max: 8192, value: 1024},
     samples: {label: '采样数', type: 'number', min: 1, max: 4096, value: 128}, transparent: {label: '透明背景', type: 'checkbox', value: true},
     world: {label: '环境亮度', type: 'number', min: 0, max: 10, value: 0.3}
   }, onConfirm(v) {
     const output = Blockbench.pickDirectory({title: '选择渲染输出文件夹'}); if (!output) return;
     dialog.hide(); localStorage.setItem(ID + '_blender', v.blender);
     const fs = require('fs'), path = require('path'), os = require('os');
     const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockbench-cycles-'));
     try {
       const data = exportScene(dir); data.options = v; data.output = path.join(output, 'render_' + Date.now() + '.png');
       fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(data)); fs.writeFileSync(path.join(dir, 'render.py'), PYTHON);
       const child = require('child_process').spawn(v.blender.replace(/^"|"$/g, ''), ['--background', '--python', path.join(dir, 'render.py'), '--', path.join(dir, 'scene.json')], {windowsHide: true});
       processHandle = child; let log = '';
       child.stdout.on('data', d => { log = (log + d).slice(-20000); }); child.stderr.on('data', d => { log = (log + d).slice(-20000); });
       child.on('error', e => { processHandle = null; notify('无法启动 Blender：请检查可执行文件路径'); fs.writeFileSync(path.join(dir, 'error.txt'), String(e)); });
       child.on('close', code => { processHandle = null; if (code === 0 && fs.existsSync(data.output)) { Blockbench.showItemInFolder(data.output); notify('Cycles 渲染完成'); } else { fs.writeFileSync(path.join(dir, 'error.txt'), log); Blockbench.showItemInFolder(path.join(dir, 'error.txt')); notify('渲染失败，请查看日志'); } });
       notify('Cycles 正在后台渲染，可继续编辑');
     } catch (e) { notify('导出失败：' + e.message); }
   }}); dialog.show();
 }
 const PYTHON = `import bpy, json, sys, math
from mathutils import Vector
d=json.load(open(sys.argv[sys.argv.index('--')+1], encoding='utf-8'))
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
s=bpy.context.scene; s.render.engine='CYCLES'; s.cycles.samples=int(d['options']['samples']); s.cycles.use_denoising=True
s.render.resolution_x=int(d['options']['width']); s.render.resolution_y=int(d['options']['height']); s.render.resolution_percentage=100
s.render.film_transparent=d['options']['transparent']; s.render.image_settings.file_format='PNG'; s.render.image_settings.color_mode='RGBA'
s.world.use_nodes=True; s.world.node_tree.nodes['Background'].inputs['Strength'].default_value=d['options']['world']
materials={}
for key, maps in d['materials'].items():
 m=bpy.data.materials.new(key); m.use_nodes=True; n=m.node_tree.nodes; p=n.get('Principled BSDF')
 for channel, file in maps.items():
  t=n.new('ShaderNodeTexImage'); t.image=bpy.data.images.load(file, check_existing=True); t.interpolation='Closest'
  if channel!='color': t.image.colorspace_settings.name='Non-Color'
  m.node_tree.links.new(t.outputs['Color'],p.inputs[{'color':'Base Color','roughness':'Roughness','metallic':'Metallic'}[channel]])
  if channel=='color': m.node_tree.links.new(t.outputs['Alpha'],p.inputs['Alpha'])
 materials[key]=m
for item in d['meshes']:
 mesh=bpy.data.meshes.new('Blockbench'); verts=item['vertices']; mesh.from_pydata(verts,[],[(i,i+1,i+2) for i in range(0,len(verts)-2,3)]); mesh.update()
 ob=bpy.data.objects.new('Model',mesh); s.collection.objects.link(ob); layer=mesh.uv_layers.new()
 for poly in mesh.polygons:
  for li in poly.loop_indices: layer.data[li].uv=item['uvs'][mesh.loops[li].vertex_index]
 if item.get('material') in materials: mesh.materials.append(materials[item['material']])
def coord(v): return Vector((v[0]/16,-v[2]/16,v[1]/16))
for item in d['lights']:
 light=bpy.data.lights.new(item['name'],item['type']); light.energy=item['power']; h=item['color'].lstrip('#'); rgb=[int(h[i:i+2],16)/255 for i in (0,2,4)]; light.color=[v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4 for v in rgb]
 ob=bpy.data.objects.new(item['name'],light); s.collection.objects.link(ob); ob.location=coord(item['position']); direction=coord(item['target'])-ob.location
 if direction.length: ob.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
 if item['type']=='AREA': light.shape='RECTANGLE'; light.size=item.get('width',item['size'])/16; light.size_y=item.get('height',item['size'])/16
 if item['type'] in ('POINT','SPOT'): light.shadow_soft_size=item['size']/16
 if item['type']=='SPOT': light.spot_size=math.radians(item['angle'])
c=d['camera']; cam=bpy.data.cameras.new('Camera'); ob=bpy.data.objects.new('Camera',cam); s.collection.objects.link(ob); ob.location=c['position']; direction=Vector(c['target'])-ob.location; ob.rotation_euler=direction.to_track_quat('-Z','Y').to_euler(); s.camera=ob
cam.clip_start=0.001; cam.clip_end=10000
if c['ortho']: cam.type='ORTHO'; cam.ortho_scale=c['scale']*max(1,s.render.resolution_x/s.render.resolution_y)
else: cam.sensor_fit='VERTICAL'; cam.angle=math.radians(c['fov'])
s.render.filepath=d['output']; bpy.ops.wm.save_as_mainfile(filepath=d['output']+'.blend'); bpy.ops.render.render(write_still=True)
`;
 Plugin.register(ID, {title: 'Blockbench Renderer', author: 'Codex', description: 'PBR 绘画、大纲光源、实时 PBR 显示模式与 GPU 路径追踪渲染', icon: 'light_mode', version: '0.1.1', min_version: '5.0.0', variant: 'desktop',
 onload() {
   pluginInstance = this;
   this.projectProperty = new Property(ModelProject, 'array', 'cycles_lights', {default: []});
   box = document.createElement('div'); box.id = 'cycles_paint_controls'; box.style.cssText = 'padding:8px;display:grid;gap:6px';
   box.innerHTML = '<label>金属度 <output>0.00</output><input name="metallic" type="range" min="0" max="1" step="0.01" value="0" style="width:100%"></label><label>粗糙度 <output>0.50</output><input name="roughness" type="range" min="0" max="1" step="0.01" value="0.5" style="width:100%"></label><label><input name="paint" type="checkbox"> 随颜色笔画写入 PBR</label><button name="fill">应用到整张材质</button><button name="save">保存 PBR 贴图</button>';
   box.querySelectorAll('input[type=range]').forEach(el => el.oninput = () => el.parentElement.querySelector('output').textContent = Number(el.value).toFixed(2));
   box.querySelector('[name=fill]').onclick = fillMaps; box.querySelector('[name=save]').onclick = saveMaps;
   Interface.Panels.color.node.append(box);
   timer = setInterval(() => { box.style.display = Modes.selected?.id === 'paint' ? 'grid' : 'none'; }, 300);
   originalInit = UndoSystem.prototype.initEdit;
   UndoSystem.prototype.initEdit = function(aspects, ...args) {
     if (box.querySelector('[name=paint]').checked && aspects?.bitmap && aspects.textures && !writing) {
       const extra = aspects.textures.filter(t => !isMap(t)).flatMap(t => [map(t, 'roughness'), map(t, 'metallic')]);
       aspects = {...aspects, textures: [...new Set([...aspects.textures, ...extra])]};
     }
     return originalInit.call(this, aspects, ...args);
   };
   originalEdit = Painter.edit;
   Painter.edit = function(t, callback, options) {
     if (!writing && callback && !isMap(t) && box.querySelector('[name=paint]').checked && !t.layers_enabled) {
       const wrapped = canvas => {
         const ctx = canvas.getContext('2d'), before = ctx.getImageData(0, 0, canvas.width, canvas.height);
         // Observe the native brush's accepted pixels, rather than inferring a stroke from RGB differences.
         // Native brush rasterization has already applied shape, selection, UV and mirror restrictions here.
         const coverage = new Uint8Array(canvas.width * canvas.height);
         const brush = Toolbox.selected.id === 'brush_tool' ? Toolbox.selected.brush : null;
         const changePixel = brush?.changePixel;
         const finishFill = Toolbox.selected.id === 'fill_tool' ? captureFillCoverage(ctx,coverage,before) : null;
         if (changePixel) brush.changePixel = function(x,y,color,falloff,settings) {
           const result = changePixel.call(this,x,y,color,falloff,settings);
           if (settings.texture === t && settings.opacity * falloff > 0 && !(Painter.lock_alpha && color.a === 0)) {
             x=Math.floor(x);y=Math.floor(y);
             if(x>=0&&y>=0&&x<canvas.width&&y<canvas.height)coverage[y*canvas.width+x]=1;
           }
           return result;
         };
         let result;
         try { result = callback(canvas, Painter.current); }
         finally { if (changePixel) brush.changePixel = changePixel;finishFill?.(); }
         const after = ctx.getImageData(0, 0, canvas.width, canvas.height), v = values();
         writing = true;
         try { for (const k of ['roughness', 'metallic']) {
           const m = map(t, k); if (m.width !== canvas.width || m.height !== canvas.height) continue;
           m.edit(c => { const mc = c.getContext('2d'), pixels = mc.getImageData(0, 0, c.width, c.height); for (let i = 0; i < after.data.length; i += 4) { if (coverage[i/4] || before.data[i] !== after.data[i] || before.data[i+1] !== after.data[i+1] || before.data[i+2] !== after.data[i+2] || before.data[i+3] !== after.data[i+3]) { const n = Math.round(v[k] * 255); pixels.data[i] = pixels.data[i+1] = pixels.data[i+2] = n; pixels.data[i+3] = 255; } } mc.putImageData(pixels, 0, 0); }, {no_undo: true});
         }} finally { writing = false; }
         return result;
       };
       return originalEdit.call(this, t, wrapped, options);
     }
     return originalEdit.call(this, t, callback, options);
   };
   lightSystem = installLightSystem(); this.lightSystem = lightSystem;
   viewportSystem=installPBRViewport(()=>lightSystem.getLights());this.viewportSystem=viewportSystem;
   refreshLights(); on('select_project', refreshLights); on('new_project', refreshLights); on('load_project', refreshLights);
   on('select_mode', () => { if (lightPreview) lightPreview.visible = Modes.selected?.id === 'edit'; });
   function action(id, name, icon, click, condition) { const a = new Action(id, {name, icon, click, condition}); actions.push(a); MenuBar.addAction(a, 'tools'); }
   action('cycles_render_image', '渲染', 'photo_camera', () => nativeRender('high'), () => !!Project);
 },
 onunload() { viewportSystem?.dispose();lightSystem?.dispose(); closeRenderWindow(); clearInterval(timer); box?.remove(); panel?.delete(); lightPreview?.parent?.remove(lightPreview); lightPreview?.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); }); actions.forEach(a => a.delete()); actions = []; listeners.forEach(([e,f]) => Blockbench.removeListener(e,f)); Painter.edit = originalEdit; UndoSystem.prototype.initEdit = originalInit; this.projectProperty?.delete(); processHandle?.kill(); }
 });
})();
