// Shared constants (loaded by background via importScripts, by popup/options via <script>)
const FORMATS = {
  glb:'GLB', gltf:'glTF', fbx:'FBX', obj:'OBJ', stl:'STL', usdz:'USDZ', usd:'USD', usda:'USD', usdc:'USD',
  dae:'DAE', '3mf':'3MF', ply:'PLY', blend:'Blend', '3ds':'3DS', x3d:'X3D', wrl:'VRML', mtl:'MTL',
  vrm:'VRM', off:'OFF', abc:'Alembic', step:'STEP', stp:'STEP', igs:'IGES', iges:'IGES', splat:'Splat', spz:'SPZ'
};
const MIME_FORMATS = {
  'model/gltf-binary':'GLB', 'model/gltf+json':'glTF', 'model/stl':'STL', 'model/obj':'OBJ',
  'model/vnd.collada+xml':'DAE', 'model/vnd.usdz+zip':'USDZ', 'model/3mf':'3MF',
  'application/sla':'STL', 'application/vnd.ms-pki.stl':'STL', 'application/vnd.autodesk.fbx':'FBX',
  'model/x3d+xml':'X3D', 'model/vrml':'VRML', 'model/step':'STEP', 'model/iges':'IGES',
  'application/x-blender':'Blend', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml':'3MF'
};
const FORMAT_LIST = [...new Set(Object.values(FORMATS))];
const DEFAULT_SETTINGS = {
  disabledFormats: ['MTL'],   // formats ignored
  floatingButton: true,
  minScore: 40,
  managerTemplate: '',        // e.g. myprotocol://add?url={url}  ({url} is URL-encoded)
  keepHistory: true,
  sniffMagic: true
};
