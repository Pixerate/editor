import { it } from 'vitest';
import { ToolRegistry } from '../src/agent';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';
function mk(W:number,H:number,f:(x:number,y:number)=>number[]){const d=new Uint8ClampedArray(W*H*4);for(let y=0;y<H;y++)for(let x=0;x<W;x++)d.set([...f(x,y),255],(y*W+x)*4);
 const c=new ImageEditorController({image:{width:W,height:H,naturalWidth:W,naturalHeight:H,src:'data:fake'} as any}); c.setSamplePixels({width:W,height:H,data:d}); const r=new ToolRegistry(); r.register(createImageEditorToolProvider(c));
 const call=async(n:string,a:any={})=>{const x=await r.callTool(n,a); return x.isError?'ERR '+(x.content as any)[0].text: x.structuredContent;}; return {c,call};}
const m=(o:any)=>o.stats? JSON.stringify({mean:o.meanColor,cast:o.cast,lum:o.stats.luminance,clipH:o.clipping.highlightsPercent}): JSON.stringify(o).slice(0,600);
it('probe', async () => {
  // photo
  let {call}=mk(120,80,(x,y)=> y<20?[120,135,170]: (x>=10&&x<30&&y>=50&&y<70)?[70,80,105]:[50,60,85]);
  const a=await call('add_adjustment_layer',{kind:'levels',params:{red:{inWhite:140},green:{inWhite:159},blue:{inWhite:209}}});
  console.log('LV',JSON.stringify(a).slice(0,300));
  console.log('CARD',m(await call('measure_region',{x:12,y:52,width:16,height:16})),'ALL',m(await call('measure_region')));
  // retouch
  ({call}=mk(100,60,(x,y)=> (Math.abs(x-30)<=1&&Math.abs(y-30)<=1)?[120,80,70]:[200,160,140]));
  await call('add_pixel_layer',{name:'Retouch'});
  console.log('SH',m(await call('spot_heal',{points:[{x:30,y:30}],sample:'current-below',brush:{size:10,hardness:0.3}})));
  console.log('SPOT',m(await call('measure_region',{x:27,y:27,width:7,height:7})));
  // shadow
  ({call}=mk(120,80,(x,y)=> (x>=40&&x<80&&y>=25&&y<65)?[30,90,160]:[200,198,195]));
  await call('magic_wand',{x:60,y:45,tolerance:20});
  const lc:any=await call('layer_via_copy',{}); console.log('LVC',JSON.stringify(lc).slice(0,200));
  console.log('FX',m(await call('add_layer_effect',{layerId:lc.layer.id,effect:{kind:'dropShadow'}})));
  const ll:any=await call('list_layers'); console.log('LL',JSON.stringify(ll.layers.map((l:any)=>l.effects)));
});
