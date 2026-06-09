const options = document.getElementById("orboptions");
const pane = document.getElementById("orbpane");
const canvas = document.getElementById("orbcanvas");
const context = canvas.getContext("webgpu");

const pathShaders = `
struct Point {
  pos: vec4f,
  color: vec4f,
}

struct Uniforms {
  mvpMatrix: mat4x4<f32>, 
  resolution: vec2<f32>,
}

@group(0) @binding(0) var<storage, read> points: array<Point>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

struct VertexOut {
  @builtin(position) position : vec4f,
  @location(0) color : vec4f
}

@vertex
fn vertex_main(@builtin(vertex_index) v_idx: u32) -> VertexOut {
  let segment_idx = v_idx / 6u;
  let local_v_idx = v_idx % 6u;

  let p1_world = points[segment_idx];
  let p2_world = points[segment_idx + 1u];

  if (p1_world.pos.w == 0.0 || p2_world.pos.w == 0.0) {
    var output : VertexOut;
    output.position = vec4f(2.0, 2.0, 2.0, 1.0);
    output.color = vec4f(0.0);
    return output;
  }

  let p1_clip = uniforms.mvpMatrix * p1_world.pos;
  let p2_clip = uniforms.mvpMatrix * p2_world.pos;

  let p1_ndc = p1_clip.xy / p1_clip.w;
  let p2_ndc = p2_clip.xy / p2_clip.w;

  let res = uniforms.resolution;

  let p1_screen = (p1_ndc * 0.5 + 0.5) * res;
  let p2_screen = (p2_ndc * 0.5 + 0.5) * res;

  let dir = p2_screen - p1_screen;
  let len = length(dir);
  
  var normal = vec2f(0.0, 0.0);
  if (len > 0.0) {
    normal = normalize(vec2f(-dir.y, dir.x));
  }
  
  let thickness_pixels = 4.0; 
  let offset_screen = normal * (thickness_pixels / 2.0);

  var pos_screen: vec2f;
  var col: vec4f;
  var clip_z: f32;
  var clip_w: f32;

  if (local_v_idx == 0u || local_v_idx == 3u) {
      pos_screen = p1_screen + offset_screen;
      col = p1_world.color;
      clip_z = p1_clip.z; clip_w = p1_clip.w;
  } else if (local_v_idx == 1u) {
      pos_screen = p1_screen - offset_screen;
      col = p1_world.color;
      clip_z = p1_clip.z; clip_w = p1_clip.w;
  } else if (local_v_idx == 2u || local_v_idx == 4u) {
      pos_screen = p2_screen - offset_screen;
      col = p2_world.color;
      clip_z = p2_clip.z; clip_w = p2_clip.w;
  } else { 
      pos_screen = p2_screen + offset_screen;
      col = p2_world.color;
      clip_z = p2_clip.z; clip_w = p2_clip.w;
  }

  let pos_ndc = (pos_screen / res) * 2.0 - 1.0;

  var output : VertexOut;
  output.position = vec4f(pos_ndc * clip_w, clip_z, clip_w);
  output.color = col;
  return output;
}

@fragment
fn fragment_main(fragData: VertexOut) -> @location(0) vec4f {
  return fragData.color;
}
`;

const markerShaderModel = `
struct Point {
  pos: vec4f,
  color: vec4f,
}

struct Uniforms {
  mvpMatrix: mat4x4<f32>, 
  resolution: vec2<f32>,
}

@group(0) @binding(0) var<storage, read> markers: array<Point>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

struct VertexOut {
  @builtin(position) position : vec4f,
  @location(0) color : vec4f,
  @location(1) local_pos : vec2f
}

@vertex
fn vertex_main(@builtin(vertex_index) v_idx: u32) -> VertexOut {
  let marker_idx = v_idx / 6u;
  let local_v_idx = v_idx % 6u;

  let center_point = markers[marker_idx];

  let center_clip = uniforms.mvpMatrix * center_point.pos;
  let center_ndc = center_clip.xy / center_clip.w;
  let res = uniforms.resolution;
  let center_screen = (center_ndc * 0.5 + 0.5) * res;

  var corners = array<vec2f, 6>(
    vec2f(-1.0,  1.0),
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0)
  );
  
  let local_offset = corners[local_v_idx];

  let marker_radius_pixels = 10.0;
  let pos_screen = center_screen + (local_offset * marker_radius_pixels);

  let pos_ndc = (pos_screen / res) * 2.0 - 1.0;

  var output : VertexOut;
  output.position = vec4f(pos_ndc * center_clip.w, center_clip.z, center_clip.w);
  output.color = center_point.color;
  output.local_pos = local_offset;
  
  return output;
}

@fragment
fn fragment_main(fragData: VertexOut) -> @location(0) vec4f {
  let dist = length(fragData.local_pos);
  
  if (dist > 1.0) {
    discard; 
  }

  return fragData.color;
}
`;

