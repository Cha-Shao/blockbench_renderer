import * as T from 'three';
import { initUNetFromBuffer } from 'oidn-webgpu';
import weights from 'oidn-small-weights';

function flipRows(input,width,height){const output=new Float32Array(input.length),stride=width*4;for(let y=0;y<height;y++)output.set(input.subarray(y*stride,(y+1)*stride),(height-y-1)*stride);return output;}
function guideMaterial(material){return new T.ShaderMaterial({
  side:material.side,depthWrite:true,transparent:false,toneMapped:false,
  uniforms:{map:{value:material.map},hasMap:{value:!!material.map},color:{value:material.color||new T.Color(1,1,1)},opacity:{value:material.opacity??1},alphaTest:{value:material.alphaTest||0.01},normalPass:{value:false}},
  vertexShader:'varying vec2 vUv;varying vec3 vNormal;void main(){vUv=uv;vNormal=normalMatrix*normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader:`uniform sampler2D map;uniform bool hasMap;uniform bool normalPass;uniform vec3 color;uniform float opacity;uniform float alphaTest;varying vec2 vUv;varying vec3 vNormal;
  void main(){vec4 texel=hasMap?texture2D(map,vUv):vec4(1.0);if(texel.a*opacity<alphaTest)discard;vec3 n=normalize(vNormal)*(gl_FrontFacing?1.0:-1.0);gl_FragColor=vec4(normalPass?n*0.5+0.5:texel.rgb*color,1.0);}`
});}

export class SmallOIDN {
  constructor(onState=()=>{}){this.onState=onState;this.epoch=0;this.busy=false;this.disposed=false;}
  cancel(){++this.epoch;this.abort?.();this.abort=null;this.texture?.dispose();this.texture=null;this.busy=false;this.error=null;this.onState('idle');}
  async model(){
    if(!this.modelPromise)this.modelPromise=(async()=>{
      if(!navigator.gpu)throw Error('当前环境不支持 WebGPU');
      const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('没有可用的 WebGPU 设备');
      if(this.disposed)throw Error('渲染窗口已关闭');
      const keys=['maxComputeWorkgroupStorageSize','maxComputeWorkgroupsPerDimension','maxStorageBufferBindingSize','maxBufferSize','maxComputeWorkgroupSizeX','maxComputeInvocationsPerWorkgroup'];
      const device=await adapter.requestDevice({requiredFeatures:adapter.features.has('shader-f16')?['shader-f16']:[],requiredLimits:Object.fromEntries(keys.map(k=>[k,adapter.limits[k]]))});this.device=device;
      if(this.disposed){device.destroy();throw Error('渲染窗口已关闭');}
      const binary=atob(weights),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
      const model=await initUNetFromBuffer(bytes.buffer,{device},{hdr:true,aux:true,precision:'auto',maxTileSize:256,dynamicTile:false});
      if(this.disposed){model.dispose();device.destroy();throw Error('渲染窗口已关闭');}
      this.unet=model;return model;
    })();
    return this.modelPromise;
  }
  inputs(session){
    const {renderer,scene,camera,width,height}=session;
    const data=new Float32Array(width*height*4);renderer.readRenderTargetPixels(session.pathTracer.target,0,0,width,height,data);
    const color={data:flipRows(data,width,height),width,height};
    const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,format:T.RGBAFormat,minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    const originals=[],temporary=new Map(),current=renderer.getRenderTarget(),toneMapping=renderer.toneMapping,autoClear=renderer.autoClear,clear=renderer.getClearColor(new T.Color()),alpha=renderer.getClearAlpha(),background=scene.background;
    const materialFor=m=>{if(!temporary.has(m))temporary.set(m,guideMaterial(m));return temporary.get(m);};
    try{
      scene.traverse(object=>{if(!object.isMesh)return;originals.push([object,object.material]);object.material=Array.isArray(object.material)?object.material.map(materialFor):materialFor(object.material);});
      renderer.toneMapping=T.NoToneMapping;renderer.autoClear=true;scene.background=null;renderer.setRenderTarget(target);
      renderer.setClearColor(0,0);renderer.render(scene,camera);
      const albedo=new Float32Array(data.length);renderer.readRenderTargetPixels(target,0,0,width,height,albedo);
      for(const m of temporary.values())m.uniforms.normalPass.value=true;
      renderer.setClearColor(new T.Color(0.5,0.5,0.5),0);renderer.render(scene,camera);
      const normal=new Float32Array(data.length);renderer.readRenderTargetPixels(target,0,0,width,height,normal);
      return {color,albedo:{data:flipRows(albedo,width,height),width,height},normal:{data:flipRows(normal,width,height),width,height}};
    }finally{originals.forEach(([object,material])=>object.material=material);scene.background=background;renderer.setRenderTarget(current);renderer.toneMapping=toneMapping;renderer.autoClear=autoClear;renderer.setClearColor(clear,alpha);target.dispose();for(const m of temporary.values())m.dispose();}
  }
  async run(session){
    if(this.busy||this.texture||this.error||this.disposed)return;
    const epoch=++this.epoch;this.busy=true;this.onState('loading');
    const valid=()=>!this.disposed&&epoch===this.epoch;
    const fail=reason=>{if(!valid())return;this.busy=false;this.abort=null;this.error=String(reason?.message||reason);this.onState('error',this.error);};
    try{
      const model=await this.model();if(!valid())return;
      this.onState('running');const input=this.inputs(session);
      this.abort=model.tileExecute({...input,scheduling:'event-loop',done:output=>{
        if(!valid())return;
        // OIDN's CPU HDR API writes opaque alpha. Preserve the path tracer's original transparency.
        for(let i=3;i<output.data.length;i+=4)output.data[i]=input.color.data[i];
        const texture=new T.DataTexture(flipRows(output.data,output.width,output.height),output.width,output.height,T.RGBAFormat,T.FloatType);
        texture.minFilter=texture.magFilter=T.NearestFilter;texture.needsUpdate=true;
        this.texture=texture;this.busy=false;this.abort=null;this.onState('ready');session.redraw();
      },error:fail});
    }catch(error){fail(error);}
  }
  dispose(){this.cancel();this.disposed=true;this.unet?.dispose();this.device?.destroy();}
}
