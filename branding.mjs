import {jpegSize} from './pdf.mjs';
import {decodeLogoPng} from './png-logo.mjs';
export function validateLogo(value,fail){
 if(value===undefined)return undefined;
 if(value==='')return '';
 if(typeof value!=='string'||value.length>3500000||!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))fail(422,'Upload a PNG or JPEG logo using the logo picker.');
 try{const bytes=Buffer.from(value.split(',')[1],'base64'),d=value.startsWith('data:image/png;')?decodeLogoPng(bytes):jpegSize(bytes);if(d.width>1200||d.height>600)throw Error();}catch{fail(422,'Logo could not be read. Choose another image.');}
 return value;
}
