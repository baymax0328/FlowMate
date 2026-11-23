// FlowMate · Workspace（PRD §06 / §07）：只管文件与文件夹
// 明确不做「引用与关联 / 加入 Agent / 被哪些任务使用」入口（§06 硬约束）
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, arrOf, errMsg, fmtRel, fmtSize, idem, jsonOf, useDebounced, usePageCols, useQ, useSubscription, useUrlState, usePersistentState, type Json } from '../../api/hooks';
import { ArchivedEntry, OverflowLabel, SlideToggle, Btn, Check, ColResizer, Confirm, Diff, Empty, Err, Field, FileBadge, Markdown, Modal, Note, Pill, PromptDialog, RowMenu, sanitizeHtml, Skel, Snippet, SubTabs, useToast } from '../../components/ui';
import { useSession } from '../../app/session';
import { IllustratedEmpty } from '../../components/IllustratedEmpty';

const S = (v: unknown, f: string | number | null = ''): string => (v === null || v === undefined || v === '' ? String(f ?? '') : String(v));
type Node = { id: string; name: string; kind: string; ext: string; size: number; folder_id: string | null; space: string; owner_id: string | null; team_id: string | null; my_permission?: string; text_status?: string | null; text_reason?: string | null; current_version_id?: string | null; updated_at?: string; current_version?: Json | null };

// 权限三档统一用中文口径：可管理 / 可编辑 / 可查看
const permLabel = (p: string | undefined | null): string => p === 'manager' ? '可管理' : p === 'editor' ? '可编辑' : p === 'viewer' ? '可查看' : (p || '—');

const TEXT_KINDS = new Set(['markdown', 'text', 'html']);
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const UPLOAD_HINT = '可上传 md / txt / html / docx / pdf / xlsx / csv / pptx 格式文件，文件大小不超过 50MB';

export default function WorkspacePage() {
  const [query] = useSearchParams();
  const previewId = query.get('preview');
  return previewId ? <BrowserFilePreview fileId={previewId} /> : <Workspace />;
}

function useFilePreview(fileId: string) {
  return useQuery({
    queryKey: ['preview', fileId],
    queryFn: () => api.get<Json>(`/files/${encodeURIComponent(fileId)}/preview`),
    enabled: !!fileId,
    refetchInterval: (query) => {
      const preview = query.state.data;
      return preview?.text_status === 'pending' && ['table', 'slides', 'html'].includes(S(preview.kind)) ? 3000 : false;
    },
  });
}

function BrowserFilePreview({ fileId }: { fileId: string }) {
  const file = useQ<Node>(['workspace-file', fileId], `/files/${encodeURIComponent(fileId)}`);
  const preview = useFilePreview(fileId);
  return <section className="card stack browser-file-preview">
    <h2>{file.data?.name ?? '文件预览'}</h2>
    {preview.isLoading ? <Skel rows={5} /> : null}
    {preview.isError ? <Err onRetry={() => preview.refetch()}>{errMsg(preview.error)}</Err> : null}
    {preview.data ? <PreviewPane key={fileId} pv={preview.data} browserView /> : null}
  </section>;
}

export function FilePreviewModal({fileId,title,onClose}:{fileId:string;title:string;onClose:()=>void}) {
  const preview=useFilePreview(fileId);
  return <Modal title={title} onClose={onClose} wide footer={<Btn onClick={onClose}>关闭</Btn>}>
    {preview.isLoading?<Skel rows={6}/>:preview.isError?<Err onRetry={()=>preview.refetch()}>{errMsg(preview.error)}</Err>:preview.data?.kind==='markdown'?<Markdown text={S(preview.data.text)}/>:preview.data?<PreviewPane key={fileId} pv={preview.data} fileId={fileId} browserView/>:null}
  </Modal>;
}

