import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api/hooks';
import { Btn, Modal } from '../components/ui';
import { AVATAR_OPTIONS, avatarSource } from './avatar-options';
import { avatarCropRect, drawAvatarCrop, type AvatarCrop } from './avatar-crop';

async function readAvatar(file: File): Promise<ImageBitmap> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5 MB');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('图片无法读取，请换一张图片'); });
  if (!bitmap.width || !bitmap.height) { bitmap.close(); throw new Error('图片尺寸无效'); }
  return bitmap;
}

function croppedAvatar(image: ImageBitmap, crop: AvatarCrop): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  drawAvatarCrop(canvas, image, crop);
  let value = canvas.toDataURL('image/webp', .85);
  if (value.length > 175000) value = canvas.toDataURL('image/webp', .65);
  if (value.length > 175000) throw new Error('图片处理后仍过大，请换一张图片');
  return value;
}

export function AvatarChooser({ current, onClose, onSaved }: { current: string; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(current || 'male-1');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [crop, setCrop] = useState<AvatarCrop>({ x: 0, y: 0, zoom: 1 });
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const active = useRef(true);
  const drag = useRef<{ id: number; x: number; y: number; crop: AvatarCrop; scale: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => () => { image?.close(); }, [image]);
  useEffect(() => {
    if (!image) return;
    try {
      if (canvasRef.current) drawAvatarCrop(canvasRef.current, image, crop);
      if (previewRef.current) drawAvatarCrop(previewRef.current, image, crop);
    } catch (e) { setError(errMsg(e)); }
  }, [image, crop]);

  const reset = () => { if (image) setCrop({ x: image.width / 2, y: image.height / 2, zoom: 1 }); };
  const cancelCrop = () => { drag.current = null; setDragging(false); setImage(null); setError(''); };
  const close = useCallback(() => { if (!busy && !uploading) onClose(); }, [busy, uploading, onClose]);
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null; setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return <Modal title={image ? '裁剪头像' : '更换头像'} onClose={close} footer={image ? <>
    <Btn variant="ghost" disabled={uploading} onClick={cancelCrop}>取消裁剪</Btn>
    <Btn variant="primary" disabled={uploading} onClick={() => {
      try { setDraft(croppedAvatar(image, crop)); cancelCrop(); } catch (e) { setError(errMsg(e)); }
    }}>使用此头像</Btn>
  </> : <>
    <Btn variant="ghost" disabled={busy || uploading} onClick={close}>取消</Btn>
    <Btn variant="primary" disabled={uploading || draft === current} loading={busy} onClick={async () => {
      setBusy(true); setError('');
      try {
        await api.patch('/auth/profile', { prefs: { avatar: draft } });
        await Promise.all(['members', 'dashboard', 'conversation-detail'].map(key => qc.invalidateQueries({ queryKey: [key] })));
        onSaved(); onClose();
      } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
    }}>保存头像</Btn>
  </>}>
    <div className="avatar-chooser">
      {image ? <div className="avatar-crop-layout">
        <div className="avatar-crop-editor">
          <div className={`avatar-crop-stage${dragging ? ' is-dragging' : ''}`} role="group" aria-label="头像裁剪区域" aria-describedby="avatar-crop-instructions" tabIndex={0}
            onPointerDown={e => {
              if (uploading || (e.pointerType === 'mouse' && e.button !== 0) || drag.current) return;
              const bounds = e.currentTarget.getBoundingClientRect();
              drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, crop, scale: avatarCropRect(image.width, image.height, crop).side / bounds.width };
              e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus(); setDragging(true);
            }}
            onPointerMove={e => {
              const start = drag.current;
              if (!start || start.id !== e.pointerId) return;
              setCrop(avatarCropRect(image.width, image.height, { ...start.crop, x: start.crop.x - (e.clientX - start.x) * start.scale, y: start.crop.y - (e.clientY - start.y) * start.scale }).center);
            }} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
            onKeyDown={e => {
              const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
              if (!direction || uploading) return;
              e.preventDefault();
              setCrop(previous => {
                const step = avatarCropRect(image.width, image.height, previous).side * (e.shiftKey ? .1 : .02);
                return avatarCropRect(image.width, image.height, { ...previous, x: previous.x - direction[0] * step, y: previous.y - direction[1] * step }).center;
              });
            }}>
            <canvas ref={canvasRef} width="360" height="360" aria-hidden="true" />
            <div className="avatar-crop-guide" aria-hidden="true" />
          </div>
          <div id="avatar-crop-instructions" className="avatar-crop-instructions">
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></svg><span><strong>拖动图片</strong>调整位置</span></span>
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5M7.5 10.5h6M10.5 7.5v6" /></svg><span><strong>缩放</strong>选择头像范围</span></span>
          </div>
          <label className="avatar-crop-zoom"><span>缩放</span><input type="range" min="1" max="4" step="0.01" value={crop.zoom} disabled={uploading} aria-label="头像缩放" aria-valuetext={`${Math.round(crop.zoom * 100)}%`} onChange={e => {
            const zoom = Number(e.target.value);
            setCrop(previous => avatarCropRect(image.width, image.height, { ...previous, zoom }).center);
          }} /><output>{Math.round(crop.zoom * 100)}%</output></label>
        </div>
        <div className="avatar-crop-preview"><strong>头像预览</strong><canvas ref={previewRef} width="96" height="96" role="img" aria-label="裁剪后的圆形头像预览" /><div className="avatar-crop-actions"><Btn size="sm" disabled={uploading} onClick={reset}>重置</Btn><Btn size="sm" disabled={uploading} loading={uploading} onClick={() => fileRef.current?.click()}>重新选择</Btn></div></div>
      </div> : <>
        <div className="avatar-preview"><img src={avatarSource(draft)} alt="当前头像预览" width="92" height="92" /><div><strong>选择你喜欢的形象</strong><span>或者上传图片自定义个人形象</span></div></div>
        <div className="avatar-preset-grid" role="group" aria-label="预设人物头像">
          {AVATAR_OPTIONS.map(a => <button type="button" key={a.id} className="avatar-preset" aria-pressed={draft === a.id} aria-label={a.label} disabled={busy || uploading} onClick={() => { setDraft(a.id); setError(''); }}><img src={a.src} alt="" width="80" height="80" /><i aria-hidden="true">{draft === a.id ? '✓' : ''}</i></button>)}
        </div>
        <div className="avatar-upload"><Btn disabled={busy || uploading} loading={uploading} onClick={() => fileRef.current?.click()}>上传图片</Btn><span>JPG、PNG、WebP，最大 5 MB</span></div>
      </>}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="上传自定义头像" onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = '';
        if (!file) return;
        setUploading(true); setError('');
        try {
          const bitmap = await readAvatar(file);
          if (!active.current) { bitmap.close(); return; }
          drag.current = null; setDragging(false);
          setCrop({ x: bitmap.width / 2, y: bitmap.height / 2, zoom: 1 }); setImage(bitmap);
        } catch (e) { if (active.current) setError(errMsg(e)); } finally { if (active.current) setUploading(false); }
      }} />
      {error ? <div className="err" role="alert">{error}</div> : null}
    </div>
  </Modal>;
}
