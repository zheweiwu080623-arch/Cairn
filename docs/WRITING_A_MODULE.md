# 写一个自己的模块（15 分钟）

> 目标：**加一个功能 = 加一个目录 + 注册一行**。不用改 `app.js`、不用动数据库、不用写设置页。
> 契约：`contracts/module.v1.schema.json`；参考实现：`modules/filter-profile/`（复杂）与 `modules/digest-preview/`（最小）。

---

## 1. 目录长什么样

```
modules/
  my-thing/
    module.json     ← 描述符（必须）
    view.js         ← 前端入口（view / gadget 必须有）
    README.md       ← 可选，但强烈建议
```

平台启动后会自动扫描 `modules/*/module.json`，通过 `GET /api/modules` 暴露给界面；
坏模块只会显示一行错误，**不会拖垮整个应用**。

## 2. 最小可用模块

`modules/my-thing/module.json`：

```json
{
  "schema": "module.v1",
  "id": "my-thing",
  "name": "我的小功能",
  "version": "0.1.0",
  "kind": "gadget",
  "mount_into": "connectors",
  "icon": "🧩",
  "entry": { "view": "view.js" },
  "data": { "reads": ["tasks"], "writes": [] },
  "permissions": [],
  "config": []
}
```

`modules/my-thing/view.js`：

```js
export function renderCard() {
  return `<div class="card mt" id="my-thing">
    <h3>🧩 我的小功能</h3>
    <div class="dim" id="mt-out">点一下试试</div>
    <button class="btn small" id="mt-btn">看看有多少任务</button>
  </div>`;
}

export async function mount(el, ctx) {
  el.innerHTML = renderCard();
  el.querySelector('#mt-btn').onclick = async () => {
    const state = await ctx.api('GET', '/api/state');
    el.querySelector('#mt-out').textContent = `你现在有 ${state.tasks.length} 条任务`;
  };
}
```

保存 → 刷新页面 → 打开「数据源」页，卡片就出现了。

## 3. 三种模块形态

| kind | 是什么 | 需要什么 | 挂在哪 |
| --- | --- | --- | --- |
| `view` | 一个独立页面（会出现在导航里） | `entry.view` | 自动创建 `#view-<id>` |
| `gadget` | 挂在某个已有页面里的小组件 | `entry.view` + `mount_into` | `mount_into` 指定的视图，如 `connectors` |
| `connector` | 一个数据源（走 `lib/connectors/` 那套） | 自己的取数模块 | 数据源页 |
| `job` | 定时任务 | `entry.server` | 后台调度 |
| `processor` | 再处理功能（吃 signal、吐 action） | `entry.run` 或声明式 `entry.flow` | 由调度或手动触发 |

想给功能加**自己的就地设置**：`module.json` 写 `"settings": true`，`view.js` 再导出
`settings(host, ctx)` —— 功能页右上角就会出现「⚙ 功能设置」，点开是右侧抽屉（覆盖式，不挤压页面）。
值自己存：走 `GET|POST /api/fn-settings`（键 `fn.<你的功能 id>.*`），别往设置页里塞。

## 4. 框架给你什么（`ctx`）

| 字段 | 作用 |
| --- | --- |
| `ctx.api(method, path, body)` | 带错误处理的接口调用（等价于页面内部那套） |
| `ctx.DB` / `ctx.state` | 最近一次 `/api/state` 的数据与界面状态（只读） |
| `ctx.refresh()` | 重新拉数据并重画（你改完数据后调用） |
| `ctx.toast(msg, color)` | 右下角提示 |
| `ctx.esc(s)` | HTML 转义（**渲染用户数据时必须用**） |

## 5. 几条约定（也是别人敢用你的模块的前提）

1. **声明式数据面**：`data.reads / data.writes` 写清楚你只碰哪些数据；别去写别人的表。
2. **声明式权限**：需要麦克风、网络、agent 调用就写进 `permissions`，安装时会被提示。
3. **UI 用框架的类**：`card` / `btn` / `dim` / `pill` / `field` —— 主题一换，你的模块自动跟着变；
   不要自己写死颜色与字体。
4. **纯函数优先**：把"算"和"画"分开（像 `filter-profile` 那样导出 `renderCard()`），**这样能被测试直接调用**。
5. **失败要可见**：出错就显示一行原因，不要静默失败。

## 6. 测试自己的模块

```js
// tests/my-thing.test.mjs
import { validateModule, scanModules } from '../lib/modules.mjs';
const found = scanModules(new URL('../modules', import.meta.url).pathname);
// 断言你的模块被识别、没有 error；再 import 你的 view.js 调 renderCard() 检查输出
```

平台的 36 套验证里已经包含：**描述符合法性、坏模块隔离、资源路径防穿越、模块能 import、mount 能跑通**。

## 7. 想给别人用？

模块就是一个目录：压缩它、或者发一个 PR 到 `modules/` 下即可。
建议在 `module.json` 里写清 `author` 与 `license` —— 平台会把它们显示在模块信息里。
