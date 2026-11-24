// Realtime PBR uses Blockbench's own THREE and camera, preserving editing tools.
function installPBRViewport(getLights) {
  const mode='pbr_realtime', originals=new Map(),materials=new Map(),textures=new Map(),hooks=[],rendererState=new Map();
  let enabled=false,environment,environmentTarget,previousEnvironment,lamps,lightKey='',busy=false;
  BarItems.view_mode.options[mode]={name:'低精度（实时PBR模式）',icon:'light_mode'};
  const bar=BarItems.view_mode;
  if(!bar.values.includes(mode))bar.values.push(mode);
  for(const node of new Set(bar.nodes))if(bar.icon_mode&&!node.querySelector('[key="'+mode+'"]')){const option=document.createElement('div');option.className='select_option';option.setAttribute('key',mode);option.title='低精度（实时PBR模式）';option.append(Blockbench.getIconNode('light_mode'));option.addEventListener('click',e=>bar.change(mode,e));node.append(option);}
  const listen=(event,fn)=>{Blockbench.on(event,fn);hooks.push([event,fn]);};
  function texture(t,color=false){if(!t)return null;let value=textures.get(t.uuid);if(!value){value=new THREE.CanvasTexture(t.canvas);value.magFilter=value.minFilter=THREE.NearestFilter;value.generateMipmaps=false;value.encoding=color?THREE.sRGBEncoding:THREE.LinearEncoding;textures.set(t.uuid,value);}if(value.image!==t.canvas){value.image=t.canvas;value.needsUpdate=true;}return value;}
  function material(base){
    if(materials.has(base))return materials.get(base);
    const t=Texture.all.find(t=>!/_roughness|_metallic/.test(t.name)&&t.getOwnMaterial()?.map===base.map);
    const name=t?.name.replace(/\.png$/i,''),map=channel=>Texture.all.find(t=>t.name.replace(/\.png$/i,'')===name+'_'+channel);
    const rough=t?map('roughness'):null,metal=t?map('metallic'):null;
    const m=new THREE.MeshStandardMaterial({color:t?'#ffffff':(base.color||'#b0b0b0'),map:texture(t,true),roughnessMap:texture(rough),metalnessMap:texture(metal),roughness:rough?1:0.5,metalness:metal?1:0,side:base.side,transparent:!!t,alphaTest:0.01,visible:base.visible!==false});
    if(t)m.userData.pbrTextureUUID=t.uuid;
    materials.set(base,m);return m;
  }
  function enable(){
    enabled=true;previousEnvironment=Canvas.scene.environment;
    getNativeRuntime().installAreaLightTables(THREE);
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;const ctx=canvas.getContext('2d'),gradient=ctx.createLinearGradient(0,0,0,128);gradient.addColorStop(0,'#c4d2ec');gradient.addColorStop(1,'#282b35');ctx.fillStyle=gradient;ctx.fillRect(0,0,256,128);ctx.fillStyle='#ffffff';ctx.fillRect(24,20,30,40);ctx.fillRect(160,25,20,30);
    environment=new THREE.CanvasTexture(canvas);environment.mapping=THREE.EquirectangularReflectionMapping;environment.encoding=THREE.sRGBEncoding;
    const generator=new THREE.PMREMGenerator(Preview.selected.renderer);environmentTarget=generator.fromEquirectangular(environment);generator.dispose();Canvas.scene.environment=environmentTarget.texture;
    lamps=new THREE.Group();lamps.no_export=true;Canvas.scene.add(lamps);
    for(const p of Preview.all.filter(p=>!p.offscreen)){rendererState.set(p.renderer,{physical:p.renderer.physicallyCorrectLights,shadow:p.renderer.shadowMap.enabled});p.renderer.physicallyCorrectLights=true;p.renderer.shadowMap.enabled=true;}
  }
  function updateLights(){
    const data=getLights(),key=JSON.stringify(data);if(key===lightKey)return;lightKey=key;
    lamps.children.slice().forEach(o=>{o.shadow?.dispose();lamps.remove(o);});
    if(!data.length){const sun=new THREE.DirectionalLight('#fff1dd',2);sun.position.set(40,60,30);lamps.add(sun,new THREE.HemisphereLight('#d9e8ff','#34303b',0.4));return;}
    for(const d of data){let l;if(d.type==='AREA'){const w=Math.max(0.01,d.width??d.size),h=Math.max(0.01,d.height??d.size);l=new THREE.RectAreaLight(d.color,d.power/(Math.PI*(w/16)*(h/16)),w,h);}else if(d.type==='SUN')l=new THREE.DirectionalLight(d.color,d.power);else if(d.type==='SPOT')l=new THREE.SpotLight(d.color,d.power*256/Math.PI,0,d.angle*Math.PI/360,0.2,2);else l=new THREE.PointLight(d.color,d.power*256/(4*Math.PI),0,2);l.position.fromArray(d.position);if(l.target){l.target.position.fromArray(d.target||[0,0,0]);lamps.add(l.target);}if(d.type==='AREA'){if(d.quaternion)l.quaternion.fromArray(d.quaternion);else l.lookAt(new THREE.Vector3().fromArray(d.target||[0,0,0]));}l.castShadow=d.type!=='AREA';if(l.shadow){l.shadow.mapSize.set(512,512);l.shadow.normalBias=0.08;l.shadow.camera.near=0.1;l.shadow.camera.far=4096;if(d.type==='SUN')Object.assign(l.shadow.camera,{left:-128,right:128,top:128,bottom:-128});}lamps.add(l);}
  }
  function apply(){
    if(busy)return;if(!Project||Project.view_mode!==mode){disable();return;}
    busy=true;
    try{if(!enabled)enable();
      for(const e of Outliner.elements){const mesh=e.mesh;if(!mesh?.isMesh||e.type==='pbr_light')continue;
        let state=originals.get(mesh);const own=m=>Array.from(materials.values()).includes(m);
        if(!state){state={material:mesh.material,cast:mesh.castShadow,receive:mesh.receiveShadow};originals.set(mesh,state);}
        else if(Array.isArray(mesh.material)?!mesh.material.every(own):!own(mesh.material))state.material=mesh.material;
        mesh.material=Array.isArray(state.material)?state.material.map(material):material(state.material);mesh.castShadow=mesh.receiveShadow=true;
      }updateLights();
    }finally{busy=false;}
  }
  function disable(){if(!enabled)return;
    for(const [mesh,state]of originals){const own=m=>Array.from(materials.values()).includes(m);if(Array.isArray(mesh.material)?mesh.material.every(own):own(mesh.material))mesh.material=state.material;mesh.castShadow=state.cast;mesh.receiveShadow=state.receive;}originals.clear();
    for(const m of materials.values())m.dispose();materials.clear();for(const t of textures.values())t.dispose();textures.clear();
    for(const [r,s]of rendererState){r.physicallyCorrectLights=s.physical;r.shadowMap.enabled=s.shadow;}rendererState.clear();
    Canvas.scene.environment=previousEnvironment;environmentTarget?.dispose();environment?.dispose();lamps?.traverse(o=>o.shadow?.dispose());lamps?.parent?.remove(lamps);lightKey='';enabled=false;
  }
  const controllers=[Cube.preview_controller,Mesh.preview_controller];controllers.forEach(c=>c.on('update_faces',apply));
  listen('change_view_mode',apply);listen('select_project',apply);listen('unselect_project',disable);
  listen('edit_texture',({texture:t})=>{const m=textures.get(t.uuid);if(m){m.image=t.canvas;m.needsUpdate=true;}});
  listen('add_texture',()=>{if(enabled){disable();apply();}});listen('remove_texture',()=>{if(enabled){disable();apply();}});
  const timer=setInterval(apply,250);apply();
  return {mode,apply,dispose(){clearInterval(timer);if(Project?.view_mode===mode)bar.change('textured');disable();if(bar.value===mode)bar.value='textured';controllers.forEach(c=>c.removeListener('update_faces',apply));hooks.forEach(([e,f])=>Blockbench.removeListener(e,f));delete bar.options[mode];bar.values=bar.values.filter(v=>v!==mode);bar.nodes.forEach(n=>n.querySelector('[key="'+mode+'"]')?.remove());}};
}
