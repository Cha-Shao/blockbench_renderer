// Isolated Three.js r163 runtime. Bundled locally; does not replace Blockbench's THREE.
import * as T from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { WebGLPathTracer, PhysicalSpotLight } from 'three-gpu-pathtracer';

const LIMITS = {low: 2048, high: 2048};
export function dimensions(width, height, mode) {
  const w = Math.max(64, Math.min(LIMITS[mode] || 2048, Math.round(Number(width) || 512)));
  const h = Math.max(64, Math.min(LIMITS[mode] || 2048, Math.round(Number(height) || 512)));
  return [w, h];
}
export function sampleCount(value) { return Math.max(20, Math.min(4096, Math.floor(Number(value) || 128))); }
export function installAreaLightTables(legacy) {
  RectAreaLightUniformsLib.init();
  for(const key of ['LTC_FLOAT_1','LTC_FLOAT_2','LTC_HALF_1','LTC_HALF_2'])if(!legacy.UniformsLib[key]){const source=T.UniformsLib[key],tex=new legacy.DataTexture(source.image.data,64,64,legacy.RGBAFormat,source.type);tex.minFilter=legacy.LinearFilter;tex.magFilter=legacy.NearestFilter;tex.needsUpdate=true;legacy.UniformsLib[key]=tex;}
}
function environment(brightness) {
  const w = 256, h = 128, pixels = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const sky = 0.12 + 0.55 * (1 - y / h);
    const box = y > 22 && y < 54 && ((x > 24 && x < 55) || (x > 160 && x < 181));
    pixels[i] = brightness * (box ? 5 : sky * 0.86);
    pixels[i + 1] = brightness * (box ? 4.8 : sky * 0.93);
    pixels[i + 2] = brightness * (box ? 4.5 : sky);
    pixels[i + 3] = 1;
  }
  const texture = new T.DataTexture(pixels, w, h, T.RGBAFormat, T.FloatType);
  texture.mapping = T.EquirectangularReflectionMapping; texture.needsUpdate = true;
  return texture;
}
const coord = a => new T.Vector3(a[0] / 16, -a[2] / 16, a[1] / 16);
export class RenderSession {
  get samplesGoal() { return this._samplesGoal; }
  set samplesGoal(value) { this._samplesGoal = sampleCount(value); }
  constructor(canvas, onStatus = () => {}) {
    this.canvas = canvas; this.onStatus = onStatus; this.mode = 'low'; this.disposed = false;
    this.resources = new Set(); this.generation = 0; this.frame = 0; this.started = performance.now();
    this.renderer = new T.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true});
    this.renderer.setPixelRatio(1); this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping; this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    if (!this.renderer.extensions.has('EXT_color_buffer_float')) this.highUnsupported = '当前 GPU 不支持浮点渲染目标';
    this.renderer.debug.onShaderError = () => { this.failed = true; this.onStatus('GPU 着色器编译失败，请切换低精档'); };
    this.contextLost = e => { e.preventDefault(); this.failed = true; this.onStatus('GPU 上下文丢失，请关闭后重新打开渲染窗口'); };
    canvas.addEventListener('webglcontextlost', this.contextLost);
    RectAreaLightUniformsLib.init();
  }
  keep(resource) { this.resources.add(resource); return resource; }
  async loadTexture(url, color, token) {
    const texture = await new T.TextureLoader().loadAsync(url);
    if (this.disposed || token !== this.generation) { texture.dispose(); throw Error('渲染窗口已关闭或刷新'); }
    texture.colorSpace = color ? T.SRGBColorSpace : T.NoColorSpace;
    texture.magFilter = texture.minFilter = T.NearestFilter; texture.generateMipmaps = false;
    texture.wrapS = texture.wrapT = T.RepeatWrapping;
    return this.keep(texture);
  }
  clearScene() {
    // v0.0.23's public dispose references a removed _renderQuad. Keep the workaround version-scoped.
    if (this.pathTracer) {
      const pt = this.pathTracer;
      pt._quad.material.dispose(); pt._quad.dispose();
      for (const tracer of [pt._pathTracer, pt._lowResPathTracer]) {
        tracer.material.dispose(); tracer._blendQuad.material.dispose(); tracer.dispose();
      }
      pt._internalBackground?.dispose();
      pt._generator.dispose?.();
    }
    this.pathTracer = null;
    this.scene?.traverse(o => o.shadow?.dispose());
    this.controls?.dispose(); this.controls = null;
    this.resources.forEach(r => r.dispose()); this.resources.clear();
    this.scene = null;
  }
  async load(data, options) {
    const token = ++this.generation; this.ready = false; this.failed = false;
    cancelAnimationFrame(this.frame); this.clearScene();
    this.data = data; this.options = {...options}; this.samplesGoal = options.samples;
    this.onStatus('正在读取材质和模型…');
    const scene = this.scene = new T.Scene();
    const env = this.keep(environment(Number(options.world) || 0));
    scene.environment = env; scene.background = options.transparent ? null : new T.Color('#252a35');
    const pmrem = new T.PMREMGenerator(this.renderer);
    const target = this.keep(pmrem.fromEquirectangular(env)); pmrem.dispose();
    this.rawEnvironment = env; this.previewEnvironment = target.texture;
    const materialTable = {};
    for (const [id, maps] of Object.entries(data.materials)) {
      const m = this.keep(new T.MeshStandardMaterial({roughness: 0.5, metalness: maps.metallic ? 1 : 0, side: T.DoubleSide}));
      for (const [channel, url] of Object.entries(maps)) {
        const texture = await this.loadTexture(url, channel === 'color', token);
        if (channel === 'color') { m.map = texture; m.transparent = true; m.alphaTest = 0.01; }
        if (channel === 'roughness') { m.roughnessMap = texture; m.roughness = 1; }
        if (channel === 'metallic') m.metalnessMap = texture;
      }
      materialTable[id] = m;
    }
    if (token !== this.generation || this.disposed) return;
    for (const item of data.meshes) {
      if (item.vertices.length < 3) continue;
      const geometry = this.keep(new T.BufferGeometry());
      geometry.setAttribute('position', new T.Float32BufferAttribute(item.vertices.flat(), 3));
      geometry.setAttribute('uv', new T.Float32BufferAttribute(item.uvs.flat(), 2));
      geometry.computeVertexNormals();
      const material = materialTable[item.material] || this.keep(new T.MeshStandardMaterial({color: item.color || '#ffffff', roughness: 0.6, side: T.DoubleSide}));
      const mesh = new T.Mesh(geometry, material); mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh);
    }
    const bounds = new T.Box3().setFromObject(scene);
    if (bounds.isEmpty()) throw Error('当前工程没有可见模型');
    const size = bounds.getSize(new T.Vector3()), center = bounds.getCenter(new T.Vector3()), span = Math.max(size.x, size.y, size.z, 0.1);
    const lights = data.lights.length ? data.lights : [
      {name: '默认主光', type: 'AREA', color: '#fff2de', power: 100, size: span * 24, position: [(center.x + span * 2) * 16, (center.z + span * 3) * 16, -(center.y + span * 2) * 16], target: [center.x * 16, center.z * 16, -center.y * 16]},
      {name: '默认轮廓光', type: 'AREA', color: '#c8dcff', power: 100, size: span * 16, position: [(center.x - span * 2) * 16, (center.z + span) * 16, -(center.y - span * 2) * 16], target: [center.x * 16, center.z * 16, -center.y * 16]}
    ];
    for (const l of lights) this.addLight(l, span);
    const aspect = Number(options.width) / Number(options.height), c = data.camera;
    this.camera = c.ortho ? new T.OrthographicCamera(-c.scale * aspect / 2, c.scale * aspect / 2, c.scale / 2, -c.scale / 2, 0.001, 10000) : new T.PerspectiveCamera(c.fov, aspect, 0.001, 10000);
    this.camera.up.set(0, 0, 1); this.camera.position.fromArray(c.position);
    this.camera.lookAt(new T.Vector3().fromArray(c.target)); this.camera.updateMatrixWorld();
    this.controls = new OrbitControls(this.camera, this.canvas); this.controls.target.fromArray(c.target); this.controls.update();
    this.controls.addEventListener('change', () => { this.pathTracer?.updateCamera(); this.started = performance.now(); this.completed = false; this.dirty = true; });
    this.setSize(options.width, options.height);
    this.ready = true; this.paused = false; this.setMode(options.mode || 'low');
    this.animate();
  }
  addLight(l, span) {
    const color = new T.Color(l.color), power = Math.max(0, Number(l.power) || 0), width = Math.max(0.01, Number(l.size) / 16);
    let light;
    if (l.type === 'AREA') {const w=Math.max(0.001,Number(l.width??l.size)/16),h=Math.max(0.001,Number(l.height??l.size)/16);light = new T.RectAreaLight(color,power/(Math.PI*w*h),w,h);}
    else if (l.type === 'SUN') light = new T.DirectionalLight(color, power);
    else if (l.type === 'SPOT') {
      light = new PhysicalSpotLight(color, 1); light.power = power;
      light.angle = (Number(l.angle) || 45) * Math.PI / 360; light.penumbra = 0.2; light.radius = width;
    } else { light = new T.PointLight(color, 1); light.power = power; }
    light.position.copy(coord(l.position));
    const target = l.target ? coord(l.target) : light.position.clone().add(new T.Vector3(0,0,-1));
    if (light.target) { light.target.position.copy(target); this.scene.add(light.target); }
    else light.lookAt(target);
    if(l.type==='AREA'&&l.quaternion)light.quaternion.copy(new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),Math.PI/2).multiply(new T.Quaternion().fromArray(l.quaternion)));
    light.castShadow = l.type !== 'AREA';
    if (light.shadow) {
      light.shadow.mapSize.set(1024, 1024); light.shadow.bias = -0.0001; light.shadow.normalBias = 0.015;
      light.shadow.camera.near = 0.01; light.shadow.camera.far = Math.max(100, span * 30);
      if (l.type === 'SUN') Object.assign(light.shadow.camera, {left: -span * 3, right: span * 3, top: span * 3, bottom: -span * 3});
    }
    this.scene.add(light);
    // Rasterized area lights do not cast shadows. A matching spotlight supplies the preview shadow.
    if (l.type === 'AREA') {
      const shadow = new T.SpotLight(color, 0.3 * power / Math.PI, 0, Math.PI * 0.45, 0.8, 2);
      shadow.position.copy(light.position); shadow.target.position.copy(target); shadow.castShadow = true;
      shadow.shadow.mapSize.set(1024, 1024); shadow.shadow.normalBias = 0.015;
      shadow.userData.previewOnly = true; this.scene.add(shadow, shadow.target);
    }
  }
  setSize(width, height) {
    const [w, h] = dimensions(width, height, this.mode); this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.canvas.style.aspectRatio = `${w} / ${h}`;
    if (this.camera?.isPerspectiveCamera) this.camera.aspect = w / h;
    else if (this.camera) { const half = (this.camera.top - this.camera.bottom) / 2; this.camera.left = -half * w / h; this.camera.right = half * w / h; }
    this.camera?.updateProjectionMatrix(); this.pathTracer?.updateCamera(); this.pathTracer?.reset(); this.dirty = true;
  }
  setMode(mode) {
    if (!this.ready) return;
    if (mode === 'high' && this.highUnsupported) throw Error(this.highUnsupported);
    this.mode = mode === 'high' ? 'high' : 'low'; this.failed = false; this.completed = false;
    this.scene.traverse(o => { if (o.userData.previewOnly) o.visible = this.mode === 'low'; });
    this.scene.environment = this.mode === 'high' ? this.rawEnvironment : this.previewEnvironment;
    if (this.mode === 'high') {
      this.onStatus('正在建立光追加速结构、编译 GPU 着色器…');
      if (!this.pathTracer) {
        this.pathTracer = new WebGLPathTracer(this.renderer);
        this.pathTracer.bounces = 6; this.pathTracer.tiles.set(2, 2);
        this.pathTracer.textureSize.set(512, 512); this.pathTracer.multipleImportanceSampling = true;
        this.pathTracer.renderDelay = 0; this.pathTracer.minSamples = 1; this.pathTracer.fadeDuration = 0;
        this.pathTracer.filterGlossyFactor = 0.5;
      }
      this.pathTracer.setScene(this.scene, this.camera); this.pathTracer.reset();
    }
    this.paused = false; this.started = performance.now(); this.dirty = true;
  }
  reset() { this.pathTracer?.reset(); this.completed = false; this.paused = false; this.started = performance.now(); this.dirty = true; }
  animate() {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(() => this.animate());
    if (!this.ready || this.failed || this.paused) return;
    try {
      if (this.mode === 'low') {
        if (this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; this.onStatus(`低精度（实时PBR模式） · ${this.width} × ${this.height}`); }
      } else if (!this.completed) {
        this.pathTracer.renderSample(); const samples = Math.floor(this.pathTracer.samples);
        this.completed = samples >= this.samplesGoal;
        if (this.failed) return;
        this.onStatus(`高精度（GPU光追模式）${samples}/${this.samplesGoal}采样`);
      }
    } catch (e) { this.failed = true; this.onStatus('渲染失败：' + e.message + '；可切换低精档'); }
  }
  getPNG() {
    if (!this.ready || this.failed) throw Error('画面尚未准备好');
    if (this.mode === 'high' && (!this.pathTracer || this.pathTracer.samples < 20)) throw Error('请等待至少完成 20 轮光追采样');
    if (this.mode === 'low') this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; ++this.generation; cancelAnimationFrame(this.frame);
    this.clearScene();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
