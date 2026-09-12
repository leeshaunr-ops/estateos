// Remove only a uniform, edge-connected background; preserve enclosed logo detail.
function removeLogoBackground(image){
 const {data:p,width:w,height:h}=image;const edge=[];
 for(let x=0;x<w;x++){edge.push(x,(h-1)*w+x);}for(let y=1;y<h-1;y++){edge.push(y*w,y*w+w-1);}
 if(edge.some(i=>p[i*4+3]<250))return image;
 const buckets=new Map();for(const i of edge){const k=[0,1,2].map(c=>Math.round(p[i*4+c]/16)).join(',');buckets.set(k,(buckets.get(k)||0)+1);}
 const dominant=[...buckets].sort((a,b)=>b[1]-a[1])[0];if(!dominant||dominant[1]/edge.length<.70)return image;
 const samples=edge.filter(i=>[0,1,2].map(c=>Math.round(p[i*4+c]/16)).join(',')===dominant[0]);const bg=[0,1,2].map(c=>samples.reduce((v,i)=>v+p[i*4+c],0)/samples.length);
 const distance=i=>Math.max(...bg.map((v,c)=>Math.abs(v-p[i*4+c])));const seen=new Uint8Array(w*h),queue=new Int32Array(w*h);let head=0,tail=0;
 const add=i=>{if(i>=0&&i<w*h&&!seen[i]&&distance(i)<=42){seen[i]=1;queue[tail++]=i;}};edge.forEach(add);
 while(head<tail){const i=queue[head++],x=i%w;if(x)add(i-1);if(x<w-1)add(i+1);if(i>=w)add(i-w);if(i<w*(h-1))add(i+w);}
 for(let n=0;n<tail;n++){const i=queue[n],d=distance(i);p[i*4+3]=d<=22?0:Math.round(255*(d-22)/20);}
 return image;
}
