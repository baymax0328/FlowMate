/** 同一图形配线性与实心两种轮廓，选中与未选中都认得出是同一个入口。 */
export function NavigationIcon({ route, selected }: { route: string; selected: boolean }) {
 const fill=selected?'currentColor':'none';const detail=selected?'var(--nav-icon-cutout, #e6f3ec)':'currentColor';
 let graphic;
 if(route==='/message') graphic=<><path fill={fill} d="M7 4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-5l-5 3v-3a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z"/>{[7.5,12,16.5].map(x=><circle key={x} cx={x} cy="11.5" r="1.1" fill={detail} stroke="none"/>)}</>;
 else if(route==='/workspace') graphic=<><path fill={fill} d="M3 8a4 4 0 0 1 4-4h3l3 3h4a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path stroke={detail} d="M8 15h8"/></>;
 else if(route==='/agent/personal') graphic=<><circle fill={fill} cx="12" cy="7" r="4"/><path fill={fill} d="M4 21v-1a8 6 0 0 1 16 0v1Z"/></>;
 else if(route==='/agent/team') graphic=<><circle fill={fill} cx="9" cy="7" r="3.5"/><path fill={fill} d="M2 21v-2a7 5 0 0 1 14 0v2Z"/><path fill={fill} d="M17 4a3.5 3.5 0 0 1 0 7m2 4c3 1 3 3 3 6h-3"/></>;
 else if(route==='/task') graphic=<><rect fill={fill} x="3" y="3" width="18" height="18" rx="5"/><path stroke={detail} strokeWidth="2" d="m7.5 12 3 3.2 6-7"/></>;
 else if(route==='/dashboard') graphic=<path fill={fill} d="M3 11l8-7a1.5 1.5 0 0 1 2 0l8 7h-2v8a2 2 0 0 1-2 2h-3v-5a2 2 0 0 0-4 0v5H7a2 2 0 0 1-2-2v-8Z"/>;
 else if(route==='/members') graphic=<><rect x="5" y="3" width="15" height="19" rx="2.5" fill={fill}/><path d="M2 7h5M2 12h5M2 17h5"/><path stroke={detail} d="M10 8h6m-6 4h6m-6 4h3"/></>;
 else if(route==='/account') {
  const points=Array.from({length:8},(_,i)=>[-17,-10,10,17].map((offset,j)=>{const angle=(i*45+offset-90)*Math.PI/180,r=j===1||j===2?10:7.7;return `${12+Math.cos(angle)*r},${12+Math.sin(angle)*r}`;})).flat();
  graphic=<><path fill={fill} d={`M${points.join('L')}Z`}/><circle cx="12" cy="12" r="3.3" fill={selected?detail:'none'} stroke={detail}/></>;
 }
 else return null;
 return <svg className={`nav-symbol${selected?' is-selected':''}`} data-variant={selected?'solid':'outline'} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{graphic}</svg>;
}
