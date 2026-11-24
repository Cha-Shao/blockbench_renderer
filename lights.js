// Installed inside the plugin closure; uses Blockbench's native Outliner and form APIs.
function installLightSystem() {
  const TYPE = 'pbr_light', names = {POINT:'点光源',SPOT:'聚光灯',AREA:'面光源',SUN:'太阳光'};
  let form, panel, pending, drag, signature = '', disposed = false, editing = false;
  const actions = [], hooks = [];
  const pipette='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g stroke-linejoin="round" stroke-linecap="round"><path d="M3 28l3-7L20 7l5 5L11 26l-8 2z" fill="white" stroke="white" stroke-width="4"/><path d="M3 28l3-7L20 7l5 5L11 26l-8 2z" fill="white" stroke="#111" stroke-width="1.5"/><path d="M8 22l11-11M13 12l8 8" stroke="#111" stroke-width="1.5"/><path d="M18 6l5-4c4-1 8 3 7 7l-4 5z" fill="#111" stroke="white" stroke-width="1.5"/></g></svg>';
  const cursorStyle=Blockbench.addCSS('.pbr-surface-pick {cursor:url("data:image/svg+xml,'+encodeURIComponent(pipette)+'") 3 28,crosshair !important;}');
  function pickCursor(active){for(const p of Preview.all)p.canvas.classList.toggle('pbr-surface-pick',active);}
  function cancelPick(){pending=null;pickCursor(false);Blockbench.setStatusBarText();}
  const listen = (e,f) => { Blockbench.on(e,f); hooks.push([e,f]); };
  let Light = OutlinerElement.types[TYPE];
  if (!Light) {
    Light = class PBRLight extends Locator {
      constructor(data, uuid) { super(null, uuid); for (const p of Object.values(Light.properties)) p.reset(this); if (data) this.extend(data); }
      extend(data) { for (const p of Object.values(Light.properties)) p.merge(this,data); this.sanitizeName(); return this; }
    };
    Light.properties = {};
    Light.behavior = {...Locator.behavior};
    for (const [key,p] of Object.entries(Locator.properties)) new Property(Light,p.type,key,{default:key==='name'?'光源':key==='export'?false:p.default});
    for (const [key,type,value] of [['light_type','string','AREA'],['color','string','#ffffff'],['power','number',1000],['radius','number',16],['angle','number',45],['target_id','string',''],['follow_target','boolean',false]]) new Property(Light,type,key,{default:value});
    OutlinerElement.registerType(Light,TYPE);
    Light.prototype.title = '光源'; Light.prototype.icon = 'lightbulb'; Light.prototype.buttons = Locator.prototype.buttons;
  }
  Light.properties.export.default = false;
  Light.properties.power.default=100;
  if(!Light.properties.radius)new Property(Light,'number','radius',{default:16});
  for(const project of ModelProject.all)for(const l of project.elements.filter(n=>n instanceof Light)){const old=typeof l.size==='number'?l.size:16;l.radius??=old;l.width??=old;l.height??=old;if(Object.prototype.hasOwnProperty.call(l,'size'))delete l.size;}
  delete Light.properties.size;
  for(const key of ['width','height'])if(!Light.properties[key])new Property(Light,'number',key,{default:16});
  if(!Light.properties.aim_distance)new Property(Light,'number','aim_distance',{default:24});
  Light.prototype.buttons = Locator.prototype.buttons.filter(b=>b.id!=='export');
  Light.prototype.getTypeBehavior=function(flag){if(flag==='resizable')return this.light_type==='AREA';return OutlinerNode.prototype.getTypeBehavior.call(this,flag);};
  Light.prototype.getSize=function(axis){const dimensions=[this.width??this.radius,this.height??this.radius,0];return axis==null?dimensions:dimensions[axis];};
  Light.prototype.size=function(axis){return this.getSize(axis);};
  Light.prototype.resize=function(modify,axis,negative=false,allowNegative=false,bidirectional=false){
    if(this.light_type!=='AREA'||axis>1)return this;
    let original=this.temp_data.old_size??this.getSize(axis);if(Array.isArray(original))original=original[axis];
    const value=typeof modify==='function'?modify(original):original+modify*(negative?-1:1)*(bidirectional?2:1);
    this[axis===0?'width':'height']=Math.max(0.01,value);this.preview_controller.updateAll(this);TickUpdates.selection=true;return this;
  };
  Light.prototype.extend = function(data) { for(const p of Object.values(Light.properties))p.merge(this,data);if(typeof data.size==='number'){this.radius=data.size;if(data.width==null)this.width=data.size;if(data.height==null)this.height=data.size;}if(this.light_type==='POINT'||this.light_type==='SPOT'){this.target_id='';this.follow_target=false;}this.sanitizeName();return this; };
  const selected = () => Project ? Light.selected[0] : null;
  function targetNode(light) { return light.light_type==='POINT'||light.light_type==='SPOT'?null:OutlinerNode.uuids[light.target_id]; }
  function center(node) {
    if (!node?.mesh) return null;
    node.mesh.updateWorldMatrix(true,true);
    if (node instanceof Cube || node instanceof Mesh) return node.getWorldCenter();
    const box = new THREE.Box3();
    if(node instanceof Group) Outliner.elements.filter(n=>(n instanceof Cube||n instanceof Mesh)&&n.isChildOf(node)).forEach(n=>{n.mesh?.updateWorldMatrix(true,true);if(n.mesh)box.union(new THREE.Box3().setFromObject(n.mesh));});
    else box.setFromObject(node.mesh);
    return box.isEmpty() ? node.mesh.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
  }
  function orientPoint(light, point) {
    const mesh = light.mesh; if (!mesh || !point) return;
    mesh.updateWorldMatrix(true,false); const position = mesh.getWorldPosition(new THREE.Vector3());
    if (position.distanceToSquared(point)<0.00001) return;
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position,point,new THREE.Vector3(0,1,0)));
    if (mesh.parent) q.premultiply(mesh.parent.getWorldQuaternion(new THREE.Quaternion()).invert());
    mesh.quaternion.copy(q); mesh.updateMatrixWorld(true);
  }
  function orient(light,target){orientPoint(light,center(target));}
  function disposeGuide(mesh) { if(mesh)delete mesh.pbrGuideKey;for(const key of ['pbrGuide','pbrHandles'])if(mesh?.[key]) {const o=mesh[key];o.traverse(c=>{c.geometry?.dispose();c.material?.dispose();});mesh.remove(o);delete mesh[key];} }
  function draw(light) {
    const mesh=light.mesh; if (!mesh) return;
    const target=targetNode(light), point=center(target), local=light.light_type==='SPOT'?new THREE.Vector3(0,0,-(light.aim_distance||24)):point ? mesh.worldToLocal(point.clone()) : null;
    const key=JSON.stringify([light.light_type,light.radius,light.width,light.height,light.angle,light.selected,local?.toArray(),CustomTheme.data.colors.text,CustomTheme.data.colors.accent]);
    if(mesh.pbrGuideKey===key) return; disposeGuide(mesh);mesh.pbrGuideKey=key;
    const vertices=[], line=(a,b)=>vertices.push(...a,...b), ring=(radius,z=0,axis=2)=>{
      for(let i=0;i<48;i++) { const p=(n)=>{const a=n*Math.PI/24;return axis===2?[Math.cos(a)*radius,Math.sin(a)*radius,z]:axis===1?[Math.cos(a)*radius,z,Math.sin(a)*radius]:[z,Math.cos(a)*radius,Math.sin(a)*radius];};line(p(i),p(i+1)); }
    };
    const length=local ? Math.max(light.light_type==='SPOT'?0.1:4,Math.min(256,local.length())) : 24;
    if(light.light_type==='POINT') { ring(2);ring(2,0,0);ring(2,0,1); }
    if(light.light_type==='AREA') { const w=Math.max(0.1,(light.width??light.radius)/2),h=Math.max(0.1,(light.height??light.radius)/2),corners=[[-w,-h,0],[w,-h,0],[w,h,0],[-w,h,0]];corners.forEach((p,i)=>line(p,corners[(i+1)%4]));line([0,0,0],[0,0,-8]);line([0,0,-8],[-1,0,-6]);line([0,0,-8],[1,0,-6]); }
    if(light.light_type==='SPOT') { const radius=Math.tan(Math.max(1,Math.min(179,light.angle))*Math.PI/360)*length;ring(radius,-length);for(let i=0;i<4;i++){const a=i*Math.PI/2;line([0,0,0],[Math.cos(a)*radius,Math.sin(a)*radius,-length]);} }
    if(light.light_type==='SUN') { ring(2);for(let i=0;i<8;i++){const a=i*Math.PI/4;line([3*Math.cos(a),3*Math.sin(a),0],[5*Math.cos(a),5*Math.sin(a),0]);}line([0,0,0],[0,0,-24]); }
    if(local) line([0,0,0],local.toArray());
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    const guide=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:light.selected?CustomTheme.data.colors.accent:CustomTheme.data.colors.text,depthTest:!light.selected,transparent:true,opacity:0.85}));
    guide.no_export=true;guide.userData.pbrLightGuide=true;mesh.add(guide);mesh.pbrGuide=guide;
    if(light.light_type==='SPOT'&&light.selected&&Modes.selected?.id==='edit'){
      const handles=new THREE.Group();handles.no_export=true;handles.userData.pbrLightGuide=true;
      const sphere=new THREE.Mesh(new THREE.SphereGeometry(1,16,12),new THREE.MeshBasicMaterial({color:0xffdc30,depthTest:false,depthWrite:false}));
      sphere.position.set(0,0,-length);sphere.userData.pbrHandle='aim';sphere.renderOrder=1000;handles.add(sphere);
      const arrow=new THREE.Mesh(new THREE.ConeGeometry(1,2.5,12),new THREE.MeshBasicMaterial({color:0x68e7df,depthTest:false,depthWrite:false}));
      arrow.rotation.z=-Math.PI/2;arrow.position.set(Math.tan(light.angle*Math.PI/360)*length,0,-length);arrow.userData.pbrHandle='focus';arrow.renderOrder=1000;handles.add(arrow);
      mesh.add(handles);mesh.pbrHandles=handles;
    }
    sizeHandles(light);
  }
  function sizeHandles(light,preview=Preview.selected){
    const handles=light.mesh?.pbrHandles;if(!handles||!preview)return;
    handles.visible=light.selected&&Modes.selected?.id==='edit';
    for(const h of handles.children){const p=h.getWorldPosition(new THREE.Vector3()),c=preview.camera;const units=c.isOrthographicCamera?(c.top-c.bottom)/c.zoom/preview.height:2*p.distanceTo(c.getWorldPosition(new THREE.Vector3()))*Math.tan((c.fov||45)*Math.PI/360)/preview.height;const scale=Math.max(0.02,units*6/Math.max(0.001,Math.abs(light.mesh.getWorldScale(new THREE.Vector3()).x)));h.scale.setScalar(scale);}
  }
  new NodePreviewController(Light, {
    setup(light) { Locator.preview_controller.setup.call(this,light); light.mesh.no_export=true; draw(light); },
    updateTransform(light) { NodePreviewController.prototype.updateTransform.call(this,light); if(light.follow_target&&light.light_type!=='SPOT') orient(light,targetNode(light)); Locator.preview_controller.updateWindowSize.call(this,light); draw(light);sizeHandles(light); },
    updateSelection(light) { Locator.preview_controller.updateSelection.call(this,light);draw(light); },
    updateVisibility(light) { NodePreviewController.prototype.updateVisibility.call(this,light); },
    updateGeometry(light) { draw(light); },
    remove(light) { disposeGuide(light.mesh); light.mesh?.sprite?.material.dispose(); NodePreviewController.prototype.remove.call(this,light); }
  });
  function edit(light, values, label='编辑光源') {
    if (!light || !Light.all.includes(light)) return;
    Undo.initEdit({elements:[light]}); light.extend(values);light.preview_controller.updateAll(light);Undo.finishEdit(label);Project.saved=false;
  }
  function aim(light,node) {
    if (!light || light.light_type==='POINT' || !node || node instanceof Light) return;
    if(light.light_type==='SPOT'){Undo.initEdit({elements:[light]});aimSurface(light,center(node));Undo.finishEdit('对准表面');refresh();return;}
    Undo.initEdit({elements:[light]});light.target_id=node.uuid;light.follow_target=true;
    light.preview_controller.updateTransform(light);
    light.rotation=light.mesh.rotation.toArray().slice(0,3).map(v=>v*180/Math.PI);
    Undo.finishEdit('设置光源照射对象');Project.saved=false;signature='';light.select();updateSelection();refresh();
  }
  function aimSurface(light,point){
    if(!point)return;light.target_id='';light.follow_target=false;orientPoint(light,point);
    light.rotation=light.mesh.rotation.toArray().slice(0,3).map(v=>v*180/Math.PI);
    light.aim_distance=Math.max(0.1,Math.min(256,light.mesh.worldToLocal(point.clone()).length()));light.preview_controller.updateTransform(light);
  }
  function pointerRay(preview,event){const rect=preview.canvas.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2),preview.camera);return ray;}
  function surfaceHit(ray){
    const meshes=[];for(const element of Outliner.elements){if(element instanceof Light||!element.mesh?.isMesh||!element.mesh.geometry)continue;let visible=true;for(let n=element;n instanceof OutlinerNode;n=n.parent)if(n.visibility===false)visible=false;for(let o=element.mesh;o;o=o.parent)if(!o.visible)visible=false;if(visible){element.mesh.updateWorldMatrix(true,false);meshes.push(element.mesh);}}
    return ray.intersectObjects(meshes,false).find(h=>{const material=Array.isArray(h.object.material)?h.object.material[h.face?.materialIndex||0]:h.object.material;return material?.visible!==false;});
  }
  function focusSurface(light,ray){const m=light.mesh,length=light.aim_distance||24,origin=m.localToWorld(new THREE.Vector3(0,0,-length)),normal=new THREE.Vector3(0,0,1).applyQuaternion(m.getWorldQuaternion(new THREE.Quaternion())),point=ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal,origin),new THREE.Vector3());if(!point)return;const local=m.worldToLocal(point);light.angle=Math.max(1,Math.min(179,2*Math.atan2(Math.hypot(local.x,local.y),length)*180/Math.PI));light.preview_controller.updateTransform(light);}
  function pick(light) { if(!light||light.locked||light.light_type==='POINT')return;pending={light,project:Project};pickCursor(true);Blockbench.setStatusBarText(light.light_type==='SPOT'?'点选可见模型表面，Esc 取消':'点选要照射的模型，Esc 取消'); }
  function capture(event) {
    if(event.button!==0||Modes.selected?.id!=='edit')return;
    const preview=Preview.all.find(p=>p.canvas===event.target); if (!preview) return;
    const ray=pointerRay(preview,event),light=selected();
    if(light?.light_type==='SPOT'&&!light.locked&&light.mesh?.pbrHandles&&!pending){sizeHandles(light,preview);light.mesh.updateMatrixWorld(true);const handle=ray.intersectObjects(light.mesh.pbrHandles.children,false)[0];if(handle){event.preventDefault();event.stopImmediatePropagation();Undo.initEdit({elements:[light]});drag={light,preview,kind:handle.object.userData.pbrHandle,project:Project,pointer:event.pointerId,canvas:preview.canvas};editing=true;try{preview.canvas.setPointerCapture(event.pointerId);}catch{}return;}}
    if (!pending || pending.project!==Project) return;
    if(pending.light.light_type==='SPOT'){const hit=surfaceHit(ray);if(!hit)return;event.preventDefault();event.stopImmediatePropagation();const lamp=pending.light;cancelPick();Undo.initEdit({elements:[lamp]});aimSurface(lamp,hit.point);Undo.finishEdit('对准表面');signature='';refresh();return;}
    const hit=preview.raycast(event);if(!hit?.element||hit.element instanceof Light)return;event.preventDefault();event.stopImmediatePropagation();const lamp=pending.light;cancelPick();aim(lamp,hit.element);
  }
  function move(event){if(!drag||event.pointerId!==drag.pointer)return;event.preventDefault();event.stopImmediatePropagation();if(drag.project!==Project){finish(true);return;}const ray=pointerRay(drag.preview,event);if(drag.kind==='aim'){const hit=surfaceHit(ray);if(hit)aimSurface(drag.light,hit.point);}else focusSurface(drag.light,ray);}
  function finish(cancel=false){if(!drag)return;const state=drag;drag=null;try{state.canvas.releasePointerCapture(state.pointer);}catch{}if(cancel)Undo.cancelEdit();else{Undo.finishEdit(state.kind==='aim'?'拖动聚光灯方向':'调整聚光灯聚焦度');Project.saved=false;}editing=false;signature='';refresh();}
  const up=e=>{if(drag&&e.pointerId===drag.pointer){e.preventDefault();e.stopImmediatePropagation();finish(e.type==='pointercancel');}};
  const escape=e=>{if(e.key==='Escape'){if(drag){e.preventDefault();e.stopImmediatePropagation();finish(true);}if(pending)cancelPick();}};
  const blur=()=>{if(pending)cancelPick();};window.addEventListener('blur',blur);
  document.addEventListener('pointerdown',capture,true);document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',up,true);document.addEventListener('keydown',escape,true);
  function choose(light) {
    const options={'':'无'};[...Group.all,...Outliner.elements].filter(n=>!(n instanceof Light)).forEach(n=>options[n.uuid]=n.name);
    const d=new Dialog({id:'pbr_light_target',title:'选择照射对象',form:{target:{label:'对象',type:'select',options,value:light.target_id||''}},onConfirm(v){d.hide();if(v.target)aim(light,OutlinerNode.uuids[v.target]);else {edit(light,{target_id:'',follow_target:false});signature='';refresh();}}});d.show();
  }
  function add(type, data) {
    const elements=[];Undo.initEdit({elements,outliner:true,selection:true});
    const light=new Light(data || {name:names[type],light_type:type,position:[32,48,32],power:100});
    light.addTo(Group.first_selected||Outliner.ROOT).init().select().createUniqueName();elements.push(light);Undo.finishEdit('添加'+names[type]);updateSelection();signature='';refresh();return light;
  }
  const addAction=new Action('pbr_add_light',{name:'添加光源',icon:'lightbulb',condition:()=>Modes.selected?.id==='edit',children:Object.entries(names).map(([type,name])=>({name,icon:'lightbulb',click:()=>add(type)}))});
  actions.push(addAction);BarItems.add_element.side_menu.addAction(addAction);
  if(!Interface.Panels.outliner.menu.structure.some(x=>x.id==='add_element'&&x.children?.includes(addAction))) Interface.Panels.outliner.menu.addAction(addAction,'add_element');
  const settings=new Action('pbr_light_settings',{name:'光源属性',icon:'tune',click:()=>{signature='';refresh();panel.selectTab();},condition:()=>!!selected()});actions.push(settings);
  const aimAction=new Action('pbr_light_pick_target',{name:'点选照射对象',icon:'ads_click',click:()=>pick(selected()),condition:()=>!!selected()&&selected().light_type!=='POINT'});actions.push(aimAction);
  Light.prototype.menu=new Menu([settings,aimAction,'copy','duplicate','rename','toggle_visibility','delete']);
  panel=new Panel('pbr_light_properties',{name:'光源属性',icon:'lightbulb',condition:()=>Modes.selected?.id==='edit'&&!!selected(),default_position:{slot:'right_bar'},growable:true});
  function refresh() {
    if(disposed || !Project)return;
    if(pending){if(pending.project!==Project||!Light.all.includes(pending.light))cancelPick();else pickCursor(true);}
    for(const light of Light.all) { light.preview_controller.updateTransform(light);light.preview_controller.updateVisibility(light); }
    if(editing)return;
    const light=selected(), key=light?JSON.stringify([light.getSaveCopy(),targetNode(light)?.name]):'';
    if(key===signature)return;signature=key;form?.delete();form=null;panel.node.replaceChildren();if(!light)return;
    form=new InputForm({
      light_type:{label:'类型',type:'select',options:names,value:light.light_type},
      color:{label:'颜色',type:'color',value:light.color},
      power:{label:light.light_type==='SUN'?'强度':'功率',type:'number',min:0,value:light.power},
      radius:{label:'光源半径',type:'number',min:0.01,value:light.radius,condition:()=>light.light_type!=='AREA'},
      angle:{label:'聚光角度',type:'number',min:1,max:179,value:light.angle,condition:()=>light.light_type==='SPOT'},
      follow_target:{label:'跟随照射对象',type:'checkbox',value:light.follow_target,condition:()=>light.light_type!=='POINT'&&light.light_type!=='SPOT'}
    });panel.node.append(form.node);
    form.on('change',({result,changed_keys=[]})=>{const patch={};changed_keys.forEach(k=>patch[k]=result[k]);editing=true;try{edit(light,patch);signature=JSON.stringify([light.getSaveCopy(),targetNode(light)?.name]);}finally{editing=false;}if(changed_keys.includes('light_type')){signature='';refresh();}});
    if(light.light_type==='SPOT'){
      const picker=document.createElement('button');picker.title='吸管：点击可见模型表面对准';picker.append(Blockbench.getIconNode('colorize'),document.createTextNode('对准表面'));picker.onclick=()=>pick(light);panel.node.append(picker);
    } else if(light.light_type!=='POINT') {
      for(const [name,click] of [['点选照射对象',()=>pick(light)],['从大纲列表选择',()=>choose(light)],['照射对象：'+(targetNode(light)?.name||'无'),()=>targetNode(light)?.select()]]){const b=document.createElement('button');b.textContent=name;b.onclick=click;panel.node.append(b);}
    }
  }
  function migrate() {
    if(!Project)return;
    const old=Project.cycles_lights||[];
    if(old.length){for(const l of old){const light=new Light({...l,light_type:l.type}).addTo(Outliner.ROOT).init();if(l.target){const q=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3().fromArray(l.position),new THREE.Vector3().fromArray(l.target),new THREE.Vector3(0,1,0)));light.rotation=new THREE.Euler().setFromQuaternion(q,Format.euler_order).toArray().slice(0,3).map(n=>n*180/Math.PI);light.preview_controller.updateAll(light);}}Project.cycles_lights=[];Project.saved=false;}
    signature='';refresh();
  }
  listen('update_selection',refresh);listen('finished_edit',refresh);listen('undo',()=>{signature='';refresh();});listen('redo',()=>{signature='';refresh();});
  listen('select_project',migrate);listen('select_mode',()=>{cancelPick();signature='';refresh();});
  listen('unselect_project',()=>{finish(true);cancelPick();});
  Codecs.project.on('parsed',migrate);
  const timer=setInterval(refresh,250);migrate();
  return {Light,panel,refresh,add,aim,pick,choose,
    getLights(){refresh();return Light.all.filter(l=>{for(let n=l;n instanceof OutlinerNode;n=n.parent)if(n.visibility===false)return false;return true;}).map(l=>{const position=l.mesh.getWorldPosition(new THREE.Vector3()),data={name:l.name,type:l.light_type,color:l.color,power:l.power,size:l.radius,angle:l.angle,position:position.toArray()};if(l.light_type==='AREA'){const scale=l.mesh.getWorldScale(new THREE.Vector3());data.width=(l.width??l.radius)*Math.abs(scale.x);data.height=(l.height??l.radius)*Math.abs(scale.y);data.quaternion=l.mesh.getWorldQuaternion(new THREE.Quaternion()).toArray();}if(l.light_type!=='POINT')data.target=position.clone().add(new THREE.Vector3(0,0,-1).applyQuaternion(l.mesh.getWorldQuaternion(new THREE.Quaternion())).multiplyScalar(16)).toArray();return data;});},
    dispose(){finish(true);disposed=true;clearInterval(timer);cancelPick();cursorStyle.delete();window.removeEventListener('blur',blur);document.removeEventListener('pointerdown',capture,true);document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',up,true);document.removeEventListener('keydown',escape,true);Codecs.project.removeListener('parsed',migrate);hooks.forEach(([e,f])=>Blockbench.removeListener(e,f));form?.delete();panel.delete();actions.forEach(a=>a.delete());for(const l of Project?Light.all:[])disposeGuide(l.mesh);}
  };
}
