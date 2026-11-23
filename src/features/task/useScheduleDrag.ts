import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent,type MouseEvent as ReactMouseEvent} from 'react';

type Drop={date:string;minute:number};
type Block={id:string;date:string;start:string;end:string};
type Options={startHour:number;endHour:number;hourHeight:number;blocks:Block[];onMove:(id:string,date:string,start:string,end:string)=>Promise<void>;onPick:(id:string)=>void;onInvalid:(message:string)=>void};
type Gesture={id:string;duration:number;pointerId:number;pressedAt:number;startX:number;startY:number;x:number;y:number;offset:number;armed:boolean;node:HTMLButtonElement};
const toMin=(time:string)=>{const [h,m]=time.split(':').map(Number);return h*60+m;};
const clock=(min:number)=>`${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`;

export function useScheduleDrag(options:Options) {
  const latest=useRef(options);latest.current=options;
  const gesture=useRef<Gesture|null>(null),target=useRef<Drop|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),suppressed=useRef(false);
  const [dragging,setDragging]=useState<{id:string;x:number;y:number}|null>(null),[drop,setDrop]=useState<Drop|null>(null);
  const showDrop=(g:Gesture)=>{
    const opts=latest.current;
    setDragging({id:g.id,x:g.x,y:g.y});
    const col=document.elementFromPoint(g.x,g.y)?.closest<HTMLElement>('[data-schedule-date]');
    const next=col?{date:col.dataset.scheduleDate!,minute:Math.max(opts.startHour*60,Math.min(opts.endHour*60-g.duration,Math.round(((g.y-col.getBoundingClientRect().top)/opts.hourHeight*60+opts.startHour*60-g.offset)/15)*15))}:null;
    target.current=next;setDrop(next);
  };
  const arm=(g:Gesture)=>{g.armed=true;suppressed.current=true;showDrop(g);};
  useEffect(()=>{
    const move=(event:PointerEvent)=>{
      const g=gesture.current;if(!g||event.pointerId!==g.pointerId)return;
      g.x=event.clientX;g.y=event.clientY;
      if(!g.armed&&Date.now()-g.pressedAt>=140&&Math.hypot(g.x-g.startX,g.y-g.startY)>4)arm(g);
      if(g.armed){event.preventDefault();showDrop(g);}
    };
    const reset=()=>{if(timer.current)clearTimeout(timer.current);gesture.current=null;target.current=null;setDragging(null);setDrop(null);};
    const up=(event:PointerEvent)=>{
      const g=gesture.current;if(!g||g.pointerId!==event.pointerId)return;
      const dest=target.current,opts=latest.current;reset();
      if(!g.armed||!dest)return;
      if(opts.blocks.some(b=>b.id!==g.id&&b.date===dest.date&&toMin(b.start)<dest.minute+g.duration&&toMin(b.end)>dest.minute)) {opts.onInvalid('这个时段已有任务，请选择空闲时段');return;}
      void opts.onMove(g.id,dest.date,clock(dest.minute),clock(dest.minute+g.duration));
    };
    const cancel=()=>reset();
    window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',up);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);
    return()=>{if(timer.current)clearTimeout(timer.current);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);};
  },[]);
  const bindTask=(id:string,duration:number,done=false)=>({
    onPointerDown:(event:ReactPointerEvent<HTMLButtonElement>)=>{
      if(event.button!==0)return;suppressed.current=false;
      if(done)return;
      if(!Number.isFinite(duration)||duration<=0||duration>(latest.current.endHour-latest.current.startHour)*60){latest.current.onInvalid('任务时长超出可排范围，请先调整预估时长');return;}
      const node=event.currentTarget;
      const offset=node.classList.contains('sched-blk')?(event.clientY-node.getBoundingClientRect().top)/latest.current.hourHeight*60:0;
      const g:Gesture={id,duration,pointerId:event.pointerId,pressedAt:Date.now(),startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,offset,armed:false,node};
      gesture.current=g;node.setPointerCapture?.(event.pointerId);
      timer.current=setTimeout(()=>{if(gesture.current===g)arm(g);},220);
    },
    onClick:(event:ReactMouseEvent<HTMLButtonElement>)=>{if(suppressed.current){event.preventDefault();event.stopPropagation();suppressed.current=false;return;}latest.current.onPick(id);},
  });
  return {dragging,drop,bindTask};
}
