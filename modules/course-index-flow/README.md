# 课程资料索引（能力图版）

这个**功能**没有任何 `run.js` —— 它是 M2「功能 = 能力图」的第一个真实样例：
模块目录里只有 `module.json` 与 `flow.json`（一张五个节点、四条连线的图）。

| 节点 | 用哪条能力 | 干什么 |
| --- | --- | --- |
| `scan` | `course.scan` | 扫课程资料目录，认出课程与周次 |
| `read` | `course.text` | 把材料读成文字（可以只读某一门课） |
| `index` | `course.artifacts` | 生成「资料索引」Markdown |
| `save` | `file.write` | 写进 `<数据目录>/study/material-index.md` |
| `tell` | `notify.app` | 发一条本机通知说"索引已更新" |

跑法（**默认演练**，不会真的写文件）：

```bash
node bin/cairn.mjs mod test course-index-flow
node bin/cairn.mjs mod run  course-index-flow            # 演练
node bin/cairn.mjs mod run  course-index-flow --real     # 真跑（写文件 + 发通知）
```

它声明的能力写在 `module.json` 的 `requires.capabilities` 里；
装了但没声明的能力在运行时会被拦住（会报"没有声明"并告诉你该怎么加）。
