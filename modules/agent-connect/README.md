# 模块：Agent / 模型接入

第四个可插拔模块（`kind: gadget`，挂在「数据源」页）。

它解决的是"**有 agent 的人**和**只有一个 API Key 的人**都能用"这件事 ——
以前平台只认本机的 Codex CLI，现在四种都行：

| provider | 适合谁 | 需要填 |
| --- | --- | --- |
| **本机 Codex CLI** | 装了 Codex 的人（默认） | 什么都不用填 |
| **OpenAI 兼容接口** | 有 API Key 的人；也可指向 DeepSeek / Moonshot / vLLM / LM Studio | 接口地址 + 模型 + Key（本机地址可不填 Key） |
| **Anthropic** | 用 Claude 的人 | 同上 |
| **本地模型（Ollama）** | 想完全离线、不花钱的人 | 接口地址（默认 `http://127.0.0.1:11434`）+ 模型名 |

填好点「测试」会真的发一句 "只回复两个字：可用" 过去；失败会告诉你**下一步怎么做**
（例如"本地模型服务没开，命令行运行 `ollama serve`"）。

API Key 与其它凭据一样**加密存盘**（见 `lib/secrets.mjs`），接口只回掩码。