function Workspace() {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const { params, update } = useUrlState({ folder: '', focus: '', view: 'list', q: '', scope: 'folder', section: '' });
  const spaces = useQ<Json[]>(['spaces'], '/spaces');
  const [spaceKey, setSpaceKey] = usePersistentState('workspace.space','');
  const folderId = params.folder;
  const isRecent = params.section === 'recent';
  const recent = useQ<Node[]>(['recent'], '/recent', undefined, { enabled: isRecent });
  const kids = useQ<{ folders: Node[]; files: Node[]; path: { id: string; name: string }[] }>(
    ['folders', folderId ?? 'root'], folderId ? `/folders/${folderId}/children` : '/folders/children', undefined, { enabled: !isRecent });
  useSubscription('file', params.focus);
  const focusedFile = useQuery({
    queryKey: ['workspace-file', params.focus],
    queryFn: () => api.get<Node>(`/files/${params.focus}`),
    enabled: !!params.focus,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const focus = focusedFile.data ?? null;
  const canEditFocus = focus?.my_permission === 'editor' || focus?.my_permission === 'manager';
  useEffect(() => {
    if (focusedFile.dataUpdatedAt) void qc.invalidateQueries({ queryKey: ['recent'] });
  }, [focusedFile.dataUpdatedAt, qc]);
  const preview = useFilePreview(params.focus);
  const versions = useQ<Json[]>(['versions', params.focus], `/files/${params.focus || 'none'}/versions`, undefined, { enabled: !!params.focus });
  const searchQ = useDebounced(params.q, 300);
  const search = useQ<Json>(['search', searchQ], '/search', { q: searchQ, type: 'files' }, { enabled: !isRecent && searchQ.trim().length > 0 });
  const [uploading, setUploading] = useState(false);
  const [uploadFailures, setUploadFailures] = useState<{ name: string; reason: string }[]>([]);
  const [dialog, setDialog] = useState<'' | 'new' | 'share' | 'trash' | 'move' | 'copy' | 'space' | 'del-space'>('');
  /** 行内「操作」选中的对象（文件 / 文件夹），移动与删除都以它为准；parent 用于删掉当前目录后回上一层 */
  const [fileToShare, setFileToShare] = useState<{ id: string; name: string } | null>(null);
  const [trashTarget, setTrashTarget] = useState<{ kind: 'file' | 'folder'; id: string; name: string; parent?: string } | null>(null);
  const [rowAct, setRowAct] = useState<{ kind: 'file' | 'folder'; id: string; name: string; parent?: string } | null>(null);
  /** 空间行菜单的重命名和删除目标 */
  const [renameSpace, setRenameSpace] = useState<Json | null>(null);
  const [delSpace, setDelSpace] = useState<Json | null>(null);
  /** 空间列的三组折叠状态（点组标题展开/收起具体的空间） */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ personal: true, team: true, org: true });
  // 右栏「文件预览」与 Message 的「会话详情」一致：可收起，收起后中间区域扩到右侧。
  // 默认收起；但点文件行仍然展开——Workspace 的右栏就是预览本体，不展开等于没结果。
  const [detailOpen, setDetailOpen] = useState(!!params.focus);
  useEffect(() => {
    if (!detailOpen) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.overlay-details, .modal-mask, .pop')) setDetailOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [detailOpen]);
  const cols = usePageCols('workspace', { detailDef: 860, detailKey: 'workspace.drawer-wide.detail' });
  const [editor, setEditor] = useState<{ text: string; base: string } | null>(null);
  const [diffView, setDiffView] = useState<{ title: string; patch: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const remembered = useRef(false);

  useEffect(() => {
    if (remembered.current || !spaces.data) return;
    const saved = spaceKey;
    const first = spaces.data[0];
    if (saved && spaces.data.some((s) => S(s.id) === saved)) { setSpaceKey(saved); remembered.current = true; }
    else if (!folderId) { setSpaceKey(S(first?.id, '')); remembered.current = true; }
  }, [spaces.data, folderId]);

  const activeSpace = useMemo(() => (spaces.data ?? []).find((s) => S(s.id) === (spaceKey || folderId)) ?? spaces.data?.[0], [spaces.data, spaceKey, folderId]);

  /** 空间列分三组：个人空间 / 团队空间 / 组织空间；组下才是具体的空间（可折叠） */
  const groups = useMemo(() => {
    const rows = (spaces.data ?? []).filter((s) => s.id);
    return [
      { key: 'personal', label: '个人空间', items: rows.filter((s) => s.space === 'personal') },
      { key: 'team', label: '团队空间', items: rows.filter((s) => s.space === 'team') },
      { key: 'org', label: '组织空间', items: rows.filter((s) => s.space === 'org') },
    ];
  }, [spaces.data]);

  const goto = useCallback((id: string | null) => {
    update({ folder: id ?? '', focus: null, q: '', section: null });

    setSp(id ? { folder: id } : {}, { replace: true });
  }, [update, setSp]);

  /** 进某个空间/目录：选中态写进 URL，同时记一次「上次所在」（沿用原有逻辑） */
  const openSpace = useCallback((id: string) => { setSpaceKey(id); goto(id); }, [goto]);

  function openFile(id: string) {
    if (id === params.focus) void focusedFile.refetch();
    else update({ focus: id });
    setDetailOpen(true);
  }

  const startMove = useCallback((t: { kind: 'file' | 'folder'; id: string; name: string; parent?: string }) => { setRowAct(t); setDialog('move'); }, []);
  const startCopy = useCallback((t: { kind: 'file' | 'folder'; id: string; name: string; parent?: string }) => { setRowAct(t); setDialog('copy'); }, []);

  /** 删除一律先进回收站（不物理删）；文件与文件夹走各自的 trash 接口 */
  const trashRow = useCallback(async (t: { kind: 'file' | 'folder'; id: string; name: string; parent?: string }) => {
    try {
      await api.post(`/${t.kind === 'folder' ? 'folders' : 'files'}/${t.id}/trash`, {});
      setTrashTarget(null);
      toast('已移入回收站');
      if (params.focus === t.id) update({ focus: null });
      // 删的正是当前打开的目录：回到它的上一层，不要停在已回收目录里（否则列目录会报错）
      if (folderId === t.id) { if (t.parent) { setSpaceKey(''); goto(t.parent); } else { update({ folder: '' }); setSp({}, { replace: true }); } }
      qc.invalidateQueries({ queryKey: ['folders'] });
      qc.invalidateQueries({ queryKey: ['spaces'] });
      qc.invalidateQueries({ queryKey: ['recent'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (e) { toast(errMsg(e), true); }
  }, [toast, params.focus, update, folderId, goto, setSp, qc]);

  const list = useMemo<Json[]>(() => {
    if (isRecent) return recent.data ?? [];
    if (searchQ.trim()) {
      const g = jsonOf<Json>(search.data?.groups, {});
      const rows = (g.files?.items ?? []) as Json[];
      return rows.map((r) => ({ id: S(r.file_id ?? r.id), name: S(r.name), kind: S(r.kind, 'file'), ext: S(r.ext), size: Number(r.size ?? 0), folder_id: S(r.folder_id, null) as string | null, space: S(r.space), owner_id: null, team_id: null, my_permission: S(r.my_permission), text_status: S(r.text_status), current_version_id: S(r.current_version_id), updated_at: S(r.updated_at), matched: r.kind === 'file_content' ? 'content' : 'name', snippet: r.snippet, hits: r.hits }));
    }
    return (kids.data?.files ?? []) as unknown as Json[];
  }, [isRecent, recent.data, kids.data, search.data, searchQ]);

  const documentIsEmpty = isRecent ? !recent.isLoading && !recent.isError && !list.length : !kids.isLoading && !kids.isError && (!searchQ || (!search.isLoading && !search.isError)) &&
    (searchQ ? !list.length : nothingToShow(kids.data?.files, kids.data?.folders));
  const documentEmptyView = <IllustratedEmpty kind="documents" title={isRecent ? '暂无最近访问的文件' : searchQ ? '暂未找到匹配的文件' : (kids.data?.path?.length ?? 0) > 1 ? '当前文件夹暂无文件' : '当前工作区暂无文件'} />;

  async function uploadFiles(files: File[]) {
    if (!files.length || uploading) return;
    const failures = files.filter((file) => file.size > UPLOAD_LIMIT)
      .map((file) => ({ name: file.name, reason: '文件大小不能超过 50MB' }));
    const allowed = files.filter((file) => file.size <= UPLOAD_LIMIT);
    setUploadFailures(failures);
    if (!allowed.length) return;
    const form = new FormData();
    allowed.forEach((file) => form.append('files', file));
    const target = folderId || S(activeSpace?.id, '');
    if (target) form.append('folder_id', target);
    setUploading(true);
    try {
      const results = await api.upload<{ ok: boolean; name: string; message?: string }[]>('/uploads', form, idem('up'));
      const succeeded = results.filter((result) => result.ok).length;
      setUploadFailures([...failures, ...results.filter((result) => !result.ok)
        .map((result) => ({ name: result.name, reason: result.message ?? '上传失败' }))]);
      if (succeeded) {
        void qc.invalidateQueries({ queryKey: ['folders'] });
        toast(`已上传 ${succeeded} 个文件`);
      }
    } catch (e) {
      setUploadFailures([...failures, { name: '上传失败', reason: errMsg(e) }]);
    } finally {
      setUploading(false);
    }
  }

  const fileActions = focus ? <>
    <a className="btn sm" href={S(preview.data?.download_url, `/api/v1/files/${encodeURIComponent(focus.id)}/download`)} download={focus.name}>下载</a>
    {canEditFocus && TEXT_KINDS.has(focus.kind) ? <Btn size="sm" variant="primary" onClick={() => setEditor({ text: '', base: S(focus.current_version_id) })}>在线编辑</Btn> : null}
  </> : null;

  return (
    <div className={`paneled with-detail overlay-details documents-page${detailOpen ? '' : ' detail-closed'}`} style={{ height: '100%', ...cols.style }}>
      {detailOpen ? <button type="button" className="detail-dismiss-layer" aria-label="关闭详情" onClick={() => setDetailOpen(false)} /> : null}
      <aside className="side workspace-side">
        <ColResizer onResizeStart={cols.side.onResizeStart} onNudge={cols.side.nudge} label="拖动调整空间列表宽度" />
        <div className="side-head"><div className="side-title grow">空间</div>
          <Btn size="sm" variant="primary" onClick={() => setDialog('space')}>新建空间</Btn>
        </div>
        <div className="side-body">
          {/* 三组：个人 / 团队 / 组织；组标题可折叠，点开才是具体的空间。 */}
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 4 }}>
              <button className="row-item group" aria-expanded={!!openGroups[g.key]}
                onClick={() => setOpenGroups((p) => ({ ...p, [g.key]: !p[g.key] }))}>
                <div className="row-title"><span className="chev" aria-hidden="true">{openGroups[g.key] ? '▾' : '▸'}</span><span>{g.label}</span>
                  <span className="muted small">{g.items.length}</span></div>
              </button>
              {openGroups[g.key] ? g.items.map((s) => (
                <div className="row-item sub" key={S(s.id)} role="button" tabIndex={0}
                  aria-current={!isRecent && S(s.id) === (folderId || spaceKey)} onClick={() => openSpace(S(s.id))}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSpace(S(s.id)); } }}>
                  <div className="row-title grow">
                    <OverflowLabel text={S(s.name)} />
                    {s.deletable ? <Pill plain tone="idle">自建</Pill> : null}
                    {/* 每个空间右侧一个「···」：重命名 + 删除都收在这里。
                        「我的文件」这一行不给重命名：列表里的名字是接口写死的显示名，
                        改了不会生效 —— 与其给个骗人的菜单项，不如不放。 */}
                    <span className="right" onClick={(e) => e.stopPropagation()}>
                      <RowMenu showWhenDisabled label={`「${S(s.name)}」的操作`} items={[
                        ...(s.space === 'personal' && S(s.name) === '我的文件' ? [] : [{
                          key: 'rename', label: '重命名', onSelect: () => setRenameSpace(s),
                        }]),
                        {
                          key: 'del', label: s.deletable ? '删除空间' : '', danger: true,
                          disabled: s.deletable ? null : '该空间由系统自动生成，无法自行删除',
                          onSelect: () => { setSpaceKey(S(s.id)); setDelSpace(s); },
                        },
                      ]} />
                    </span>
                  </div>
                  {/* 行内不再重复标「团队空间 / 组织空间 / 个人空间」：上方分组标题已经说明类型，
                      每行再写一遍只会让列表变高、信息重复。 */}
                </div>
              )) : null}
              {openGroups[g.key] && !g.items.length ? <div className="muted small" style={{ padding: '2px 8px' }}>没有可见空间</div> : null}
            </div>
          ))}
          <button type="button" className="archived-entry-btn" aria-current={isRecent ? 'page' : undefined}
            onClick={() => { update({ section: 'recent', folder: null, focus: null, q: '' }); setDetailOpen(false); }}>
            <span className="archived-entry-icon" aria-hidden="true"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg></span>
            <span>最近</span>
          </button>
          <ArchivedEntry label="回收站" onClick={() => setDialog('trash')} />
          {spaces.isLoading ? <Skel rows={5} /> : null}
        </div>
      </aside>

      <section className="work">
        <div className="card-head" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', margin: 0, flexWrap: 'wrap' }}>
          <div className="crumbs grow">
            {isRecent ? <b>最近</b> : (kids.data?.path ?? []).map((p, i, arr) => (
              <span key={p.id} className="cluster">
                <button className="btn-link" onClick={() => goto(p.id)}>{p.name}</button>
                {i < arr.length - 1 ? <span className="sep">/</span> : null}
              </span>
            ))}
            {searchQ ? <span className="muted">· 搜索「{searchQ}」</span> : null}
          </div>
          {!isRecent ? <>
            <div className="searchbox" style={{ width: 260 }}>
              <input type="search" value={params.q} placeholder="搜索名称、路径或正文" aria-label="搜索文件"
                onChange={(e) => update({ q: e.target.value })} />
            </div>

            <SlideToggle left="列表" right="网格" checked={params.view==='grid'} onChange={grid=>update({view:grid?'grid':'list'})} label="文档呈现方式"/>
            {/* 按钮上直接写明传到哪一层，避免"上传后文件跑别处去了"这种意外 */}
            <Btn size="sm" title={UPLOAD_HINT} disabled={uploading}
              onClick={() => fileRef.current?.click()}>上传到当前文件夹</Btn>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = '';
              void uploadFiles(files);
            }} />
            {/* 以前这里只是 goto(当前目录)：看起来是个按钮，按下去什么都没发生。
                「新建文件」应当打开新建弹窗（默认落进当前目录，未进入目录时落进个人空间） */}
            <Btn size="sm" variant="primary" onClick={() => { setRowAct(null); setDialog('new'); }}>新建文件</Btn>
          </> : null}
        </div>

        {uploading ? <div className="document-upload-status" role="status">文件上传中</div> : uploadFailures.length ? (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
            <div className="cluster" style={{ justifyContent: 'space-between' }}><b className="small">未上传的文件</b><Btn size="sm" variant="ghost" onClick={() => setUploadFailures([])}>关闭</Btn></div>
            {uploadFailures.map((file, i) => <div className="row-meta" key={i}><span className="grow">{file.name}</span><span className="muted">{file.reason}</span></div>)}
          </div>
        ) : null}

        <div className={`grow document-content${documentIsEmpty ? ' document-content-empty' : ''}`} style={{ overflow: 'auto', padding: !isRecent && params.view === 'grid' ? 16 : 0 }}>
          {(isRecent ? recent.isLoading : kids.isLoading) ? <div style={{ padding: 16 }}><Skel rows={6} /></div> : null}
          {(isRecent ? recent.isError : kids.isError) ? <div style={{ padding: 16 }}>
            <Err onRetry={() => isRecent ? recent.refetch() : kids.refetch()}>{errMsg(isRecent ? recent.error : kids.error)}</Err>
          </div> : null}
          {!isRecent && params.view === 'grid' ? (
            <>
            {documentIsEmpty ? documentEmptyView : null}
            <div className="document-file-grid">
              {(kids.data?.folders ?? []).filter(() => !searchQ).map((f) => (
                <button key={f.id} type="button" className="document-file-card" onClick={() => goto(f.id)}>
                  <div className="document-file-card-top">
                    <span className="document-grid-icon" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5h6l2 2h10v13H3V7Zm0 4h18"/></svg></span>
                    <Pill plain>{permLabel(f.my_permission)}</Pill>
                  </div>
                  <strong className="document-grid-name" title={f.name}>{f.name}</strong>
                  <div className="document-grid-meta"><span>文件夹</span><span>{fmtRel(f.updated_at)}</span></div>
                </button>
              ))}
              {list.map((f) => (
                <button key={f.id} type="button" className="document-file-card" aria-current={f.id === params.focus} onClick={() => openFile(f.id)}>
                  <div className="document-file-card-top">
                    <span className="document-grid-icon"><FileBadge ext={f.ext || f.kind} /></span>
                    <Pill plain>{permLabel(f.my_permission)}</Pill>
                  </div>
                  <strong className="document-grid-name" title={f.name}>{f.name}</strong>
                  <div className="document-grid-meta"><span>{fmtSize(f.size)}</span><span>{fmtRel(f.updated_at)}</span></div>
                </button>
              ))}
            </div>
            </>
          ) : (
            <>
            <div className="table-wrap file-table-wrap">
              <table className="grid file-grid">
                <thead><tr><th style={{ minWidth: 160 }}>名称</th><th style={{ width: 88 }}>类型</th><th style={{ width: 78 }}>大小</th><th style={{ width: 96 }}>更新时间</th><th style={{ width: 74 }}>权限</th><th style={{ width: '1%', whiteSpace: 'nowrap' }}>操作</th></tr></thead>
                <tbody>
                  {(!isRecent && !searchQ ? kids.data?.folders ?? [] : []).map((f) => (
                    <tr key={f.id}><td><button className="btn-link" onClick={() => goto(f.id)}>{f.name}</button></td><td className="muted">文件夹</td><td /><td>{fmtRel(f.updated_at)}</td><td><Pill plain status>{permLabel(f.my_permission)}</Pill></td>
                      <td className="nowrap"><RowActions kind="folder" id={f.id} name={f.name} parent={S(f.folder_id) || undefined} onMove={startMove} onCopy={null} onTrash={setTrashTarget} /></td></tr>
                  ))}
                  {list.map((f) => (
                    <tr key={f.id} style={f.id === params.focus ? { background: '#F4F8F3' } : undefined}>
                      <td><button className="btn-link" onClick={() => openFile(f.id)}>{f.name}</button>
                        {(f as Json).matched === 'name' ? <span className="tag" style={{ marginLeft: 6 }}>名称命中</span> : null}
                        {f.snippet ? <div className="small muted" style={{ maxWidth: 420 }}><Snippet text={S(f.snippet)} hits={jsonOf<[number, number][]>(f.hits, [])} /></div> : null}
                      </td>
                      <td className="muted nowrap">{f.ext || f.kind}</td>
                      <td className="num">{fmtSize(f.size)}</td>
                      <td className="nowrap">{fmtRel(f.updated_at)}</td>
                      <td><Pill plain status>{permLabel(f.my_permission)}</Pill></td>
                      <td className="nowrap"><RowActions kind="file" id={f.id} name={f.name} parent={S(f.folder_id) || undefined} onMove={startMove} onCopy={startCopy} onTrash={setTrashTarget}
                        onShare={() => setFileToShare({ id: f.id, name: f.name })} canShare={f.my_permission === 'manager'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {documentIsEmpty ? documentEmptyView : null}
            </>
          )}
          {jsonOf<Json[]>(search.data?.unsearchable, []).length ? (
            <div style={{ padding: '8px 16px' }}><Note tone="warn">
              部分文件正文暂不可检索：{jsonOf<Json[]>(search.data?.unsearchable, []).map((u) => S(u.name)).join('、')}
              <div className="small">没有命中不等于没写过 —— 上述文件无文本层（如扫描版 PDF，本版不做 OCR）或抽取未完成。</div>
            </Note></div>
          ) : null}
        </div>

        {(kids.data?.files ?? []).length ? (
          <div className="cluster" style={{ padding: '8px 16px', borderTop: '1px solid var(--line)' }}>
            <span className="muted small">{(kids.data?.files ?? []).length} 个文件 · {me?.user.display_name}</span>
          </div>
        ) : null}
      </section>

      {detailOpen ? (
      <aside className="detail floating-detail" aria-label="详情面板" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDetailOpen(false); } }}>
        <ColResizer edge="left" onResizeStart={cols.detail.onResizeStart} onNudge={cols.detail.nudge} label="拖动调整预览栏宽度" />
        <div className="detail-head"><b className="grow">{focus ? focus.name : '文件预览'}</b>
          <Btn size="sm" variant="primary" className="drawer-close" onClick={() => setDetailOpen(false)}>收起</Btn>
        </div>
        <div className="detail-body stack">
          {!params.focus ? <div className="muted small">请选择要预览的文件。</div> : null}
          {focusedFile.isError ? <Err onRetry={() => focusedFile.refetch()}>{errMsg(focusedFile.error)}</Err> : null}
          {focus && !preview.data ? <div className="cluster document-preview-actions">{fileActions}</div> : null}
          {focus && preview.isLoading ? <Skel rows={5} /> : null}
          {focus && preview.isError ? <Err onRetry={() => preview.refetch()}>{errMsg(preview.error)}</Err> : null}
          {focus && preview.data ? <PreviewPane key={focus.id} pv={preview.data} fileId={focus.id} actions={fileActions} /> : null}
          {focus ? (
            <>
              <div className="row-sep" />
              <div className="cluster"><b className="grow side-title">版本历史</b>
                <Btn size="sm" variant="ghost" onClick={() => { void api.get(`/files/${focus.id}/versions`).then(() => versions.refetch()); }}>刷新</Btn></div>
              <div className="version-list">{(versions.data ?? []).slice().sort((a, b) => Number(b.version_no) - Number(a.version_no)).map((v, i, arr) => (
                <div key={S(v.id)} className="row-meta">
                  <b>v{S(v.version_no)}</b>
                  <span className="grow truncate muted">{[S(v.summary ?? v.change_source), S(v.author_name)].filter(Boolean).join(' · ')}</span>
                  <span className="nowrap">{fmtRel(S(v.created_at))}</span>
                  {arr[i + 1] ? <Btn size="sm" variant="ghost" onClick={async () => {
                    const d = await api.get<Json>(`/files/${focus.id}/diff`, { from: S(arr[i + 1].id), to: S(v.id) });
                    setDiffView({ title: `v${S(arr[i + 1].version_no)} → v${S(v.version_no)}`, patch: S(d.patch) });
                  }}>对比</Btn> : null}
                  {i > 0 && canEditFocus ? <Btn size="sm" variant="ghost" onClick={async () => {
                    try { await api.post(`/files/${focus.id}/restore`, { version_id: S(v.id) }); toast(`已恢复为 v${S(v.version_no)} 的新版本`); qc.invalidateQueries({ queryKey: ['folders'] }); } catch (e) { toast(errMsg(e), true); }
                  }}>恢复</Btn> : null}
                </div>
              ))}</div>
              {focus.my_permission === 'manager' ? <>
                <div className="row-sep" />
                <div className="cluster"><b className="grow side-title">共享与权限</b><Btn size="sm" onClick={() => setDialog('share')}>设置</Btn></div>
                <div className="hint">设置成员权限（可查看 / 可编辑 / 可管理）</div>
              </> : null}
            </>
          ) : null}
        </div>
      </aside>

      ) : null}
      {trashTarget ? (
        <Confirm title={`删除「${trashTarget.name}」？`} body={null} danger confirmText="确认删除"
          onClose={() => setTrashTarget(null)} onConfirm={() => trashRow(trashTarget)} />
      ) : null}
      {dialog === 'new' ? <NewDialog folderId={folderId || S(activeSpace?.id)} onClose={() => setDialog('')} onDone={() => { setDialog(''); qc.invalidateQueries({ queryKey: ['folders'] }); }} /> : null}
      {dialog === 'space' ? (
        <NewSpaceDialog onClose={() => setDialog('')} onDone={(id) => {
          setDialog(''); qc.invalidateQueries({ queryKey: ['spaces'] });
          if (id) window.setTimeout(() => goto(id), 60);   // 建完直接进新空间，别让人再找一遍
        }} />
      ) : null}
      {renameSpace ? (
        <PromptDialog title={`重命名空间「${S(renameSpace.name)}」`} sub="空间名只影响显示，路径与权限不变"
          label="空间名称" initial={S(renameSpace.name)} confirmText="保存"
          onClose={() => setRenameSpace(null)}
          onSubmit={async (v) => {
            await api.patch(`/folders/${S(renameSpace.id)}`, { name: v });
            setRenameSpace(null);
            qc.invalidateQueries({ queryKey: ['spaces'] });
            qc.invalidateQueries({ queryKey: ['folders'] });
            toast('已重命名');
          }} />
      ) : null}
      {delSpace ? (
        <DeleteSpaceDialog space={delSpace} onClose={() => setDelSpace(null)} onDone={() => {
          setDelSpace(null); qc.invalidateQueries({ queryKey: ['spaces'] }); qc.invalidateQueries({ queryKey: ['folders'] });
          if (S(delSpace.id) === (folderId || spaceKey)) {
            const rest = (spaces.data ?? []).find((s) => S(s.id) !== S(delSpace.id) && s.id);
            setSpaceKey(S(rest?.id, '')); goto(S(rest?.id, ''));   // 删完落到还在的另一个空间，不留白屏
          }
        }} />
      ) : null}
      {fileToShare ? <SendFileDialog file={fileToShare} meId={me?.user.id ?? ''} onClose={() => setFileToShare(null)} /> : null}
      {dialog === 'share' && focus ? <ShareDialog file={focus} onClose={() => setDialog('')} /> : null}
      {dialog === 'trash' ? <TrashDialog onClose={() => setDialog('')} onChanged={() => qc.invalidateQueries({ queryKey: ['folders'] })} /> : null}
      {/* 转移 / 复制既可以由底部按钮发起（针对选中文件），也可以由行内「操作」发起（针对该行的文件或文件夹） */}
      {(dialog === 'move' || dialog === 'copy') && (rowAct ?? (focus ? { kind: 'file' as const, id: focus.id, name: focus.name } : null)) ? (
        <MoveDialog mode={dialog} kind={rowAct?.kind ?? 'file'} target={rowAct ?? { kind: 'file', id: focus!.id, name: focus!.name }}
          spaces={spaces.data ?? []} onClose={() => { setDialog(''); setRowAct(null); }}
          onDone={() => {
            setDialog('');
            // 移走的是当前正看着的文件：清掉选中，免得右栏指向已经不在这里的文件
            if (!rowAct || rowAct.id === params.focus) update({ focus: null });
            if (rowAct?.parent === folderId) qc.invalidateQueries({ queryKey: ['folders'] });
            qc.invalidateQueries({ queryKey: ['folders'] });
            qc.invalidateQueries({ queryKey: ['spaces'] });
            setRowAct(null);
          }} />
      ) : null}
      {editor ? <EditorDialog file={focus!} value={editor.text} base={editor.base} onChange={(t) => setEditor({ ...editor, text: t })}
        onClose={() => setEditor(null)} onConflict={(d) => setDiffView(d)}
        onSaved={() => { setEditor(null); qc.invalidateQueries({ queryKey: ['folders'] }); toast('已保存为新版本'); }} /> : null}
      {diffView ? <Modal title={`差异：${diffView.title}`} onClose={() => setDiffView(null)} footer={<Btn onClick={() => setDiffView(null)}>关闭</Btn>} wide><Diff text={diffView.patch} /></Modal> : null}
    </div>
  );
}

