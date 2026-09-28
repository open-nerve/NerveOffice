#!/bin/sh
# 测试环境的数据库初始化（P5 设计 §3.3、§3.4）：官方镜像第一次初始化数据目录时执行，
# 按 deploy/sql/bootstrap-roles.sql 建所有者与应用两个角色以及数据库。
# 两个密码经环境变量交给 psql（脚本里用 \getenv 读取），不出现在命令行里。
set -eu

: "${NERVE_DB_OWNER_PASSWORD:?缺少 NERVE_DB_OWNER_PASSWORD}"
: "${NERVE_DB_APP_PASSWORD:?缺少 NERVE_DB_APP_PASSWORD}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_role=nerve_owner -v app_role=nerve_app -v database=nerve_office \
  -f /nerve/sql/bootstrap-roles.sql
