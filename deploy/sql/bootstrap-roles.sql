-- NerveOffice 数据库的一次性初始化（P5 设计 §3.3，ADR-005）：建两个角色与数据库。由数据库管理员（超级用户）在建库时执行一次。
--
-- 两个角色：
--   所有者（owner_role）：数据库的所有者，执行迁移，拥有全部表；
--   应用（app_role）：只能连接、使用 schema、读写业务表、读取迁移记录。不是超级用户，不拥有任何表：
--     关不掉审计表的触发器（只追加的保护），也执行不了 DDL。
-- 迁移由所有者执行，不写 GRANT（角色名由部署决定）：这里设好默认权限，所有者以后建的对象自动授权给应用。
--
-- 用法：角色名与库名用 psql 变量传入；两个密码从环境变量读，不出现在命令行里：
--   NERVE_DB_OWNER_PASSWORD=… NERVE_DB_APP_PASSWORD=… psql -v ON_ERROR_STOP=1 \
--     -v owner_role=nerve_owner -v app_role=nerve_app -v database=nerve_office -d postgres -f bootstrap-roles.sql
-- 缺少变量时 psql 不做替换，语句报错并停止。角色或库已经存在时同样报错：本脚本只执行一次。

-- 出错就停下，不依赖调用方有没有传 -v ON_ERROR_STOP=1
\set ON_ERROR_STOP on

\getenv owner_password NERVE_DB_OWNER_PASSWORD
\getenv app_password NERVE_DB_APP_PASSWORD

-- 密码随 CREATE ROLE 以明文发给服务器：这个会话不记语句日志（含按时长与按事务的抽样），出错时也不记语句原文，
-- pg_stat_statements 不记这类语句，免得明文的密码进服务器日志与统计视图
-- （只作用于 \connect 之前的这个会话，之后的语句不含密码；需要超级用户；没装 pg_stat_statements 时最后一行照常执行）
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_transaction_sample_rate = 0;
SET pg_stat_statements.track_utility = off;

CREATE ROLE :"owner_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'owner_password';
CREATE ROLE :"app_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';

-- 排序规则用内置的 C.UTF-8（与开发库相同），与操作系统的 libc、ICU 版本无关
CREATE DATABASE :"database" OWNER :"owner_role" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';

-- 新库默认允许任何角色连接、建临时表：只留给这两个角色（所有者本来就有全部权限）
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO :"app_role";

\connect :"database"

-- public 的权限写明，不依赖版本的默认值（PostgreSQL 15 起 PUBLIC 已经没有 CREATE）
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app_role";

-- 所有者以后建的对象：全部 schema 的 USAGE 与全部表的 SELECT（迁移记录在 drizzle schema 里，就绪探针要读）；
-- public 里的表可以增删改，序列可以取值
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" GRANT USAGE ON SCHEMAS TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" GRANT SELECT ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner_role" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