function PreviewPane({ pv, fileId, browserView = false, actions }: { pv: Json; fileId?: string; browserView?: boolean; actions?: ReactNode }) {
  const [sheet, setSheet] = useState(0);
  const [rendered, setRendered] = useState(true);
  const kind = S(pv.kind);
  const html = S(pv.html);
  const downloadUrl = S(pv.download_url);
  const browserHref = kind === 'pdf' ? S(pv.inline_url, downloadUrl)
    : !browserView && fileId && ['table', 'slides', 'html'].includes(kind) ? `/workspace?preview=${encodeURIComponent(fileId)}` : '';
  const browserLink = browserHref ? <a className="btn sm" href={browserHref} target="_blank" rel="noopener noreferrer">{kind === 'pdf' ? '用浏览器打开 PDF' : '用浏览器打开'}</a> : null;
  const sourceToggle = kind === 'html' && html ? <Btn size="sm" variant={rendered ? 'primary' : 'default'} onClick={() => setRendered(!rendered)}>{rendered ? '看源码' : '看结构'}</Btn> : null;
  const toolbar = browserLink || sourceToggle || actions ? <div className="cluster document-preview-actions">{browserLink}{actions}{sourceToggle}</div> : null;
  const unavailable = <Note>{pv.text_status === 'pending' ? '正在准备预览' : '暂时无法预览此文件'}</Note>;
  if (kind === 'table') {
    const sheets = jsonOf<Json[]>(pv.sheets, []);
    const rows = jsonOf<string[][]>(sheets[sheet]?.rows, []);
    return (
      <div className="stack">
        {toolbar}
        {sheets.length > 1 ? <div className="cluster">{sheets.map((s, i) => <Btn key={i} size="sm" variant={i === sheet ? 'primary' : 'default'} onClick={() => setSheet(i)}>{S(s.name, `工作表 ${i + 1}`)}</Btn>)}</div> : null}
        {rows.length ? <div className="table-wrap" style={{ maxHeight: browserView ? undefined : 340 }}><table className="grid"><tbody>
          {rows.slice(0, 201).map((r, i) => <tr key={i}>{r.map((c, j) => i === 0 ? <th key={j}>{S(c)}</th> : <td key={j}>{S(c)}</td>)}</tr>)}
        </tbody></table></div> : S(pv.text) ? <pre className="pre">{S(pv.text)}</pre> : unavailable}
        {sheets[sheet]?.truncated ? <Note tone="warn">表格预览仅显示前 200 行数据。</Note> : null}
        <div className="muted small">{S(pv.note)}</div>
      </div>
    );
  }
  if (kind === 'slides') {
    const slides = jsonOf<Json[]>(pv.slides, []);
    return <div className="stack">{toolbar}{slides.length ? slides.map((s, i) => (
      <div className="exec" key={i} style={s.is_note ? { borderLeftColor: 'var(--line-strong)' } : undefined}>
        <div className="exec-head">第 {S(s.page, String(i + 1))} 页{s.is_note ? <span className="tag">演讲备注</span> : null}</div>
        <div className="exec-title">{S(s.title)}</div>
        <div className="exec-body small">{S(s.text)}</div>
      </div>
    )) : unavailable}<div className="muted small">{S(pv.note)}</div></div>;
  }
  if (kind === 'pdf') {
    return <div className="stack">
      {toolbar}
      <Note>请在浏览器内置查看器打开下载链接</Note>
    </div>;
  }
  if (kind === 'html') {
    return <div className="stack">
      {toolbar}
      {html && rendered ? <HtmlView html={html} /> : html || S(pv.text) ? <pre className="pre">{S(pv.text)}</pre> : unavailable}
    </div>;
  }
  if (kind === 'image') return <div className="stack">{toolbar}<img src={S(pv.download_url || pv.url)} alt="图片预览" style={{ maxWidth: '100%', borderRadius: 8 }} /></div>;
  return <div className="stack">
    {toolbar}
    {pv.text_status && pv.text_status !== 'ready' ? <Pill status={S(pv.text_status)}>{S(pv.text_status === 'pending' ? '抽取中' : '正文不可检索')}</Pill> : null}
    {S(pv.html) ? <HtmlView html={S(pv.html)} /> : S(pv.text) ? <pre className="pre">{S(pv.text)}</pre> : null}
    {kind !== 'markdown' && pv.note ? <div className="muted small">{S(pv.note)}</div> : null}
  </div>;
}

