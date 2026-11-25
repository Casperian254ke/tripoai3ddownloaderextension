const params = new URLSearchParams(location.search);
const sourceUrl = params.get('url');
const filename = params.get('name') || 'model';
const format = (params.get('format') || '').toUpperCase();
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
$('filename').textContent = filename;
$('format').textContent = `Detected format: ${format || 'unknown'}`;
$('original').disabled = !sourceUrl;
$('convert').disabled = !sourceUrl || !['GLB', 'GLTF'].includes(format);

const blenderFormats = new Set(['GLB','GLTF','FBX','OBJ','STL','DAE','USDZ','USD','3DS','PLY','BLEND']);
if (blenderFormats.has(format)) {
  $('original').textContent = `Download original${['GLB','GLTF'].includes(format) ? ' (recommended)' : ''}`;
} else {
  $('original').textContent = 'Download original file';
}
if (!['GLB','GLTF'].includes(format)) {
  $('convert').title = 'Local OBJ conversion currently supports GLB and glTF inputs.';
  status('Choose Download original to save this model. Blender can import common model formats directly.');
} else {
  status('Ready. Original GLB/glTF is the best choice for preserving Blender materials.');
}

async function getBytes() {
  const response = await fetch(sourceUrl, { credentials: 'include' });
  if (!response.ok) throw new Error(`Could not fetch model (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}
function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function safeName(name) { return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'model'; }
function makeZip(files) {
  const enc=new TextEncoder(), entries=[], central=[]; let offset=0;
  const crc32=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
  const put16=(v,n)=>{v.push(n&255,(n>>>8)&255);}, put32=(v,n)=>{put16(v,n&65535);put16(v,Math.floor(n/65536));};
  for(const file of files){const name=enc.encode(file.name),data=enc.encode(file.data),crc=crc32(data),local=[];
    put32(local,0x04034b50);put16(local,20);put16(local,0x800);put16(local,0);put16(local,0);put16(local,0);put32(local,crc);put32(local,data.length);put32(local,data.length);put16(local,name.length);put16(local,0);
    const header=new Uint8Array(local.length+name.length);header.set(local);header.set(name,local.length);entries.push(header,data);
    const c=[];put32(c,0x02014b50);put16(c,20);put16(c,20);put16(c,0x800);put16(c,0);put16(c,0);put16(c,0);put32(c,crc);put32(c,data.length);put32(c,data.length);put16(c,name.length);put16(c,0);put16(c,0);put16(c,0);put16(c,0);put32(c,0);put32(c,offset);
    const ch=new Uint8Array(c.length+name.length);ch.set(c);ch.set(name,c.length);central.push(ch);offset+=header.length+data.length;
  }
  const centralSize=central.reduce((n,x)=>n+x.length,0),end=[];put32(end,0x06054b50);put16(end,0);put16(end,0);put16(end,files.length);put16(end,files.length);put32(end,centralSize);put32(end,offset);put16(end,0);
  return new Blob([...entries,...central,new Uint8Array(end)],{type:'application/zip'});
}
$('original').onclick = async () => {
  $('original').disabled = true; status('Fetching the original model…');
  try {
    const bytes = await getBytes();
    saveBlob(new Blob([bytes], { type: 'application/octet-stream' }), filename);
    status('Original model downloaded. In Blender, use File → Import and choose its format.');
  } catch (error) { status(`${error.message}\nIf the page requires a sign-in, open it in the browser and try again.`); }
  finally { $('original').disabled = false; }
};

function readContainer(bytes, isGlb) {
  if (!isGlb) return { json: JSON.parse(new TextDecoder().decode(bytes)), bin: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('This file is not a valid GLB model.');
  let offset = 12, json = null, bin = null;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true); offset += 8;
    if (offset + length > bytes.length) throw new Error('The GLB file is truncated.');
    const chunk = bytes.subarray(offset, offset + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk).replace(/[\u0000\u0020]+$/g, ''));
    if (type === 0x004e4942) bin = chunk;
    offset += length;
  }
  if (!json) throw new Error('The GLB file has no model data.');
  return { json, bin };
}
async function loadModel() {
  const bytes = await getBytes();
  const glb = format === 'GLB' || new TextDecoder().decode(bytes.subarray(0,4)) === 'glTF';
  const { json, bin } = readContainer(bytes, glb);
  const buffers = [];
  for (let i = 0; i < (json.buffers || []).length; i++) {
    const b = json.buffers[i];
    if (!b.uri && i === 0 && bin) { buffers.push(bin); continue; }
    if (!b.uri) throw new Error('A glTF buffer is missing.');
    if (b.uri.startsWith('data:')) {
      const raw = atob(b.uri.slice(b.uri.indexOf(',') + 1));
      buffers.push(Uint8Array.from(raw, c => c.charCodeAt(0)));
    } else {
      const u = new URL(b.uri, sourceUrl).href, r = await fetch(u, { credentials: 'include' });
      if (!r.ok) throw new Error(`Could not fetch a glTF resource (HTTP ${r.status}).`);
      buffers.push(new Uint8Array(await r.arrayBuffer()));
    }
  }
  return { json, buffers };
}
const typeComponents = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16 };
const componentReaders = { 5120:['getInt8',1],5121:['getUint8',1],5122:['getInt16',2],5123:['getUint16',2],5125:['getUint32',4],5126:['getFloat32',4] };
function accessorData(model, index) {
  const a = model.json.accessors[index], bv = model.json.bufferViews[a.bufferView];
  if (!a || a.bufferView == null || !bv) throw new Error('Sparse or missing glTF accessors are not supported by this simple converter.');
  const [method, size] = componentReaders[a.componentType] || [];
  if (!method) throw new Error('Unsupported glTF vertex component type.');
  const count = typeComponents[a.type], stride = bv.byteStride || size * count;
  const bytes = model.buffers[bv.buffer], base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Array(a.count * count);
  for (let n=0;n<a.count;n++) for(let c=0;c<count;c++) {
    const offset = base + n*stride + c*size;
    let value = view[method](offset, true);
    if (a.normalized && a.componentType !== 5126) {
      const max = a.componentType === 5120 ? 127 : a.componentType === 5121 ? 255 : a.componentType === 5122 ? 32767 : 65535;
      value = a.componentType === 5120 || a.componentType === 5122 ? Math.max(value / max, -1) : value / max;
    }
    out[n*count+c] = value;
  }
  return { data: out, count, itemCount: a.count };
}
function multiply(a,b) { const o=new Array(16); for(let c=0;c<4;c++) for(let r=0;r<4;r++) o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3]; return o; }
function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x,y,z,w]=node.rotation||[0,0,0,1], [sx,sy,sz]=node.scale||[1,1,1], [tx,ty,tz]=node.translation||[0,0,0];
  const x2=x+x,y2=y+y,z2=z+z,xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
  return [(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0,(xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,(xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0,tx,ty,tz,1];
}
function transform(m,x,y,z) { const w=m[3]*x+m[7]*y+m[11]*z+m[15]||1; return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w,(m[1]*x+m[5]*y+m[9]*z+m[13])/w,(m[2]*x+m[6]*y+m[10]*z+m[14])/w]; }
function gltfToObj(model) {
  const {json}=model, lines=['# Converted locally by 3D Model Catcher']; let vertexBase=1, materialNames=[];
  const materials=(json.materials||[]).map((m,i)=>{let n=(m.name||`material_${i}`).replace(/[^a-zA-Z0-9_-]/g,'_');materialNames.push(n);return `newmtl ${n}\nKd ${(m.pbrMetallicRoughness?.baseColorFactor||[0.8,0.8,0.8,1]).slice(0,3).join(' ')}\n`;});
  lines.push(`mtllib ${safeName(filename)}.mtl`);
  const meshes=json.meshes||[],nodes=json.nodes||[],scenes=json.scenes||[];
  const emitMesh=(meshIndex,world)=>{
    const mesh=meshes[meshIndex]; if(!mesh) return;
    for(const prim of mesh.primitives||[]) {
      if(prim.mode!=null&&prim.mode!==4) continue;
      const pos=prim.attributes?.POSITION; if(pos==null) continue;
      const positions=accessorData(model,pos).data, count=positions.length/3;
      lines.push(`o ${(mesh.name||`mesh_${meshIndex}`).replace(/[^a-zA-Z0-9_-]/g,'_')}`);
      if(prim.material!=null&&materialNames[prim.material]) lines.push(`usemtl ${materialNames[prim.material]}`);
      for(let i=0;i<positions.length;i+=3) { const p=transform(world,positions[i],positions[i+1],positions[i+2]); lines.push(`v ${p[0]} ${p[1]} ${p[2]}`); }
      let inds=prim.indices!=null?accessorData(model,prim.indices).data:Array.from({length:count},(_,i)=>i);
      for(let i=0;i+2<inds.length;i+=3) lines.push(`f ${vertexBase+inds[i]} ${vertexBase+inds[i+1]} ${vertexBase+inds[i+2]}`);
      vertexBase+=count;
    }
  };
  const roots=scenes[json.scene||0]?.nodes;
  const visit=(index,parent)=>{const n=nodes[index];if(!n)return;const world=multiply(parent,localMatrix(n));if(n.mesh!=null)emitMesh(n.mesh,world);for(const c of n.children||[])visit(c,world);};
  if(roots) for(const i of roots) visit(i,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  else meshes.forEach((_,i)=>emitMesh(i,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]));
  if(vertexBase===1) throw new Error('No triangle meshes were found. This converter supports triangle GLB/glTF meshes.');
  return {obj:lines.join('\n')+'\n',mtl:materials.join('\n')};
}
$('convert').onclick = async () => {
  $('convert').disabled = true; status('Fetching model and converting geometry locally…');
  try {
    const model=await loadModel(), out=gltfToObj(model), base=safeName(filename);
    const zip=makeZip([{name:`${base}.obj`,data:out.obj},{name:`${base}.mtl`,data:out.mtl}]);
    saveBlob(zip,`${base}-blender-obj.zip`);
    status(`Converted to ${base}-blender-obj.zip. Extract the ZIP, then import its OBJ file in Blender using File → Import → Wavefront (.obj).`);
  } catch(error) { status(`${error.message}\nTry Download original instead; Blender imports GLB/glTF directly and preserves materials.`); }
  finally { $('convert').disabled = false; }
};
