# FlowMate · AI 原生协作工作台（v0.2 本地可运行版）

按《FlowMate 产品文档 v0.2》实现的完整 Web 应用：React 19 前端 + NestJS 11 后端 + 持久化数据库 + 文件存储 + 后台 Worker。
不是单 HTML 页面，也不用 localStorage 当业务库；四个一级模块（Message / Workspace / Agent / Task）的服务端全部真实落库。

---

## 1. 一分钟跑起来

前置：Windows / macOS / Linux，**Node.js ≥ 24**（用到内置 SQLite，无需安装数据库）。

```bash
pnpm install            # 依赖已在 pnpm-lock.yaml 固化
cp .env.example .env    # 不填模型密钥也能跑，见 §5
pnpm build              # 类型检查 + 编译后端 + 打包前端
pnpm seed               # 首次运行灌演示数据
pnpm start              # http://localhost:8080
```

开发模式（前端热更新 + 后端 watch）：`pnpm dev` → 前端 http://localhost:5173（代理到 8080）。

重置演示数据：`pnpm run seed:reset`（等价 `node dist/scripts/seed.js --yes-reset`，必须带确认参数，启动脚本绝不会自动清库）。

## 2. 演示账号（种子数据）

| 登录名 | 邮箱 | 职务 / 权限范围 |
| --- | --- | --- |
| baymax（大白伟） | `baymax@xingyu.test` | 负责人：组织所有者，三个团队全权限 |
| hy123（虎牙） | `hy123@xingyu.test` | 产品总监：产品团队负责人，研发团队成员 |
| cyx666（陈奕迅） | `cyx666@xingyu.test` | 设计总监：设计团队负责人，研发团队成员 |
| xuyangtian（许杨天） | `xuyangtian@xingyu.test` | 技术总监：研发团队负责人（不在产品/设计团队，兼作权限负例账号） |

统一密码：`abc123`（改 `.env` 里的 `SEED_PASSWORD` 后重新 `pnpm seed:reset` 可换）。
组织：星屿科技（产品团队 / 设计团队 / 研发团队）、汇川制造（用于组织切换）。

种子自带的数据：11 个工作区（组织空间 / 三个团队空间 / 四个人的「我的文件」+ 各自独立空间 / 产品知识库等）、18 个文件（以 md 为主，另含 docx / pdf / xlsx / pptx / html 各 1—2 个用于验证正文抽取）、4 个任务（分别停在四个阶段，便于演示五阶段流转）、1 个群聊。**不含任何会话/请求/Run**——Agent 相关数据一律由你在界面上真实操作产生。


## 3. 局域网给 2—3 人一起用

服务默认监听 `0.0.0.0:8080`，启动日志会打印内网地址。队友在同一网络下打开：

```
http://<你的内网IP>:8080
```

取内网 IP：`ipconfig`（找 IPv4 地址）或看启动日志里已打印的行。

Windows 放行入站端口（管理员 PowerShell，一次即可）：