async function sanitize(html: string): Promise<string> {
  // 走共用实现。原来这里写的是 `purify(html, cfg)`——dompurify 默认导出是工厂函数本身，
  // 那样调不会净化，而是返回一个新实例，String() 出来是函数源码（压缩后形如 r=>On(r)），
  // 结果 docx / html 预览位置会被渲染成一串源码文本。
  return sanitizeHtml(html);
}

function useSanitized(html: string) {
  const [out, setOut] = useState('');
  useEffect(() => { let alive = true; void sanitize(html).then((v) => { if (alive) setOut(v); }); return () => { alive = false; }; }, [html]);
  return out;
}

/** 新建空间：属于当前用户的独立根目录，与「我的文件」平级，不与团队/组织空间混权限 */
function NewSpaceDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="新建空间" onClose={onClose} footer={<>
      <Btn variant="ghost" onClick={onClose}>取消</Btn>
      <Btn variant="primary" loading={busy} disabled={!name.trim()} disabledReason="先起个名字" onClick={async () => {
        setBusy(true); setErr(null);
        try { const r = await api.post<Json>('/spaces', { name: name.trim() }); onDone(S(r.id)); }
        catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>创建</Btn>
    </>}>
      <div className="stack">
        {err ? <Err>{err}</Err> : null}
        <Field label="空间名称">
          <input type="text" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Note>仅可创建个人空间，团队 / 组织空间由成员关系自动生成</Note>
      </div>
    </Modal>
  );
}

