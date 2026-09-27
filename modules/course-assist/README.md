# 课程辅助（course-assist）

`kind: processor`。课程辅助那六件事的**同一个入口**：把"课程材料"变成能直接拿去学的东西。

按 2026-09-25 统一的术语：下面这六件事是**功能**（再处理运算的**结果**，用户能拿到的东西）；
它们底下复用的是**能力**（再处理运算的**能力**）：读课程材料 `course.materials.read`、
按课程/周次扫材料 `course.materials.scan`、生成索引 `course.index`、生成巩固包 `course.weekly`、
检索材料 `course.search`、当前周次 `course.week`。

| 功能 | 状态 | 产物 |
| --- | --- | --- |
| ① 资料信息整理整合 | ✅ 已有（`mode: index`） | `material-index.md`：按课程/周次列材料 + 类型 + 关键词 |
| ② 作业时间估算 | 计划中 | `weekly-workload.md` |
| ③ 每周巩固文件 | ✅ 已有（`mode: weekly`，2026-09-24 D5） | `week-<周次>-巩固.md` |
| ④ 常见错误总结 | 计划中（**缺数据源**：学期初还没有已评分作业与 TA 评语） | `common-errors.md` |
| ⑤ 考前"抱佛脚" | 计划中 | `cram-<考试名>.md` |
| ⑥ 练习反馈 | 计划中 | `practice-feedback.md` |

怎么跑：

```bash
# 演练（默认）：只规划，不写任何文件，会告诉你"将会写到哪个路径"
curl -X POST http://127.0.0.1:3210/api/modules/course-assist/run \
  -H 'Content-Type: application/json' -d '{"input":{"mode":"index"}}'

# 真写：产物落在 <数据目录>/study/material-index.md
curl -X POST http://127.0.0.1:3210/api/modules/course-assist/run \
  -H 'Content-Type: application/json' -d '{"dry_run":false,"input":{"mode":"index"}}'
```

界面上更简单：左侧 **📚 课程辅助** 那一页（与「今日」「通知」「音乐」并列）里选好资料目录，点按钮即可。

输入（`input`）：

| 字段 | 说明 |
| --- | --- |
| `mode` | `index`（资料索引）/ `weekly`（每周巩固包，可配 `week=N`）；别的值**什么都不做**（不猜、不硬造产物） |
| `course` | 只看某一门课（例如 `MATH1860J`）；不填=全部 |

边界：**只读**课程材料目录（不改名、不移动、不删除）；只往 `<数据目录>/study/` 写文件；
读不出来的材料（扫描件 / 图片 / 压缩包 / 视频）在索引里如实标记，不假装读过。
权限：`fs:read:course`（读课程资料）· `fs:write:data`（写数据目录）· `notify:app`（只有"还没设置目录"时才提醒）。
