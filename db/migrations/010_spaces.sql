-- 010 · 用户自建「空间」
-- 背景：文档页左侧「空间」列里，三类根（我的文件 / 各团队根 / 组织空间）是按成员关系自动派生的固定根，
-- 之前既没有「新建空间」的落点，也没有删除入口。
-- 这里加一列区分「用户自建空间根」与「派生根」，而不是新增 space 取值：
-- space 上有 CHECK (space IN ('personal','team','org')) 且各处按这三个值判权限/归属，加取值会牵动 ACL。
-- 同时 ensurePersonalRoot 必须补 `ifnull(is_space,0)=0`：它按「无父目录的 personal 根」定位「我的文件」，
-- 若不排除自建空间，新建一个同级 personal 根后该查询会变成不确定命中，上传与 Agent 绑定都会漂到别的根。
ALTER TABLE folders ADD COLUMN is_space INTEGER NOT NULL DEFAULT 0;

-- 自建空间根的检索走这个部分索引，避免每次列空间都扫全表
CREATE INDEX IF NOT EXISTS ix_folder_space_root ON folders(organization_id, parent_id, is_space) WHERE status='active';
