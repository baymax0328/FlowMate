// FlowMate · 跨模块契约与注册表
// 为什么用注册表而不是 Nest 构造注入：files↔orchestrator↔proposals↔tasks 存在双向依赖，
// 用 token 注入会形成循环引用；业务真相在数据库，服务本身是无状态的，注册表在启动时装配一次。
import type { Actor } from './permissions';

export type ID = string;
export type Json = Record<string, unknown>;

// ---------- 通用返回形态 ----------
export interface Page<T> { items: T[]; next_cursor?: string | null }
export type FileKind = 'markdown' | 'text' | 'html' | 'word' | 'pdf' | 'excel' | 'ppt' | 'image';

export interface FileDTO {
  id: ID; name: string; ext: string; mime: string; kind: FileKind; size: number;
  folder_id: ID | null; space: 'personal' | 'team' | 'org'; owner_id: ID | null; team_id: ID | null;
  current_version_id: ID | null; revision: number; created_at: string; updated_at: string;
  text_status?: 'pending' | 'ready' | 'unavailable' | 'failed' | null;
  text_reason?: string | null;
  my_permission?: 'viewer' | 'editor' | 'manager' | null;
  current_version?: VersionDTO | null;
}
export interface VersionDTO {
  id: ID; file_id: ID; version_no: number; size: number; mime: string; sha256: string;
  author_id: ID | null; agent_run_id: ID | null; base_version_id: ID | null;
  change_source: string; summary: string | null; created_at: string;
  object_key?: string;
}
export interface TextPayload {
  status: 'pending' | 'ready' | 'unavailable' | 'failed';
  reason?: string | null;
  raw_text: string;
  blocks: { block_id: string; seq: number; unit: number; kind: string; heading?: string; text: string; anchor: Json; rows?: string[][]; truncated?: boolean }[];
  preview: { kind: string; note?: string };
  preview_html?: string | null;
  unit_count: number;
  char_count: number;
  provider: string;
}

// ---------- Files ----------
export interface FilesService {
  createFolder(actor: Actor, input: { parent_id: ID | null; name: string; space?: 'personal' | 'team' | 'org'; team_id?: ID | null }): Promise<FileDTO>;
  /** 上传/新建文件并产生第一个版本；类型与大小按 §07 允许列表；返回后立即入队抽取 */
  createFile(actor: Actor, input: {
    folder_id: ID | null; name: string; buffer: Buffer; mime?: string;
    change_source?: 'upload' | 'user_edit' | 'restore' | 'agent_draft' | 'agent_formal' | 'seed';
    author_id?: ID; run_id?: ID | null; summary?: string; skipExtract?: boolean;
  }): Promise<{ file: FileDTO; version: VersionDTO; rejected?: undefined }>;
  addVersion(actor: Actor, input: {
    file_id: ID; buffer: Buffer; base_version_id?: ID | null; change_source: 'user_edit' | 'restore' | 'agent_draft' | 'agent_formal' | 'upload';
    author_id?: ID; run_id?: ID | null; summary?: string;
  }): Promise<VersionDTO>;
  /** 正式文件的原子提交（仅供 ProposalsService 在全部确认后调用；内部再校验权限/基准/锁） */
  commitFormalVersion(input: {
    file_id: ID; content: Buffer; base_version_id: ID; actor: Actor; run_id?: ID | null;
    lease_token: number; summary: string; proposal_id: ID;
  }): Promise<VersionDTO>;
  getFile(actor: Actor, file_id: ID, opts?: { require?: 'viewer' | 'editor' | 'manager' }): Promise<FileDTO>;
  listChildren(actor: Actor, folder_id: ID | null): Promise<{ folders: FileDTO[]; files: FileDTO[]; path: { id: ID; name: string }[] }>;
  treeForBinding(actor: Actor, rootFolderId: ID): Promise<{ id: ID; name: string; path: string; kind: 'folder' | 'file'; file_id?: ID; ext?: string }[]>;
  /** Agent 工具的路径解析：绑定根 + 逻辑路径 → file_id / folder_id；越界即抛 403 */
  resolveLogicalPath(actor: Actor, input: { root_folder_id: ID; include_children: boolean; path: string }): Promise<{ kind: 'folder' | 'file'; id: ID; rel_path: string }>;
  readVersion(version_id: ID): Promise<{ buffer: Buffer; file: FileDTO; version: VersionDTO }>;
  text(version_id: ID): Promise<TextPayload | null>;
  extractStatus(actor: Actor, file_id: ID): Promise<{ version_id: ID; status: string; reason: string | null; char_count: number }>;
  patchContent(actor: Actor, input: { file_id: ID; content: string; base_version_id: ID; summary?: string }): Promise<VersionDTO>;
  rename(actor: Actor, input: { kind: 'folder' | 'file'; id: ID; name: string }): Promise<void>;
  move(actor: Actor, input: { kind: 'folder' | 'file'; id: ID; target_folder_id: ID | null; accept_scope_change?: boolean }): Promise<{ needs_confirm: boolean; scope_note?: string }>;
  copy(actor: Actor, input: { file_id: ID; target_folder_id: ID | null }): Promise<FileDTO>;
  trash(actor: Actor, input: { kind: 'folder' | 'file'; id: ID }): Promise<{ ok: boolean; reason?: string; detail?: unknown }>;
  restore(actor: Actor, input: { kind: 'folder' | 'file'; id: ID }): Promise<void>;
  versions(actor: Actor, file_id: ID): Promise<VersionDTO[]>;
  diff(actor: Actor, input: { file_id: ID; from_version_id: ID; to_version_id: ID }): Promise<{ patch: string; stats: { added: number; removed: number } }>;
  aclSet(actor: Actor, input: { kind: 'folder' | 'file'; id: ID; grants: { principal_type: 'user' | 'team' | 'org'; principal_id: ID; permission: 'viewer' | 'editor' | 'manager'; effect?: 'allow' | 'deny' }[] }): Promise<void>;
  grantViewForShare(actor: Actor, fileId: ID, recipients: ID[]): ID;
  aclList(actor: Actor, input: { kind: 'folder' | 'file'; id: ID }): Promise<unknown[]>;
  /** 供检索/抽取 worker 使用 */
  queueExtraction(version_id: ID): Promise<void>;
  saveExtractionResult(version_id: ID, payload: TextPayload): Promise<void>;
  downloadUrl(actor: Actor, file_id: ID, version_id?: ID): Promise<string>;
  spaceRoots(actor: Actor): Promise<{ id: ID | null; name: string; space: string; team_id?: ID | null }[]>;
}