/** 删除空间确认，保留接口返回的错误信息。 */
function DeleteSpaceDialog({ space, onClose, onDone }: { space: Json; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={`删除空间「${S(space.name, '未命名')}」？`} onClose={onClose} footer={<>
      <Btn variant="ghost" onClick={onClose}>取消</Btn>
      <Btn variant="danger" loading={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { await api.del(`/spaces/${S(space.id)}`); onDone(); }
        catch (e) { setErr(errMsg(e)); setBusy(false); }
      }}>确认删除</Btn>
    </>}>
      {err ? <Err>{err}</Err> : null}
    </Modal>
  );
}

/**
 * 「这里还没有内容」的判定：必须同时看文件和子目录。
 * 只判 files 会让「组织空间 / 产品知识库」这种只有子文件夹的目录显示成空，
 * 而下面表格里明明列着文件夹 —— 这就是用户报的自相矛盾。
 */
export function nothingToShow(files: unknown[] | null | undefined, folders: unknown[] | null | undefined, searching = false): boolean {
  if (searching) return !(files ?? []).length;
  return !(files ?? []).length && !(folders ?? []).length;
}

function NewDialog({ folderId, onClose, onDone }: { folderId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'folder' | 'file'>('file');
  const [name, setName] = useState('');
  const [format, setFormat] = useState<'markdown' | 'text'>('markdown');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={mode === 'folder' ? '新建文件夹' : '新建文件'} onClose={onClose} footer={<>
      <Btn variant="ghost" onClick={onClose}>取消</Btn>
      <Btn variant="primary" disabled={!name.trim()} onClick={async () => {
        setErr(null);
        try {
          if (mode === 'folder') await api.post('/folders', { parent_id: folderId || null, name });
          else await api.post('/files', { folder_id: folderId || null, name: /\.(md|txt|markdown)$/i.test(name) ? name : `${name}.${format === 'markdown' ? 'md' : 'txt'}`, format, content: format === 'markdown' ? `# ${name}\n\n` : '' });
          onDone();
        } catch (e) { setErr(errMsg(e)); const m = errMsg(e).match(/建议[名]?[:：]\s*(\S+)/); if (m) toast(`建议改用：${m[1]}`); }
      }}>创建</Btn>
    </>}>
      <div className="stack">
        {err ? <Err>{err}</Err> : null}
        <div className="cluster">
          <Btn size="sm" variant={mode === 'file' ? 'primary' : 'default'} onClick={() => setMode('file')}>文本 / Markdown</Btn>
          <Btn size="sm" variant={mode === 'folder' ? 'primary' : 'default'} onClick={() => setMode('folder')}>文件夹</Btn>
        </div>
        <Field label={<>名称 <span className="group-required" aria-hidden="true">*</span></>}><input type="text" required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        {mode === 'file' ? (
          <Field label="格式"><div className="cluster">
            <Btn size="sm" variant={format === 'markdown' ? 'primary' : 'default'} onClick={() => setFormat('markdown')}>Markdown</Btn>
            <Btn size="sm" variant={format === 'text' ? 'primary' : 'default'} onClick={() => setFormat('text')}>纯文本</Btn>
          </div></Field>
        ) : null}
        <div className="group-required-note"><span className="group-required">*</span>为必填项</div>
      </div>
    </Modal>
  );
}

