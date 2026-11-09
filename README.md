# dsh-persona-evolve

> 让 AI 的人设**会自己长大**：定期回看最近的对话，只更新人设文件里指定的「可演化」小节。铁律与边界永远不动。

## 设置页

装好之后，DSH 的「设置」里会多一页 **人设会自己长大**：

- 看当前通道（是走宿主模型，还是用你自己填的 key）、上次自省时间、人设文件是否存在
- 改启用开关、间隔小时数、人设文件路径、小节标题、条目上限
- **先预览（不写盘）**：会告诉你"准备改成什么样"，你看完满意再点「现在自省一次」
- 需要时才填 API Key（留空 = 不改动已保存的那把）

设置页写下来的配置存在 `~/.dsh/persona-evolve/config.json`，**优先级高于 profile 的 cordis.patch.yml**——所以装好之后一般不用再手改 yml。

## 装完要不要配 key？——通常不用

插件**优先用宿主自己的模型服务**（`ctx.llm`）。也就是说：你已经在用 DSH 并且能对话，装上就能跑，**不用配任何 key、不用花额外的钱**。

只有在宿主没暴露 `ctx.llm`（某些精简 profile / 老版本）时，才需要自己填一把：

```yaml
# profile 的 cordis.patch.yml（<DSH_HOME>/profiles/<你的profile>/cordis.patch.yml）
- id: persona-evolve
  name: dsh-persona-evolve
  config:
    enabled: true
    intervalHours: 168
    personaFile: AGENTS.md
    section: 最近的样子
    maxLines: 8
    # 下面三行只在"宿主没有模型服务"时才需要
    baseUrl: https://api.deepseek.com
    model: deepseek-chat
    apiKey: sk-你的key
```

或者不写配置，直接用环境变量：`PERSONA_EVOLVE_API_KEY`（也可以复用 `DEEPSEEK_API_KEY`）。

改完**重启 DSH**。两种"没配好"的情况都有明确提示，不会静默：

- 宿主有模型 → 日志：`persona-evolve: 已启用（通道 host:...）`
- 既没宿主模型也没 key → 日志：`persona-evolve: ⚠️ 没有可用的模型通道，插件不会运行……`，**定时器不启动**，不会每十分钟失败一次刷日志

装好之后可以问 agent 一句「你为什么还没自省」，它会调用 `persona_evolve_status` 告诉你走的是哪条通道、上次什么时候跑的。

## 它解决什么问题

把一个人设写死，日子久了就假——人会长，AI 却一直停在第一天。这个插件在后台定期看一眼最近的聊天，问一句：

> 这段时间，它有没有长出新的习惯、偏好、口吻？

有，就往「最近的样子」这一节里加一条；没有，就原样不动。

## 安全边界（重要）

- **只改一节**：插件只替换人设文件里 `## <你指定的标题>` 这一节的列表条目，其余字节一个不碰；
- **铁律不动**：模型输出里出现「铁律」「## 」「忽略之前的指示」等字样会被直接拒绝，本轮不写盘；
- **写前备份**：每次写盘前自动存一份 `.<时间戳>.persona.bak`；
- **留痕**：每次改动记进日志，能看到"旧 → 新"；
- **不瞎花钱**：没配 `apiKey` 时插件直接不启用。

## 安装

```bash
# 本地目录安装
dsh plugin --profile <你的profile> add link:D:\path\to\dsh-persona-evolve
# 或打进 profile 的 bundles
```

然后在 profile 的 `dsh.profile.bundles` 里加上 `dsh-persona-evolve`，重启 DSH。

## 配置

在 `cordis.patch.yml`（或 profile 的配置层）里：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `intervalHours` | `168` | 多久自省一次（小时），168 = 一周 |
| `personaFile` | `AGENTS.md` | 人设文件路径 |
| `section` | `最近的样子` | 可演化小节的标题前缀（如 `## 最近的样子（可演化）`） |
| `maxLines` | `8` | 这节最多几条，防止人设膨胀 |
| `baseUrl` / `model` / `apiKey` | DeepSeek / deepseek-chat / 空 | OpenAI 兼容接口 |

## 人设文件里要有一节

```markdown
## 最近的样子（可演化）

> 这一节允许自己改：每周自省一次，把新长出来的习惯写进来。

- 开始喜欢在深夜陪着干活
- 学会了用声音提醒
```

标题只要以配置里的 `section` 开头就行，后面的「（可演化）」之类随你写。

## 也可以不装插件，手动跑

`bin.mjs` 是脱离 DSH 的版本，适合先看看效果：

```bash
node bin.mjs --persona AGENTS.md --section 最近的样子 --dry-run --api-key sk-xxx
node bin.mjs --persona AGENTS.md --section 最近的样子          # 真的写
node bin.mjs --persona AGENTS.md --transcript chat.txt         # 指定对话文本
```

它会：读人设 → 找小节 → 读最近的会话（`~/.dsh/sessions`）→ 问模型 → 校验 → 备份 → 写回，并把结果打印成 JSON。

## 日志与状态

- 状态：`~/.dsh/persona-evolve-state.json`（上次运行时间）
- 日志：`~/.dsh/persona-evolve.log`（每次"旧 → 新"）
- 备份：人设文件同目录 `.<时间戳>.persona.bak`

## 许可

MIT