// ---------- Search ----------
export interface SearchService {
  /** 全局聚合；type=all 时返回分组。权限过滤在服务端，无权对象不返回标题与摘要（§15） */
  search(actor: Actor, q: string, type: 'all' | 'members' | 'conversations' | 'messages' | 'files' | 'tasks', opts?: { cursor?: string; limit?: number; folder_id?: ID; conversation_id?: ID }): Promise<Json>;
  /** Agent search.content：作用域强制收窄到绑定目录 */
  searchWithinBinding(actor: Actor, input: { query: string; root_folder_id: ID; include_children: boolean; fileTypes?: string[]; limit?: number }): Promise<Json[]>;
}

// ---------- Messages ----------
export interface MessagesService {
  listConversations(actor: Actor): Promise<Json[]>;
  createConversation(actor: Actor, input: { type: 'dm' | 'project'; member_ids: ID[]; name?: string; team_id?: ID | null }): Promise<Json>;
  messages(actor: Actor, conversation_id: ID, opts?: { before?: string; limit?: number; around?: ID }): Promise<{ items: Json[]; has_more: boolean }>;
  send(actor: Actor, input: { conversation_id: ID; body: string; parent_id?: ID | null; mentions?: ID[]; attachments?: { file_id: ID; version_id: ID }[]; client_msg_id?: string; card_type?: string; card_id?: ID }): Promise<Json>;
  edit(actor: Actor, input: { message_id: ID; body: string }): Promise<Json>;
  retract(actor: Actor, message_id: ID): Promise<void>;
  markRead(actor: Actor, conversation_id: ID): Promise<void>;
  members(actor: Actor, conversation_id: ID): Promise<Json[]>;
  addMembers(actor: Actor, conversation_id: ID, user_ids: ID[]): Promise<void>;
  removeMember(actor: Actor, conversation_id: ID, user_id: ID): Promise<void>;
  createTaskDraftFromMessage(actor: Actor, message_id: ID): Promise<Json>;
  handoffToAgent(actor: Actor, input: { conversation_id: ID; message_ids: ID[]; target: 'personal' | 'team'; team_id?: ID | null }): Promise<{ session_id: ID; prefilled: string; preview: Json }>;
}

