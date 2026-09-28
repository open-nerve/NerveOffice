# 部署说明（M1：镜像与测试环境）

M1 交付的是生产镜像与一套测试环境，用于验收与容器 E2E。正式环境的部署包、备份与恢复、升级与运维手册在 M7（00 号计划书 §13.2）。

| 路径 | 内容 |
|---|---|
| `Dockerfile` | 生产镜像：多阶段构建，运行镜像只有 Node 与构建产物，非 root 运行，自带健康检查 |
| `sql/bootstrap-roles.sql` | 数据库两个角色（所有者、应用）与数据库的一次性初始化 |
| `test/` | 测试环境的编排：应用 + PostgreSQL 18 + Caddy（HTTPS） |
| `dev/compose.yaml` | 本机开发用的 PostgreSQL，与部署无关 |

## 部署形态

```
浏览器 ──HTTPS──▶ Caddy（TLS 与转发）──HTTP──▶ app（前端页面与 /api，同源）──▶ PostgreSQL
                                        migrate（一次性任务）──────────────────▶
```

- 一个应用容器同时托管前端页面与接口（同源）。安全头（CSP、HSTS 等）、Cookie 与缓存策略都由应用下发；反向代理只做 TLS 与转发，不增加也不改写它们。
- 迁移是单独的一次性任务（`node dist/cli/migrate.js`），在应用启动之前以所有者角色执行。应用启动时不迁移，只检查库结构版本：不一致时就绪探针返回 503。
- 数据库用两个角色：所有者执行迁移并拥有全部表；应用运行时只能读写业务表（见下文"数据库角色"）。

## 构建镜像

在仓库根目录执行：

```sh
docker build -f deploy/Dockerfile -t nerve-office:test \
  --build-arg VERSION=0.1.0 --build-arg REVISION="$(git rev-parse --short HEAD)" .
```

`VERSION` 与 `REVISION` 写进镜像的 OCI 标签，可以不传。镜像里带着服务端依赖的第三方许可清单（`/app/licenses/`）。

## 起测试环境

1. 复制变量模板，把三个密码换成随机值（只用字母与数字，它们要拼进连接串，例如 `openssl rand -hex 16`）：

   ```sh
   cp deploy/test/.env.example deploy/test/.env
   ```

2. 启动。依次是 `db`（第一次初始化数据卷时按 `sql/bootstrap-roles.sql` 建角色与库）、`migrate`（执行迁移后退出）、`app`（健康检查通过后）、`caddy`：

   ```sh
   docker compose -f deploy/test/compose.yaml up -d
   ```

3. 初始化首个系统管理员（只能执行一次，第二次按设计失败）。密码从标准输入读，不要写在命令行参数里：

   ```sh
   docker compose -f deploy/test/compose.yaml run --rm --no-deps -T app \
     node dist/cli/init-admin.js --username admin --password-stdin < 保存密码的文件
   ```

4. 浏览器打开 `https://localhost:8443`。证书由 Caddy 自带的 CA 签发（Caddy 以 nobody 运行，证书放在 tmpfs 里，每次启动重新签发），浏览器会提示不受信任，测试环境里确认继续即可。正式环境要换成公网证书或自有 CA。应用经 HTTPS 下发一年期的 HSTS，而浏览器按主机名记住它、不分端口：用日常的浏览器打开之后，本机其他 `http://localhost:<端口>` 的服务也会被改成 HTTPS。建议用单独的浏览器配置文件（或无痕窗口）访问测试环境；本项目的开发服务器用 `127.0.0.1`，不受影响。
5. 停止用 `docker compose -f deploy/test/compose.yaml down`；连同数据一起删除时加 `-v`。

之后的账户都经管理界面邀请（系统管理员签发一次性链接，经受控的渠道发给本人）。唯一的系统管理员忘记密码、进不了管理界面时，用运维命令为他签发重置链接（24 小时内有效，同时让他的当前密码与全部登录失效；不授予任何角色）。在运行中的应用容器里用 `exec` 执行：

