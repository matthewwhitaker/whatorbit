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
  
  let thickness_pixels = 2.0; 
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

  let marker_radius_pixels = 5.0;
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
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const idx = i * 8;
    rawPoints[idx + 0] = 0.0;
    rawPoints[idx + 1] = 1.0 - 2.0 * t;
    rawPoints[idx + 2] = 0.0;
    rawPoints[idx + 3] = 1.0;
    rawPoints[idx + 4] = t;
    rawPoints[idx + 5] = 0.0;
    rawPoints[idx + 6] = 1.0 - t;
    rawPoints[idx + 7] = 1.0;
  }
  const pointCount = rawPoints.length / 8;

  const rawMarkers = new Float32Array([
    200.0, 200.0, 0.0, 1.0,    1.0, 1.0, 0.0, 1.0,
    300.0, 300.0, 0.0, 1.0,    0.0, 1.0, 1.0, 1.0,
    500.0, 500.0, 0.0, 1.0,    1.0, 0.0, 1.0, 1.0,
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

  function frame(timestamp) {
    canvas.height = canvas.clientHeight || 600;
    canvas.width = canvas.clientWidth || 800;
    const time = timestamp / 1000.0;

    for (let i = 0; i < pointCount; i++) {
        const stride = i * 8;
        rawPoints[stride] = i / pointCount * 1000.0 - 500.0;
        if(i > 500) {
            rawPoints[stride+1] = Math.cos((i+19) / 50 - 5*time) * 100;
        } else {
            rawPoints[stride+1] = Math.sin(i / 50 + 5*time) * 100;
        }
        if(i > 450 && i < 550 && i%3 == 0) {
            rawPoints[stride+3] = 0.0;
        }
        
        rawPoints[stride+4] = i / pointCount;
        rawPoints[stride+5] = 0.3*(Math.cos(time*3)+1.0);           
        rawPoints[stride+6] = 1.0 - i / pointCount;
        rawPoints[stride+7] = 1.0;
    }
    device.queue.writeBuffer(pointsBuffer, 0, rawPoints);

    for (let i = 0; i < markerCount; i++) {
        const stride = i * 8;
        rawMarkers[stride] = 100.0 * Math.cos(time + i);
        rawMarkers[stride+1] = 100.0 * Math.sin(time + i);
        rawMarkers[stride+2] = 0.0;
        rawMarkers[stride+3] = 1.0;

        rawMarkers[stride+4] = 1.0;
        rawMarkers[stride+5] = 1.0 - 0.5*(Math.cos(time*2)+1.0);
        rawMarkers[stride+6] = 0.5*(Math.cos(time*2)+1.0);
        rawMarkers[stride+7] = 1.0;
    }
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