function ShareDialog({ file, onClose }: { file: Node; onClose: () => void }) {
  const toast = useToast();
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const teams = useQ<Json[]>(['teams'], '/teams');
  const { orgId } = useSession();
  const aclUrl = file.kind === 'folder' ? `/folders/${file.id}/acl?kind=folder` : `/files/${file.id}/acl`;
  const acl = useQ<Json[]>(['acl', file.kind, file.id], aclUrl);
  const [principal, setPrincipal] = useState<'user' | 'team' | 'org'>('user');
  const [pid, setPid] = useState('');
  const [perm, setPerm] = useState<'viewer' | 'editor' | 'manager'>('viewer');
  const rows = jsonOf<Json[]>(acl.data, []).filter((row) => row.effect !== 'deny');
  async function save(grants: Json[]) {
    try { await api.put(aclUrl, { grants }); toast('权限已更新'); acl.refetch(); } catch (e) { toast(errMsg(e), true); }
  }
  return (
    <Modal title={`共享与权限 「${file.name}」`} onClose={onClose} wide
      footer={<Btn variant="primary" onClick={onClose}>完成</Btn>}>
      <div className="stack">
        {acl.isError ? <Err>{errMsg(acl.error)}</Err> : null}
        <div className="card tight">
          <div className="cluster">
            <select value={principal} style={{ width: 110 }} onChange={(e) => setPrincipal(e.target.value as 'user')}>
              <option value="user">成员</option><option value="team">团队</option><option value="org">组织</option>
            </select>
            {principal !== 'org' ? (
              <select value={pid} style={{ flex: 1 }} onChange={(e) => setPid(e.target.value)}>
                <option value="">请选择</option>
                {(principal === 'user' ? members.data ?? [] : teams.data ?? []).map((o) => (
                  <option key={S(o.user_id ?? o.id)} value={S(o.user_id ?? o.id)}>{S(o.display_name ?? o.name)}</option>
                ))}
              </select>
            ) : <input type="text" disabled value="本组织所有成员" style={{ flex: 1 }} />}
            <select value={perm} style={{ width: 110 }} onChange={(e) => setPerm(e.target.value as 'viewer')}>
              <option value="viewer">可查看</option><option value="editor">可编辑</option><option value="manager">可管理</option>
            </select>
            <Btn size="sm" variant="primary" disabled={principal !== 'org' && !pid} disabledReason="先选择对象"
              onClick={() => save([{ principal_type: principal, principal_id: principal === 'org' ? orgId : pid, permission: perm, effect: 'allow' }])}>添加</Btn>
          </div>
        </div>
        <div className="table-wrap">
          <table className="grid"><thead><tr><th>对象</th><th>权限</th><th>操作</th></tr></thead><tbody>
            {rows.map((r, i) => (
              <tr key={i}><td>{S(r.principal_name ?? r.principal_id)}</td><td>{permLabel(S(r.permission))}</td>
                <td><Btn size="sm" variant="ghost" onClick={() => save([{ principal_type: r.principal_type, principal_id: r.principal_id, permission: r.permission, effect: 'deny' }])}>撤销访问</Btn></td></tr>
            ))}
            {!rows.length && !acl.isLoading ? <tr><td colSpan={3} className="muted">暂无单独授予的权限</td></tr> : null}
          </tbody></table>
        </div>
      </div>
    </Modal>
  );
}

function TrashDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const trash = useQ<Json>(['trash'], '/trash');
  const [deleting, setDeleting] = useState<{ id: string; name: string; kind: 'file' | 'folder' } | null>(null);
  // 类型按「来自哪个数组」判定，不再靠 ext 是否为空猜（猜错过：无扩展名的文件被当目录，
  // 恢复时去调版本恢复接口必然 400，等于文件删了恢复不了）
  const rows: (Json & { __kind: 'file' | 'folder' })[] = [
    ...jsonOf<Json[]>(trash.data?.files, []).map((r) => ({ ...r, __kind: 'file' as const })),
    ...jsonOf<Json[]>(trash.data?.folders, []).map((r) => ({ ...r, __kind: 'folder' as const })),
  ];
  return (
    <><Modal title="回收站" onClose={onClose} wide footer={<Btn onClick={onClose}>关闭</Btn>}>
      <div className="stack">
        {trash.isLoading ? <Skel rows={3} /> : null}
        {!trash.isLoading && !rows.length ? <IllustratedEmpty kind="trash" title="暂无删除文件" /> : null}
        {rows.map((r) => (
          <div className="row-meta" key={`${r.__kind}-${S(r.id)}`}>
            <FileBadge ext={S(r.ext ?? (r.__kind === 'folder' ? '' : 'md'))} /><span className="grow">{S(r.name)}</span>
            <Pill plain tone="idle">{r.__kind === 'folder' ? '文件夹' : '文件'}</Pill>
            <span className="muted">{fmtRel(S(r.trashed_at))}</span>
            <Btn size="sm" onClick={async () => {
              try {
                const res = r.__kind === 'folder'
                  ? await api.post<Json>(`/folders/${S(r.id)}/restore`, {})
                  : await api.post<Json>(`/files/${S(r.id)}/restore-from-trash`, {});
                toast(S(res.note, '已恢复')); onChanged(); trash.refetch();
              } catch (e) { toast(errMsg(e), true); }
            }}>恢复</Btn>
            <Btn size="sm" variant="danger" onClick={() => setDeleting({ id: S(r.id), name: S(r.name), kind: r.__kind })}>永久删除</Btn>
          </div>
        ))}

        <Note>恢复后回到原目录，若原文件夹已回收，将回到「最近」空间中</Note>
      </div>
    </Modal>
    {deleting ? <Confirm title={`永久删除「${deleting.name}」？`} body={null} danger confirmText="永久删除" onClose={() => setDeleting(null)} onConfirm={async () => {
      try {
        await api.post(`/${deleting.kind === 'file' ? 'files' : 'folders'}/${deleting.id}/permanent-delete`, {});
        setDeleting(null); toast('已永久删除'); onChanged(); trash.refetch();
      } catch (e) { toast(errMsg(e), true); }
    }} /> : null}</>
  );
}

function SendFileDialog({ file, meId, onClose }: { file: { id: string; name: string }; meId: string; onClose: () => void }) {
  const [mode, setMode] = useState<'member' | 'conversation'>('conversation');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(idem('file-share'));
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  const toast = useToast();
  const qc = useQueryClient();
  const conversations = useQ<Json[]>(['conversations'], '/conversations');
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const query = mode === 'conversation' ? conversations : members;
  const options = (query.data ?? []).flatMap((row) => {
    const id = S(mode === 'conversation' ? row.id : row.user_id ?? row.id);
    if (!id || (mode === 'conversation' ? row.dissolved_at || Number(row.member_count) < 2 : row.disabled || id === meId)) return [];
    return [{ id, label: S(row.display_name ?? row.name, '未命名') }];
  });

  return (
    <Modal title={`分享「${file.name}」`}
      onClose={close}
      footer={<>
        <Btn disabled={busy} onClick={close}>取消</Btn>
        <Btn variant="primary" loading={busy} disabled={!options.some((option) => option.id === target)} onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await api.post(`/files/${file.id}/share`, {
              [mode === 'conversation' ? 'conversation_id' : 'user_id']: target, client_msg_id: requestId.current,
            });
            void qc.invalidateQueries({ queryKey: ['conversations'] });
            void qc.invalidateQueries({ queryKey: ['messages'] });
            toast('文件已分享');
            onClose();
          } catch (err) { setError(errMsg(err)); }
          finally { setBusy(false); }
        }}>发送</Btn>
      </>}>
      <div className="stack">
        <SubTabs value={mode} onChange={(value) => { setMode(value); setTarget(''); setError(''); }} items={[
          { key: 'conversation', label: '发送到会话' }, { key: 'member', label: '发送给成员' },
        ]} />
        <Field label={mode === 'conversation' ? '选择会话' : '选择成员'}>
          <select value={target} disabled={busy || query.isLoading} onChange={(event) => setTarget(event.target.value)}>
            <option value="">{query.isLoading ? '加载中…' : options.length ? '请选择' : '暂无可分享对象'}</option>
            {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </Field>
        {query.isError ? <Err onRetry={() => query.refetch()}>{errMsg(query.error)}</Err> : null}
        {error ? <Err>{error}</Err> : null}
      </div>
    </Modal>
  );
}