function createOrthographicMatrix(left, right, bottom, top, near, far) {
  return new Float32Array([
    2 / (right - left), 0, 0, 0,
    0, 2 / (top - bottom), 0, 0,
    0, 0, -2 / (far - near), 0,
    -(right + left) / (right - left), -(top + bottom) / (top - bottom), -(far + near) / (far - near), 1
  ]);
}

let period = 10.0;
let eccentricity = 0.5;
let t0 = 0.0;
const t0input = document.getElementById("t0");
let sMA = 5.0;
let inc = 0.0;
let arg = 0.0;
let long = 0.0;

let A = 0;
const Ainput = document.getElementById("A");
let B = 0;
const Binput = document.getElementById("B");
let F = 0;
const Finput = document.getElementById("F");
let G = 0;
const Ginput = document.getElementById("G");
function thieleInnes() {
  A = sMA * (Math.cos(long)*Math.cos(arg) - Math.sin(long)*Math.sin(arg)*Math.cos(inc));
  B = sMA * (Math.sin(long)*Math.cos(arg) + Math.cos(long)*Math.sin(arg)*Math.cos(inc));
  F = sMA * (-Math.cos(long)*Math.sin(arg) - Math.sin(long)*Math.cos(arg)*Math.cos(inc));
  G = sMA * (-Math.sin(long)*Math.sin(arg) + Math.cos(long)*Math.cos(arg)*Math.cos(inc));
  Ainput.value = A.toFixed(3);
  Binput.value = B.toFixed(3);
  Finput.value = F.toFixed(3);
  Ginput.value = G.toFixed(3);
  Ainput.max = sMA.toString();
  Binput.max = sMA.toString();
  Finput.max = sMA.toString();
  Ginput.max = sMA.toString();
  Ainput.min = (-sMA).toString();
  Binput.min = (-sMA).toString();
  Finput.min = (-sMA).toString();
  Ginput.min = (-sMA).toString();
}
thieleInnes();


document.getElementById("period").addEventListener("input", (e) => {
    period = parseFloat(e.target.value);
    t0input.max = period.toString();
});

document.getElementById("t0").addEventListener("input", (e) => {
    t0 = parseFloat(e.target.value);
});

document.getElementById("eccentricity").addEventListener("input", (e) => {
    eccentricity = parseFloat(e.target.value);
});

document.getElementById("semi-major-axis").addEventListener("input", (e) => {
    sMA = parseFloat(e.target.value);
    thieleInnes();
    Ainput.max = sMA.toString();
    Binput.max = sMA.toString();
    Finput.max = sMA.toString();
    Ginput.max = sMA.toString();
    Ainput.min = (-sMA).toString();
    Binput.min = (-sMA).toString();
    Finput.min = (-sMA).toString();
    Ginput.min = (-sMA).toString();
});

document.getElementById("inclination").addEventListener("input", (e) => {
    inc = parseFloat(e.target.value) * Math.PI / 180.0;
    thieleInnes();
});

document.getElementById("argument-of-periapsis").addEventListener("input", (e) => {
    arg = parseFloat(e.target.value) * Math.PI / 180.0;
    thieleInnes();
});

document.getElementById("longitude-of-ascending-node").addEventListener("input", (e) => {
    long = parseFloat(e.target.value) * Math.PI / 180.0;
    thieleInnes();
});

function M(t) {
    return 2 * Math.PI * (t - t0) / period;
}

function E(M, e) {
    let E = M;
    for (let i = 0; i < 10; i++) {
        E = M + e * Math.sin(E);
    }
    return E;
}

function X(E, e) {
    return Math.cos(E) - e;
}

function Y(E, e) {
    return Math.sqrt(1 - e*e) * Math.sin(E);
}