// ---------- Sessions / Agent ----------
export interface SessionsService {
  list(actor: Actor, mode: 'personal' | 'team', opts?: { team_id?: ID }): Promise<Json[]>;
  get(actor: Actor, session_id: ID): Promise<Json>;
  createPersonal(actor: Actor, input: { title: string; folder_id?: ID | null; include_children?: boolean }): Promise<Json>;
  createTeamSession(actor: Actor, input: { title: string; team_id: ID; folder_id: ID; participant_ids: ID[] }): Promise<Json>;
  bindFolder(actor: Actor, input: { session_id: ID; folder_id: ID | null; include_children: boolean }): Promise<Json>;
  messages(actor: AgentActor, session_id: ID, opts?: { after_seq?: number; limit?: number }): Promise<Json[]>;
  postMessage(actor: Actor, input: { session_id: ID; body: string; parent_id?: ID | null; mentions?: ID[] }): Promise<Json>;
  addAuxiliaryImage(actor: Actor, input: { session_id: ID; buffer: Buffer; name: string; mime: string }): Promise<Json>;
  saveAuxiliaryToWorkspace(actor: Actor, input: { aux_id: ID; folder_id: ID }): Promise<Json>;
  share(actor: Actor, input: { session_id: ID; grantee_user_id: ID; range_type: 'all' | 'until' | 'selected'; range_payload?: Json; aux_image_ids?: ID[]; days?: number }): Promise<Json>;
  revokeShare(actor: Actor, share_id: ID): Promise<void>;
  createTeamBranch(actor: Actor, input: { source_session_id: ID; team_id: ID; folder_id: ID; title: string; history_scope: 'all' | 'until' | 'selected' | 'summary'; range_payload?: Json; aux_image_ids?: ID[]; participant_ids?: ID[]; idempotency_key?: string }): Promise<Json>;
  participants(actor: Actor, session_id: ID): Promise<Json[]>;
  addParticipant(actor: Actor, input: { session_id: ID; user_id: ID; role: 'coordinator' | 'participant' | 'viewer' }): Promise<void>;
  removeParticipant(actor: Actor, input: { session_id: ID; user_id: ID }): Promise<void>;
  bindingInfo(actor: Actor, session_id: ID): Promise<{ folder_id: ID | null; include_children: boolean; root_name: string | null }>;
  /** 该会话当前活跃的 request/run（切换文件夹前置检查用） */
  activeWork(actor: Actor, session_id: ID): Promise<{ runs: Json[]; requests: Json[]; proposals: Json[] }>;
}

// ---------- Orchestrator ----------
export interface OrchestratorService {
  createRequest(actor: Actor, input: { session_id: ID; goal: string; output_kind?: 'draft' | 'formal_change' | 'answer'; target_file_id?: ID | null; source_message_id?: ID | null; aux_ids?: ID[]; idempotency_key?: string; chat_mode?: boolean }): Promise<{ request: Json; runs: Json[]; clarification?: string }>;
  runsOfSession(actor: Actor, session_id: ID): Promise<Json[]>;
  runDetail(actor: Actor, run_id: ID): Promise<Json>;
  cancelRun(actor: Actor, run_id: ID, reason?: string): Promise<Json>;
  retryRun(actor: Actor, run_id: ID): Promise<Json>;
  answerClarification(actor: Actor, input: { request_id: ID; answer: string }): Promise<Json>;
  resolveConflict(actor: Actor, input: { conflict_id: ID; resolution: 'order' | 'option_a' | 'option_b' | 'clarify'; note?: string }): Promise<Json>;
  artifactsOf(actor: Actor, session_id: ID): Promise<Json[]>;
  readArtifact(actor: Actor, artifact_id: ID): Promise<{ content: string; file_id?: ID; version_id?: ID }>;
}

// ---------- Proposals ----------
export interface ProposalsService {
  create(input: {
    actor: Actor; session_id: ID; request_id?: ID | null; run_id?: ID | null;
    target_file_id: ID; base_version_id: ID; content: string; summary: string;
    instruction_ids: ID[]; required_approvers: ID[]; executor_id: ID;
  }): Promise<Json>;
  list(actor: Actor, opts?: { session_id?: ID; status?: string }): Promise<Json[]>;
  get(actor: Actor, proposal_id: ID): Promise<Json>;
  decide(actor: Actor, input: { proposal_id: ID; decision: 'approve' | 'reject' | 'request_changes'; reason?: string }): Promise<Json>;
  wake(actor: Actor, proposal_id: ID): Promise<Json>;
  void(actor: Actor, input: { proposal_id: ID; action: 'void' | 'withdraw'; reason?: string }): Promise<Json>;
  remindNow(actor: Actor, proposal_id: ID): Promise<Json>;
  /** 定时器调用：提醒节奏 + 72h 挂起 */
  tick(): Promise<{ reminded: number; suspended: number }>;
}