```sh
docker compose -f deploy/test/compose.yaml exec -T app \
  node dist/cli/reset-link.js --username admin
```

标准输出只有链接（只显示这一次），日志写标准错误：把链接交给本人打开、设置新密码，不要贴进工单或聊天记录。签发记入审计（操作者是系统，来源是命令行）。不要用 `docker compose run` 执行这条命令：一次性容器的标准输出归容器的日志驱动收集，配置了集中日志时，链接会进日志系统；`exec` 的输出直接回到终端。

容器 E2E（`pnpm test:e2e:container`）自己构建镜像、生成随机密码、挑选空闲端口，用单独的编排项目名起一套环境，跑完删除，不影响手工起的这一套。默认只跑 Chromium，`--browsers chromium,webkit` 可以多选；`--` 之后的参数交给 Playwright（例如 `pnpm test:e2e:container -- --project restart --no-deps` 只跑重启用例）。各容器的日志留在 `tests/e2e/test-results/container/`。放到后台跑用 tmux、screen 或 `setsid`，不要用 `nohup`：编排脚本处理 SIGHUP（关掉终端时先让 Playwright 正常结束，再清理），`nohup` 设下的忽略对它不起作用。

### 升级

顺序是 备份 → 迁移 → 换镜像：

1. 备份数据库，例如 `docker compose -f deploy/test/compose.yaml exec -T db pg_dump -U postgres -Fc nerve_office > nerve_office.dump`（正式环境的备份与恢复在 M7）；
2. 构建新镜像（用新的标签），改 `.env` 里的 `NERVE_IMAGE`；
3. `docker compose -f deploy/test/compose.yaml up -d`：compose 先停掉旧的应用（SIGTERM，排空在途请求再退出）并按新镜像重建 `migrate` 与 `app`，然后执行迁移（只向前、带锁，没有新迁移时说明"已是最新"），成功结束之后才启动新的应用。迁移期间服务不可用，单实例的测试环境可以接受；
4. 核对：经 HTTPS 的存活探针通过，应用日志里有"数据库已就绪，库结构版本一致"。

迁移只向前，回滚要从备份恢复。

### 变量（`deploy/test/.env`）

| 变量 | 说明 |
|---|---|
| `NERVE_IMAGE` | 用 `deploy/Dockerfile` 构建的镜像 |
| `NERVE_DB_ADMIN_PASSWORD` | PostgreSQL 管理员（`postgres`）的密码 |
| `NERVE_DB_OWNER_PASSWORD` | 所有者角色 `nerve_owner` 的密码（迁移用） |
| `NERVE_DB_APP_PASSWORD` | 应用角色 `nerve_app` 的密码（应用运行时用） |
| `NERVE_TEST_HTTPS_PORT` | 发布到本机回环的 HTTPS 端口，默认 8443；公开地址随之是 `https://localhost:<端口>` |
| `NERVE_TEST_DB_PORT` | 发布到本机回环的数据库端口，默认 54319，供测试数据与排查使用 |
| `NERVE_LOG_LEVEL` | 日志级别，默认 `info` |
| `NERVE_LOGIN_IP_MAX_FAILURES` | 按客户端地址的登录失败上限（15 分钟窗口），默认 50 |

三个密码只在第一次初始化数据卷时生效；之后要改，先 `down -v` 删除数据卷。应用的其余配置（`NERVE_*`）见 `apps/api/src/modules/config/config.ts`，未知的 `NERVE_*` 变量会让应用拒绝启动。

## 数据库角色

`sql/bootstrap-roles.sql` 由数据库管理员在建库时执行一次，建两个角色与数据库：

- **所有者**（测试环境里是 `nerve_owner`）：数据库的所有者，执行迁移，拥有全部表；
- **应用**（`nerve_app`）：只有连接、使用 schema、增删改查业务表、读取迁移记录的权限。它不是超级用户，也不拥有任何表，所以关不掉审计表的触发器（审计记录只追加），也执行不了 DDL。

迁移不写 `GRANT`（角色名由部署决定）：脚本用默认权限（`ALTER DEFAULT PRIVILEGES`）让所有者以后建的表自动授权给应用，之后的迁移不需要补授权。

