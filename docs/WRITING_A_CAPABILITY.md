# 怎么加一条能力（三条路，从省事到动手）

> **能力** = 一个原子动作（"取一个网址""取 JSON 字段""发一条通知"）。
> **功能** = 用能力拼出来的一件事（"课程资料索引""每天把新课推给我"）。
>
> 这篇讲的是"**加一条能力**"。想加一个功能，先看 [WRITING_A_PROCESSOR.md](WRITING_A_PROCESSOR.md)。
> 在界面里的入口是同一个页面：侧边「🧩 能力搭建」。

---

## 先选一条路

| 你想干的事 | 走哪条路 | 要不要写代码 |
| --- | --- | --- |
| 做一件新事情（取数 → 筛 → 拼 → 通知） | 在「搭功能」里拖能力、连线、试跑 | **不用** |
| 想要一条新的"原子动作"，但它是已有能力的组合 | 拼好之后点「**存成新能力**」 | **不用** |
| 要的动作确实得写点逻辑（算个新东西 / 调一个没见过的接口） | 写一个单文件能力 | 要（但可以**不在浏览器里写**，见下） |

三条路出来的东西**地位一样**：都进能力登记表、都出现在素材栏、都能被拼进功能里。

---

## 台阶 0：能力就是文件 —— 用你自己的编辑器写

一条能力 = **数据目录下的一个文件**：

```
<数据目录>/capabilities/
  demo.upper.mjs       ← 手写的能力（导出 meta + run）
  demo.headline.json   ← 拼出来的能力（meta + 一张 flow 图）
```

Windows 上默认是 `C:\Users\<你>\Documents\Codex\...\data\capabilities\`（点「能力搭建 → 🛠 开发 · 能力 →
**打开能力目录**」直接打开它）。

**平台每次读取都会重新扫这个目录** —— 在 VS Code / Codex 里改完文件，回到页面点「重新扫描」就生效，
**不用重启服务**。浏览器里那个代码框只是兜底入口，不是唯一入口。

---

## 台阶 1：用能力拼一条新能力（零代码）

在「🧩 搭功能」里把图拼好 → 点「**存成新能力**」，给它一个点分的 id（如 `my.headline`）。
它会被写进 `<数据目录>/capabilities/<id>.json`，内容就是 `{ meta, flow }`：

```json
{
  "schema": "capability.v1",
  "id": "my.headline",
  "name": "把接口头条拼成一句话",
  "version": "1.0.0",
  "kind": "compute",
  "permissions": [],
  "idempotent": true,
  "cost": "none",
  "ui": { "label": "接口头条", "group": "自写", "icon": "🧩" },
  "flow": {
    "schema": "flow.v1",
    "nodes": [
      { "id": "get",  "capability": "http.get",     "input": { "url": "$input.url" } },
      { "id": "pick", "capability": "json.pick",    "input": { "data": "$get.json", "path": "title" } },
      { "id": "line", "capability": "text.template","input": { "template": "头条：{{value}}", "data": "$pick" } }
    ],
    "edges": [["get", "pick"], ["pick", "line"]],
    "out": "line"
  }
}
```

几条规矩（保存时会校验，不通过**不会留在盘上**）：

1. `id` 必须是点分的「域.动作」小写形式，且不能和平台自带的重名；
2. 图里用到的每条能力都必须**真的存在**（自带或另一条自写能力都行）；
3. **一条能力不能直接调它自己**；两条互相调用时，运行时会在第 8 层停下并明确报错（不许把一个文件变成死循环）；
4. `permissions` 可以**不写** —— 它会从图里引用的能力自动推出来（用了 `http.get` 就有 `net:outbound`）；
5. `out` 可选：指定哪一步的产出算这条能力的产出；不写就取**最后一个跑完的节点**。

### 取上游的产出：两种写法

| 写法 | 什么时候用 |
| --- | --- |
| `"$read.text"` | **整个值**就是上游的产出（数组还是数组、对象还是对象，类型不丢） |
| `"总结一下：${read.text}"` | 把上游的产出**夹在一段话里**（拼提示词、拼正文就靠它；取不到填空串） |

> `${…}` 是 2026-10-02 加的。在这之前只能"整串引用"，所以想拼一句提示词就得先插一个
> `text.template` 节点 —— 现在直接写在字符串里就行。**旧写法完全不受影响。**

---

## 台阶 2：给图加"如果…就…"

每个节点都能写一个**条件**（界面上是节点下面那个虚线框）：

| 你写的 | 意思 |
| --- | --- |
| （留空） | 每次都跑 |
| `$pick.count` | 取到的东西"成立"（非空、非 0、非 false）才跑 |
| `$pick.count > 0` | 比较：`>` `>=` `<` `<=` `==` `!=` `contains` `matches` |
| `{"ref":"$a.b","op":"eq","value":"x"}` | 完整写法（JSON） |

**条件不成立 = 安静跳过**，不是失败：那个节点标成 `⏭`，也不会产生任何动作。
而且"**上游没跑 ⇒ 下游自动也不跑**"，所以不用给每个下游节点重写一遍条件。

试跑（永远只演练）里能直接看到哪几个节点被跳过了、为什么。

---

## 兜底：真的写一段代码

要算一个新的东西（平台上还没有的算法），就写一个 `.mjs`：

```js
// <数据目录>/capabilities/demo.upper.mjs
export const meta = {
  id: 'demo.upper',            // 点分「域.动作」；不能和平台自带的重名
  name: '把文字转成大写',
  version: '1.0.0',
  kind: 'compute',             // read | compute | write | outbound
  permissions: [],             // 权限码见 lib/permissions.mjs 的词表
  idempotent: true,
  cost: 'none',                // none | tokens | money
  ui: { label: '转大写', group: '自写', icon: '🔤' },
};

export async function run(input = {}) {
  return { upper: String(input.text || '').toUpperCase() };
}
```

或在场页面「🛠 开发 · 能力」里写（那里有一份同样的模板 + 「保存并注册」+「试跑」）。

两条边界：

* **只能用 Node 内置能力**（Cairn 零第三方依赖，你的能力也得是）；
* 要动磁盘 / 网络 / 模型，就在 `permissions` 里写明 —— 拼进功能时那张权限清单是给用户看的。

---

## 怎么知道自己写对了

```bash
node bin/cairn.mjs cap list                    # 平台自带 + 自己写的，全都在
node bin/cairn.mjs mod test <功能 id>           # 校验 + 演练（零副作用）
```

界面上更直接：「能力搭建 → 🛠 开发 · 能力」里，每条自己写的能力都有「试跑」按钮；
拼进图之后在「试跑（演练）」里能看到每个节点跑没跑、产出了什么、本来会做什么。