// ---------- Tasks ----------
export interface TasksService {
  list(actor: Actor, opts: { scope: 'mine' | 'team'; team_id?: ID; status?: string; sub?: 'assigned_by_me' | 'to_review' | 'to_handle'; q?: string; priority?: string; due?: string }): Promise<{ items: Json[]; stage_counts: Record<string, number>; snapshot_id: string }>;
  get(actor: Actor, task_id: ID): Promise<Json>;
  create(actor: Actor, input: Json): Promise<Json>;
  update(actor: Actor, input: { task_id: ID; patch: Json }): Promise<Json>;
  transition(actor: Actor, input: { task_id: ID; action: string; payload?: Json; idempotency_key?: string }): Promise<Json>;
  addProgress(actor: Actor, input: { task_id: ID; done_text?: string; blocked_text?: string; progress?: number }): Promise<Json>;
  agentSessionFor(actor: Actor, input: { task_id: ID; choice?: { mode: 'personal' | 'team'; folder_id?: ID; team_id?: ID } }): Promise<{ session_id: ID; created: boolean }>;
}

// ---------- Discovery ----------
export interface DiscoveryService {
  importNow(actor: Actor, input: { name: string; buffer?: Buffer; mime?: string; pasted_text?: string; source_kind: 'manual_upload' | 'pasted_text'; source_time?: string; team_id?: ID | null; folder_id?: ID | null }): Promise<Json>;
  imports(actor: Actor, opts?: { limit?: number }): Promise<Json[]>;
  importDetail(actor: Actor, import_id: ID): Promise<Json>;
  retry(actor: ImportActor, import_id: ID): Promise<Json>;
  candidates(actor: Actor, opts?: { import_id?: ID; status?: string }): Promise<Json[]>;
  confirm(actor: Actor, input: { candidate_id: ID; patch?: Json }): Promise<Json>;
  ignore(actor: Actor, input: { candidate_id: ID; note?: string }): Promise<Json>;
  clarify(actor: Actor, input: { candidate_id: ID; note: string }): Promise<Json>;
  watchConfigs(actor: Actor): Promise<Json[]>;
  saveWatchConfig(actor: Actor, input: Json): Promise<Json>;
  runWatchNow(actor: Actor, config_id: ID): Promise<Json>;
  /** worker 入口 */
  processImport(import_id: ID): Promise<void>;
}

// ---------- Center / Notifications / Audit ----------
export interface CenterService {
  overview(actor: Actor, filters: Json): Promise<Json>;
  runs(actor: Actor, filters: Json): Promise<Json[]>;
  changes(actor: Actor, filters: Json): Promise<Json[]>;
  conflicts(actor: Actor, filters: Json): Promise<Json[]>;
  events(actor: Actor, filters: Json): Promise<Json[]>;
  usage(actor: Actor, filters: Json): Promise<Json>;
}
export interface NotificationsService {
  list(actor: Actor, opts?: { unread_only?: boolean; limit?: number }): Promise<Json[]>;
  markRead(actor: Actor, id: ID): Promise<void>;
  markAllRead(actor: Actor): Promise<void>;
  unreadCount(actor: Actor): Promise<number>;
  emit(input: { user_id: ID; organization_id: ID; type: string; title: string; body?: string; entity_type?: string; entity_id?: ID; target_path?: string; actor_id?: ID | null; conversation_id?: ID | null; session_id?: ID | null; task_id?: ID | null; proposal_id?: ID | null }): Promise<void>;
}

// ---------- Org ----------
export interface OrgService {
  me(actor: Actor): Promise<Json>;
  organizationsFor(userId: ID): Promise<Json[]>;
  members(actor: Actor): Promise<Json[]>;
  teams(actor: Actor): Promise<Json[]>;
  createTeam(actor: Actor, input: { name: string; member_ids: ID[] }): Promise<Json>;
  invite(actor: Actor, input: { email: string; role: string; team_ids: ID[]; display_name?: string; password?: string }): Promise<Json>;
  updateMember(actor: Actor, input: { user_id: ID; role?: string; status?: string }): Promise<Json>;
}

// ---------- 注册表 ----------
export const services: {
  files?: FilesService;
  search?: SearchService;
  messages?: MessagesService;
  sessions?: SessionsService;
  orchestrator?: OrchestratorService;
  proposals?: ProposalsService;
  tasks?: TasksService;
  discovery?: DiscoveryService;
  center?: CenterService;
  notifications?: NotificationsService;
  org?: OrgService;
} = {};

export function need<K extends keyof typeof services>(key: K): NonNullable<typeof services[K]> {
  const s = services[key];
  if (!s) throw new Error(`服务未装配：${String(key)}（检查 app 启动顺序）`);
  return s;
}

/** 少量别名，避免 agent 写错类型名 */
export type AgentActor = Actor;
export type ImportActor = Actor;