在自己的 PostgreSQL（18 及以上）上执行时，角色名与库名用 psql 变量传入，两个密码从环境变量读取，不出现在命令行里：

```sh
NERVE_DB_OWNER_PASSWORD=… NERVE_DB_APP_PASSWORD=… psql -v ON_ERROR_STOP=1 \
  -v owner_role=nerve_owner -v app_role=nerve_app -v database=nerve_office \
  -d postgres -f deploy/sql/bootstrap-roles.sql
```

应用启动时检查自己的角色：是超级用户或者是审计表的所有者时，记一条告警"连接数据库的角色关得掉审计表的触发器……"。本机开发与本机测试用的是超级用户，这条告警是预期的。

## 反向代理的要求

换用别的反向代理时，同样要满足下面几条（`test/Caddyfile` 是参照）：

- **信任代理**：应用设置 `NERVE_TRUST_PROXY=1`，只信任紧挨着的一跳。前提是应用的端口只有反向代理连得到（测试环境不发布应用的端口）；否则任何人都可以伪造 `X-Forwarded-For`，冒充别的客户端地址。代理要转发 `X-Forwarded-For` 与 `X-Forwarded-Proto`，并且不采信客户端自己带来的转发头。配置不对时，应用会记一条告警"反向代理转发来的请求不是 HTTPS……"：这时客户端地址都是代理的地址（登录限流按地址的维度、审计里的地址都会出错），HSTS 也不会下发。
- **不压缩、不解压**：文档内容接口直接下发 gzip 字节（`Content-Encoding: gzip`），代理不要再压缩，也不要替客户端透明解压。
- **请求体上限不低于 6 MB**：快照的上限是 5 MiB，加上查询串与余量。
- **到应用的空闲连接早于 5 秒回收**：应用的空闲连接超时是 5 秒（`NERVE_HTTP_KEEP_ALIVE_TIMEOUT_MS`），代理复用应用已经关掉的连接会得到 502。
- **就绪探针不对外**：`/api/health/ready` 的 503 说明里有迁移名，只给编排与监控用；对外的存活探针是 `/api/health/live`。应用的路由不区分末尾斜杠与大小写（`/api/health/ready/`、`/api/HEALTH/READY` 同样是就绪探针），代理要按前缀、不区分大小写屏蔽，不能只屏蔽这一个精确的地址。
- **按地址限速（建议）**：应用对等待密码哈希的请求有上限，超出时返回 503 与 `Retry-After`，不会无限排队；在反向代理上对登录接口按客户端地址限速，可以把洪水挡在更前面。Caddy 的标准构建没有限速模块，这一条随 M7 的运维手册落实（DEF-023）。

## 已知限制

- 单实例：升级时先停应用、再迁移、再启动，期间服务不可用。不停机的滚动发布、退出前的摘流量（preStop）与多实例在 M7 随部署包决定（DEF-024）：滚动发布时，已经迁移的库比还在运行的旧实例新，旧实例的就绪探针会失败。
- 测试环境的证书来自 Caddy 自带的 CA，浏览器不信任。
- 镜像在本机与 CI 上构建，没有发布到镜像仓库。

## 排查

- `db` 一直不健康：看 `docker compose -f deploy/test/compose.yaml logs db`。第一次初始化（建角色与库）失败时，数据卷里已经有了数据目录，再启动不会重新执行初始化脚本，健康检查因为库不存在而一直失败：修好原因（例如变量）之后 `down -v` 删掉数据卷再起。

- 应用的日志是每行一条的 JSON：`docker compose -f deploy/test/compose.yaml logs app`。每个请求带 `requestId`，与响应头 `X-Request-Id`、错误响应里的 `requestId` 一致。
- 就绪探针只在编排网络里可达：`docker compose -f deploy/test/compose.yaml exec app node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(async r => console.log(r.status, await r.text()))"`。
- 数据库只发布到本机回环：`psql "postgres://postgres:<管理员密码>@127.0.0.1:54319/nerve_office"`。