/** 表格「操作」列：转移 / 复制（仅文件）/ 删除。删除先进回收站，不物理删。 */
function RowActions({ kind, id, name, parent, onMove, onCopy, onTrash, onShare, canShare }: {
  kind: 'file' | 'folder'; id: string; name: string; parent?: string;
  onShare?: () => void;
  canShare?: boolean;
  onMove: (t: { kind: 'file' | 'folder'; id: string; name: string; parent?: string }) => void;
  onCopy: ((t: { kind: 'file' | 'folder'; id: string; name: string; parent?: string }) => void) | null;
  onTrash: (t: { kind: 'file' | 'folder'; id: string; name: string; parent?: string }) => void;
}) {
  const target = { kind, id, name, parent };
  return (
    <span className="row-actions">
      {onShare ? <button type="button" className="msg-tool" disabled={!canShare} title={canShare ? '分享文件' : '需要文件管理权限'} onClick={onShare}>分享</button> : null}
      <button className="msg-tool" onClick={() => onMove(target)}>转移</button>
      {onCopy ? <button className="msg-tool" onClick={() => onCopy!(target)}>复制</button> : null}
      <button className="msg-tool danger" onClick={() => void onTrash(target)}>删除</button>
    </span>
  );
}

function MoveDialog({ mode, kind, target: obj, spaces, onClose, onDone }: {
  mode: string; kind: 'file' | 'folder'; target: { kind: 'file' | 'folder'; id: string; name: string; parent?: string };
  spaces: Json[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [target, setTarget] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [confirmScope, setConfirmScope] = useState(false);
  const [busy, setBusy] = useState(false);
  const folders = useQ<{ folders: Json[] }>(['folders', target || 'root'], target ? `/folders/${target}/children` : '/folders/children');
  const what = kind === 'folder' ? '文件夹' : '文件';
  return (
    <Modal title={`${mode === 'move' ? '转移' : '复制'}${what}「${obj.name}」`} onClose={onClose}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" loading={busy} onClick={async () => {
          setBusy(true);
          try {
            if (mode === 'copy') { await api.post(`/files/${obj.id}/copy`, { target_folder_id: target || null }); toast('已复制到目标文件夹'); }
            else {
              const r = await api.post<Json>(`/${kind === 'folder' ? 'folders' : 'files'}/${obj.id}/move`, { target_folder_id: target || null, accept_scope_change: confirmScope });
              // 服务端两种回法都见过：needs_confirm 标记，或直接返回 scope_note
              if (r?.needs_confirm || (r?.scope_note && !confirmScope)) { setNote(S(r.scope_note, '移动后可见范围会扩大')); setBusy(false); return; }
              toast('已转移');
            }
            onDone();
          } catch (e) { const m = errMsg(e); setNote(m); toast(m, true); } finally { setBusy(false); }
        }}>{note && confirmScope ? '确认扩大范围并转移' : mode === 'move' ? '转移' : '复制'}</Btn>
      </>}>
      <div className="stack">
        <div className="cluster">
          {spaces.filter(s => s.id && !['recent', 'trash'].includes(S(s.space)) && !['recent', 'trash'].includes(S(s.kind))).map((s) => <Btn key={S(s.id)} size="sm" variant={(target || '') === S(s.id) ? 'primary' : 'default'} onClick={() => setTarget(S(s.id))}>{S(s.name)}</Btn>)}
        </div>
        <div className="table-wrap" style={{ maxHeight: 300 }}>
          <table className="grid"><tbody>
            <tr><td><button className="btn-link" onClick={() => setTarget('')}>（空间根）</button></td></tr>
            {(folders.data?.folders ?? []).map((f) => (
              <tr key={S(f.id)}><td><button className="btn-link" onClick={() => setTarget(S(f.id))}>{S(f.name)}</button></td><td className="muted small">进入</td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="hint">{kind === 'folder' ? '不能把文件夹移到它自己或它的下级里（服务端会拒绝并说明）。' : ''}目标：{target ? '已选工作区' : '空间根'}</div>
        {note ? <><Note tone="warn">{note}</Note><Check checked={confirmScope} onChange={setConfirmScope}>我已了解并同意扩大可见范围</Check></> : null}
      </div>
    </Modal>
  );
}

function EditorDialog({ file, value, base, onChange, onClose, onSaved, onConflict }: {
  file: Node; value: string; base: string; onChange: (v: string) => void; onClose: () => void; onSaved: () => void; onConflict: (d: { title: string; patch: string }) => void;
}) {
  const [text, setText] = useState(value || '');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [status, setStatus] = useState<'saved' | 'saving' | 'error' | 'dirty'>('saved');
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    void api.get<{ buffer?: string; content?: string }>(`/files/${file.id}/content`).catch(() => null)
      .then(async (r) => {
        if (!alive) return;
        let initial = '';
        if (r?.content) initial = r.content;
        else {
          const buf = await fetch(`/api/v1/files/${file.id}/download`, { credentials: 'same-origin' }).then((x) => x.ok ? x.text() : '').catch(() => '');
          initial = typeof buf === 'string' ? buf : '';
        }
        setText(initial); setLoading(false);
      });
    return () => { alive = false; };
  }, [file.id]);
  return (
    <Modal title={`编辑 「${file.name}」`} onClose={onClose} wide
      footer={<>
        <span className="muted small right">{status === 'saving' ? '保存中…' : status === 'error' ? '保存失败' : status === 'dirty' ? '有未保存修改' : '已保存'}</span>
        <Btn variant="ghost" onClick={onClose}>关闭</Btn>
        <Btn variant="primary" loading={busy} onClick={async () => {
          setBusy(true); setStatus('saving');
          try { await api.post(`/files/${file.id}/content`, { content: text, base_version_id: base, summary: '在线编辑' }); setStatus('saved'); onSaved(); }
          catch (e) {
            setStatus('error');
            const msg = errMsg(e);
            setConflict(msg);
            onConflict({ title: '与最新版本对比', patch: '' });
            toast(msg, true);
          } finally { setBusy(false); }
        }}>保存</Btn>
      </>}>
      <div className="stack">
        {loading ? <Skel rows={6} /> : (
          <>
            <textarea value={text} style={{ minHeight: '50vh', fontFamily: 'var(--mono)', fontSize: 13.5 }}
              onChange={(e) => { setText(e.target.value); setStatus('dirty'); }} aria-label="文件内容" />
            {conflict ? <>
              <Err>{conflict}</Err>
              <div className="cluster">
                <Btn size="sm" onClick={async () => { const v = await api.get<Json[]>(`/files/${file.id}/versions`); const cur = v[0]; setText(''); onConflict({ title: `最新版本 v${S(cur?.version_no)}`, patch: '' }); setStatus('saved'); window.location.reload(); }}>重新载入最新版本</Btn>
                <span className="muted small">你的输入仍保留在上方，可自行合并后再保存</span>
              </div>
            </> : null}
          </>
        )}
      </div>
    </Modal>
  );
}

function HtmlView({ html }: { html: string }) {
  const safe = useSanitized(html);
  return <div className="prose" dangerouslySetInnerHTML={{ __html: safe }} />;
}