async function init() {
  if (!navigator.gpu) throw Error("WebGPU not supported.");
  
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error("Couldn't request WebGPU adapter.");
  
  const device = await adapter.requestDevice();

  context.configure({
    device: device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: "premultiplied",
  });

  const pathShaderModule = device.createShaderModule({ code: pathShaders });
  const markerShaderModule = device.createShaderModule({ code: markerShaderModel });

  const BREAK = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  const N = 1000;
  const rawPoints = new Float32Array(N * 8);
  const pointCount = rawPoints.length / 8;

  const rawMarkers = new Float32Array([
    200.0, 200.0, 0.0, 1.0,    1.0, 1.0, 0.0, 1.0,
    300.0, 300.0, 0.0, 1.0,    0.0, 1.0, 1.0, 1.0,
  ]);
  const markerCount = rawMarkers.length / 8;

  const pointsBuffer = device.createBuffer({
    size: rawPoints.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const markerBuffer = device.createBuffer({
    size: rawMarkers.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  canvas.width = canvas.clientWidth || 800;
  canvas.height = canvas.clientHeight || 600;

  const uniformBuffer = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const pipelineDescriptor = {
    vertex: {
      module: pathShaderModule,
      entryPoint: "vertex_main",
    },
    fragment: {
      module: pathShaderModule,
      entryPoint: "fragment_main",
      targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
    },
    primitive: { topology: "triangle-list" },
    layout: "auto",
  };
  const renderPipeline = device.createRenderPipeline(pipelineDescriptor);

  const markerPipeline = device.createRenderPipeline({
    vertex: { module: markerShaderModule, entryPoint: "vertex_main" },
    fragment: {
      module: markerShaderModule,
      entryPoint: "fragment_main",
      targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
    },
    primitive: { topology: "triangle-list" },
    layout: "auto",
  });

  const bindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
        { binding: 0, resource: { buffer: pointsBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
    ],
  });

  const markerBindGroup = device.createBindGroup({
    layout: markerPipeline.getBindGroupLayout(0),
    entries: [
        { binding: 0, resource: { buffer: markerBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
    ],
  });

  function resizeCanvasToDisplaySize(canvas, device) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width * window.devicePixelRatio);
    const height = Math.round(rect.height * window.devicePixelRatio);

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        
        context.configure({
            device: device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: "premultiplied",
        });
    }
  }

  function frame(timestamp) {
    resizeCanvasToDisplaySize(canvas, device);
    const time = timestamp / 1000.0;

    for (let i = 0; i < pointCount; i++) {
        const stride = i * 8;
        M = i / (pointCount-1) * 2 * Math.PI;
        Evalue = E(M, eccentricity);
        Xvalue = X(Evalue, eccentricity);
        Yvalue = Y(Evalue, eccentricity);
        rawPoints[stride+0] = 50*(A*Xvalue + F*Yvalue);
        rawPoints[stride+1] = 50*(B*Xvalue + G*Yvalue);
        rawPoints[stride+2] = 0.0;
        rawPoints[stride+3] = 1.0;
        rawPoints[stride+4] = Math.abs(500-i) / pointCount;
        rawPoints[stride+5] = 0.3*(Math.cos(time*3)+1.0);           
        rawPoints[stride+6] = 1.0 - Math.abs(500-i) / pointCount;
        rawPoints[stride+7] = 1.0;
    }
    device.queue.writeBuffer(pointsBuffer, 0, rawPoints);

    // Center of mass marker
    rawMarkers[0] = 0.0;
    rawMarkers[1] = 0.0;
    rawMarkers[2] = 0.0;
    rawMarkers[3] = 1.0;
    rawMarkers[4] = 1.0;
    rawMarkers[5] = 1.0;
    rawMarkers[6] = 1.0;
    rawMarkers[7] = 1.0;

    Mmarker = (time - t0) / period * 2 * Math.PI;
    Emarker = E(Mmarker, eccentricity);
    Xmarker = X(Emarker, eccentricity);
    Ymarker = Y(Emarker, eccentricity);
    rawMarkers[8] = 50*(A*Xmarker + F*Ymarker);
    rawMarkers[9] = 50*(B*Xmarker + G*Ymarker);
    rawMarkers[10] = 0.0;
    rawMarkers[11] = 1.0;
    rawMarkers[12] = 1.0;
    rawMarkers[13] = 0.0;
    rawMarkers[14] = 0.0;
    rawMarkers[15] = 1.0;
    device.queue.writeBuffer(markerBuffer, 0, rawMarkers);

    const cameraX = 0;
    const cameraY = 0;
    const cameraHeight = canvas.height*1.5;
    const cameraWidth = canvas.width*1.5;
    const cameraMatrix = createOrthographicMatrix(cameraX - cameraWidth / 2, cameraX + cameraWidth / 2, cameraY - cameraHeight / 2, cameraY + cameraHeight / 2, -1, 1);
    const resolutionArray = new Float32Array([canvas.width, canvas.height]);
    device.queue.writeBuffer(uniformBuffer, 0, cameraMatrix);
    device.queue.writeBuffer(uniformBuffer, 64, resolutionArray);
    

    const commandEncoder = device.createCommandEncoder();
    const renderPassDescriptor = {
        colorAttachments: [
        {
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
            loadOp: "clear",
            storeOp: "store",
            view: context.getCurrentTexture().createView(),
        },
        ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(renderPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(pointCount * 6);

    passEncoder.setPipeline(markerPipeline);
    passEncoder.setBindGroup(0, markerBindGroup);
    passEncoder.draw(markerCount * 6);
    
    passEncoder.end();

    device.queue.submit([commandEncoder.finish()]);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

try {
  init();
} catch (error) {
  pane.innerText = error.message;
}