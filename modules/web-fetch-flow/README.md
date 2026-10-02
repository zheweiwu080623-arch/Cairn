# 示例：零代码接一个接口

这个功能的目录里**没有 run.js**，只有一张 `flow.json` —— 四个节点、三条连线，
全部由能力拼出来。它演示的是 2026-10-02 加的「通用原子能力 + 条件」：

| 节点 | 用哪条能力 | 干什么 |
| --- | --- | --- |
| `get` | `http.get` | 取一个 JSON 接口 |
| `pick` | `json.pick` | 从回应里取 `full_name` 与 `stargazers_count` |
| `line` | `text.template` | 把两个字段拼成一句话 |
| `talk` | `notify.app` | **条件：`$get.ok`** —— 只有真取回来了才发通知 |

跑法（默认演练，不会真的发通知）：

```bash
node bin/cairn.mjs mod test web-fetch-flow
node bin/cairn.mjs mod run  web-fetch-flow            # 演练（**会真的去取一次网址**）
node bin/cairn.mjs mod run  web-fetch-flow --real     # 真跑（会进通知）
```

## 换成你自己的接口

改 `flow.json` 里的 `url` 就行，不用写代码。想接的那个接口返回什么字段，
先用一句 `json.pick` 的 `fields` 描述出来，再用 `text.template` 拼成人话。

或者在界面里：**能力搭建 → 搭功能** —— 左边点能力、右边连线、试跑，然后「存成新功能」。
同一张图也可以直接「存成新能力」，下次它就会出现在素材栏里。

> 这个模块是**示例**，排在菜单最后，可以随时在「设置 → 功能」里取消勾选、或者直接删掉目录。
