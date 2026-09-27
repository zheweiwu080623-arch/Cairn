# 能力搭建（flow-builder）

用**能力**拼出一个新功能的一页（M3）。左边是能力素材栏，点一下就加一个节点；
相邻节点之间自动连一条线；可以拖动换顺序；「试跑」只演练（真数据、零副作用）；
满意了「存成新功能」就会在 `modules/<id>/` 下写出 `module.json` + `flow.json` + `README.md`。

存出来的功能**没有 run.js** —— 它就是一张能力图，由 `lib/flow.mjs` 执行。

页面只调四个接口：`GET /api/capabilities`、`GET /api/flows`、
`POST /api/flows/dry-run`（**永远只演练**）、`POST /api/flows/save`。
