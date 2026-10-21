import jpeg from 'jpeg-js';
let solid,noise;
export function jpegFixture({noisy=false}={}) {
  if(noisy&&noise)return Buffer.from(noise);if(!noisy&&solid)return Buffer.from(solid);
  const data=Buffer.alloc(1080*1080*4);let random=0x12345678;
  for(let i=0;i<data.length;i+=4){for(let c=0;c<3;c++){random^=random<<13;random^=random>>>17;random^=random<<5;data[i+c]=noisy?random&255:[41,87,132][c];}data[i+3]=255;}
  const result=Buffer.from(jpeg.encode({width:1080,height:1080,data},noisy?80:85).data);
  if(noisy)noise=result;else solid=result;return Buffer.from(result);
}
export function dcOverflowJpeg(negative=false) {
  const segment=(marker,data)=>Buffer.concat([Buffer.from([255,marker,(data.length+2)>>8,(data.length+2)&255]),Buffer.from(data)]);
  const dc=[0,1,...Array(15).fill(0),10],ac=[16,1,...Array(15).fill(0),0];
  // All components use table zero, with one 10-bit DC difference per block.
  const bits=Array(135*135*3).fill('0'+(negative?'0000000000':'1111111111')+'0').join('');
  const entropy=[];for(let i=0;i<bits.length;i+=8){const n=parseInt(bits.slice(i,i+8).padEnd(8,'1'),2);entropy.push(n);if(n===255)entropy.push(0);}
  return Buffer.concat([Buffer.from([255,216]),segment(224,[74,70,73,70,0,1,1,0,0,1,0,1,0,0]),
    segment(219,[0,...Array(64).fill(1)]),segment(192,[8,4,56,4,56,3,1,17,0,2,17,0,3,17,0]),
    segment(196,[...dc,...ac]),segment(218,[3,1,0,2,0,3,0,0,63,0]),Buffer.from(entropy),Buffer.from([255,217])]);
}
