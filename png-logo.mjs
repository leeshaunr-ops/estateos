import {inflateSync} from 'node:zlib';
// Accept the bounded, non-interlaced RGB/RGBA PNGs produced by the upload canvas.
export function decodeLogoPng(bytes){
 if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid PNG');
 let width,height,channels,ended=false;const chunks=[];
 for(let pos=8;pos+12<=bytes.length;){const size=bytes.readUInt32BE(pos),type=bytes.toString('ascii',pos+4,pos+8);if(size>bytes.length-pos-12)throw Error('Invalid PNG chunk');const part=bytes.subarray(pos+8,pos+8+size);
  if(type==='IHDR'){if(width||size!==13)throw Error('Invalid PNG header');width=part.readUInt32BE(0);height=part.readUInt32BE(4);channels=part[9]===6?4:part[9]===2?3:0;if(!width||!height||width>1200||height>600||part[8]!==8||!channels||part[10]||part[11]||part[12])throw Error('Unsupported logo PNG');}
  if(type==='IDAT')chunks.push(part);if(type==='IEND'){ended=true;break;}pos+=size+12;
 }
 if(!width||!ended||!chunks.length)throw Error('Incomplete PNG');const stride=width*channels,expected=(stride+1)*height;const raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:expected});if(raw.length!==expected)throw Error('Invalid PNG pixels');const pixels=Buffer.alloc(stride*height);
 const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
 for(let y=0;y<height;y++){const filter=raw[y*(stride+1)];if(filter>4)throw Error('Invalid PNG filter');for(let x=0;x<stride;x++){const at=y*stride+x,a=x>=channels?pixels[at-channels]:0,b=y?pixels[at-stride]:0,c=y&&x>=channels?pixels[at-stride-channels]:0;pixels[at]=(raw[y*(stride+1)+1+x]+(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0))&255;}}
 const rgb=Buffer.alloc(width*height*3),alpha=Buffer.alloc(width*height,255);for(let i=0;i<width*height;i++){pixels.copy(rgb,i*3,i*channels,i*channels+3);if(channels===4)alpha[i]=pixels[i*channels+3];}return {width,height,rgb,alpha};
}
