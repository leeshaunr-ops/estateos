import {jpegSize} from './pdf.mjs';
export function validateLogo(value,fail){
 if(value===undefined)return undefined;
 if(value==='')return '';
 if(typeof value!=='string'||value.length>700000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))fail(422,'Upload a PNG or JPEG logo using the logo picker.');
 try{const d=jpegSize(Buffer.from(value.split(',')[1],'base64'));if(d.width>1200||d.height>600)throw Error();}catch{fail(422,'Logo could not be read. Choose another image.');}
 return value;
}