```powershell
New-NetFirewallRule -DisplayName "FlowMate 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

**必须双人实测的动作**：共同确认（两人各点同意才写入）、Team 分支后双方同页输入、消息与提案的实时同步。
实测断言已写在 `tests/e2e.mjs` 里，同一台机器开两个浏览器（不同账号）也能跑通，因为它走的是同一套 HTTP/WS 接口。

安全妥协（v0.2 明示，见规格 D6）：HTTP 明文 + Cookie `Secure=false` + `SameSite=Lax`；界面顶部常驻「局域网测试环境，勿放敏感数据」横幅；仅限受信网络。

## 4. 数据在哪、怎么备份

| 内容 | 位置 |
| --- | --- |
| 数据库（SQLite，WAL） | `data/flowmate.sqlite3`（含 `-wal` / `-shm`） |
| 文件对象（不可变 UUID 键） | `storage/<前2位>/<uuid>` |
| 备份产物 | `backups/<时间戳>/backup.zip` + `manifest.json` |

```bash
pnpm backup             # 打包 DB + storage 到 backups/<时间戳>/
pnpm restore            # 恢复最近一次备份（会先把当前数据挪到 backups/pre-restore-*/）
pnpm restore backups\2026-10-26T13-40-00   # 或指定目录
```

`data/`、`storage/`、`backups/`、`.env` 都已在 `.gitignore` 内。

## 5. AI 能力与模型密钥

`.env` 里三项填齐即启用真实模型调用（标准 Chat Completions 接口，当前接 DeepSeek）：

```
MODEL_BASE_URL=https://<你的兼容端点>/v1
MODEL_API_KEY=***
MODEL_NAME=<模型名>
MODEL_VISION_NAME=<支持图片的模型名，可选>
```

- 未配置密钥时：Agent 的**计划与草稿**由内置确定性规划器产出，界面与 RunStep 全程标注 `planner=deterministic`（本地规划器 · 未调用模型）；而**纪要提取候选任务**依赖模型语义能力，会明确返回 `PROVIDER_UNAVAILABLE` 并可重试，FlowMate 不会用预制结果冒充提取成功（规格 §18 / §14.3）。
- 视觉输入：首次使用图片时真实探测模型是否支持（`GET /api/v1/agent/model-status` 可看结果），不支持就明确提示。
- 密钥只在后端读取，不进前端包、不进日志、不进模型上下文。

## 6. 目录结构

```
server/core/        配置、DB、鉴权会话、权限解析、路径边界、错误契约、事件+outbox、调度器、WebSocket
server/adapters/    模型适配器、本地存储、正文抽取管道（md/txt/html/docx/pdf/xlsx/pptx）
server/modules/     auth org files search messages notifications sessions orchestrator proposals tasks discovery center
db/migrations/      追加式 SQL 迁移（001~008）
src/                React 19：app 外壳与全局搜索 / features 四模块 / components UI 原语 / styles 设计系统
worker/             进程内 Worker 装配说明（Lite 模式下与 API 同进程，见 §7）
scripts/            seed、backup/restore、dev、类型与 SQL 自检
tests/              4 组核心不变量单测 + 端到端主链路脚本
docs/               功能覆盖表、测试报告、与规格的剩余差距
```

## 7. 与规格的三处技术替换（已在覆盖表逐条标注）

| 规格写的 | 本版落地 | 原因与保持的语义 |
| --- | --- | --- |
| PostgreSQL 16/17 + tsvector | `node:sqlite` + FTS5 + 中文二元组索引 | 目标机没有 PG/Docker；仍是真 SQL、真事务、真外键、真倒排索引；`pnpm install` 零外部服务 |
| Redis + BullMQ | 进程内调度器 `server/core/queue.ts` | 语义保留：命名队列并发上限、租约、fencing token、退避重试、重启从库恢复；业务真相始终在数据库 |
| Docker Compose | 单进程 `pnpm start`（API 托管前端 + Worker 同进程） | 局域网 2—3 人够用；Worker 与 API 同生命周期，界面常驻「Lite 模式」说明 |

**没有为省事放松的四条底线**：服务端鉴权、路径不越界、正式文件写入必须过共同确认、幂等与版本冲突检测——全部有自动化断言（见 docs/测试报告.md）。

## 8. 自检命令

```bash
pnpm typecheck      # 前端 + 后端类型检查
pnpm test           # 核心不变量单测（签名失效 / Task 状态机 / 路径边界 / 去重与分词 / 探针基址护栏）
node scripts/check-inserts.cjs server/modules/*/*.ts scripts/seed.ts   # SQL 列数与占位符自检
```

一条命令跑完全部回归（11 套，含端到端主链路与 SSR 渲染回归；实测通过数与仍未绿的断言见 `安装指南.md` §7）：

```bash
# 先另起一个验证实例，绝不拿日常使用的 8080 当靶子
node scripts/snapshot.mjs data-probe/flowmate.sqlite3      # 从线上库导一份一致性副本（不能用 cp：WAL 会被整段丢弃）
cp -r storage storage-probe
FLOWMATE_PORT=8090 FLOWMATE_DATA_DIR=data-probe FLOWMATE_STORAGE_DIR=storage-probe node dist/server/main.js &
pnpm verify                                                # 默认打 http://127.0.0.1:8090/api/v1
```

`pnpm verify` 会拒绝把靶址指向 8080（除非显式 `ALLOW_8080=1`）——这条护栏是踩过坑之后加的：
各探针历史上环境变量名互不相同，漏传任意一个就会静默用默认的 8080，把测试数据写进真实库里。

## 9. 交给别人怎么跑

见 [docs/交付与分发.md](docs/交付与分发.md)：三种方案（只给源码 / 连演示数据一起给 / 现场局域网演示）、每个目录放什么、密钥为什么不能进包、交付前自检清单。

一键出包（白名单式收录，且出包前会逐文件扫描本机 `.env` 里的真实密钥值，命中即中止）：

```bash
node scripts/package-release.cjs                # 源码 + 已构建产物 dist（对方 pnpm install 后直接 pnpm start）
node scripts/package-release.cjs --with-data    # 再带上干净的演示数据（data/ + storage/ 里被引用的对象）
node scripts/package-release.cjs --src-only     # 连 dist 也不带，对方自己 pnpm build
```

本机会留下验证痕迹的目录（`data-probe*` / `storage-probe*` / `scratch` / `.probe` / `backups` / `*.log`）在排除清单里，不会进包。

## 10. 演示动线（对着规格 §22）

1. **文件准备**：文档 → 组织空间/产品知识库/客户门户改版，上传一份 docx/pdf/pptx/md，看「抽取中 → 已可检索」。
2. **正文搜索**：搜一个只在 PDF 正文里出现的词；再看「正文不可检索」清单里的旧版合同扫描件。
3. **个人办公**：个人办公 新建会话 → 用树形选择器挑一个自己的工作区（可下钻子工作区、顶部显示完整路径）→ 对话模式直接问答，或工作模式让它读工作区文件后回答/产出草稿；右栏看工具步骤、草稿、「本次读取」版本清单。
4. **越界防护**：目标里写 `读取 ../../需求说明书-v1.md` → 对话中心 的 Run 详情里出现 `fs.read:denied` 与边界说明；个人会话试图绑团队/组织工作区会被服务端 403 并解释原因。
5. **进入团队**：会话行内「···」→ 新建团队分支（选范围与图片）→ 双方在团队会话同页输入。
6. **并行**：两人各提一条独立目标 → 两个执行槽真的并行，排队原因可见。
7. **共同确认**：两人指令影响同一正式文件 → 提案 `0/N → 1/N`（期间文件字节不变）→ 全部同意才写入且只写一次。
8. **超时挂起**：一方不表态，1 小时提醒、72 小时转「已搁置」（绝不自动通过），唤醒后基准变了转 stale 重审。
9. **任务流转**：创建 → 指派 → 接收 → 负责 → 提交产物（固定版本）→ 退回 → 再提交 → 通过。
10. **导入发现**：任务页「导入并分析」上传纪要 → 候选带可定位原文 → 确认后才进指派；重复导入不重复建。
11. **共享会话**：会话头部「共享」→ 多选成员（列表里不含自己、已共享的单独显示）→ 选历史范围（全部 / 从最新记录开始）与有效期（1/7/30 天 / 永久）→ 底部开关一键开启或撤销；对方只读可见，不能发言也不能触发执行。
12. **权限负例**：用许杨天（不在产品/设计团队）访问他人个人会话、私有文件、搜索、审批，服务端拒绝且不泄漏标题。

