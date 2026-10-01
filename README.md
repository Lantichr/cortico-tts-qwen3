# cortico-tts-qwen3

给 Cortico 的 vtuber World 换一个 TTS 后端:[qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp)
的 Qwen3-TTS。主流 20 系显卡实测流式 RTF 0.25–0.33(约 4 倍速),流式首字节 0.4–0.7 s。

`src/` 是这套适配器的全部源码;`docs/deployment.md` 是从零部署的完整步骤。

## 为什么需要它

Cortico 的 vtuber World 按 VoxCPM2 的接口形状说话(`worlds.vtuber.ttsUrl` 上的
`/v1/audio/speech`),并在 `ttsRuntimeDir` 里按固定文件名 `llama-tts-server.exe` 拉起服务。
qwentts.cpp 的 `tts-server` 是同一件事的另一种做法:接口像但不等价,而且是**两个进程**。

本仓库把这两件事补齐,扩展那一侧不用改:

```
Cortico vtuber World
   │  spawn  worlds.vtuber.ttsRuntimeDir\llama-tts-server.exe
   │  HTTP   worlds.vtuber.ttsUrl  ──────────────┐
   ▼                                             │
llama-tts-server.exe(启动器,src/launcher)     │
   ├── tts-server.exe  :8080   qwentts,Qwen3-TTS │
   └── proxy.mjs       :8010   ←────────────────┘
```

启动器是扩展认的那个文件名,它自己再拉起上游与代理,并把子进程挂进一个
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object —— Windows 上扩展停止服务用
`proc.kill()`,只作用于目标进程,靠 job 才能把子孙一起带走。

## 代理抹平的四处差异

| | 扩展要的 | qwentts 给的 | 代理做的事 |
|---|---|---|---|
| 流式 | chunked WAV,先读 44 字节头取采样率 | 裸 PCM | 补一个 24 kHz 单声道 16 bit 的头再边收边转 |
| 声线 | 每次请求带 `reference_audio` + `prompt_text` | 注册制 | 按参考音频内容哈希注册并缓存;与部署声明那份相同就走预抽取的 `.spk`/`.rvq` |
| 字段 | 会发 `cfg_value` / `inference_timesteps` / `max_steps` | 不认识 | 只转发 `seed` / `temperature` / `top_k` / `top_p` / `repetition_penalty` / `max_new_tokens` |
| 语气词 | 语音正文里带 `[laughing]` / `[sigh]` 这类 VoxCPM2 行内标记 | 没有对应机制 | 转发前剥掉标记,笑声与叹息随之消失 |

`/v1/audio/align` 固定回 501:这个后端没有强制对齐模型,扩展据此把片内动作退回按字符比例估计。

## 快速开始

先照 `docs/deployment.md` 备好 qwentts 的可执行文件、GGUF 权重与参考音频特征,然后:

```powershell
node scripts/install.mjs `
  --runtime    <部署根>\runtimes\qwen3-tts `
  --server-exe <源码根>\qwentts.cpp\build\tts-server.exe `
  --talker     <权重目录>\qwen-talker-1.7b-base-Q8_0.gguf `
  --codec      <权重目录>\qwen-tokenizer-12hz-Q8_0.gguf `
  --voices-dir <部署根>\models\vtuber\voices `
  --voice myvoice
```

`<...>` 是你要代入的路径,含义与取法见 `docs/deployment.md` 开头的那张表;
`myvoice` 代指你的声线名,必须与参考音频同名。

安装器会编译启动器、把两个进程与 `launcher.ini` 铺进运行时目录,再起一次冒烟(打一次
`/health` 和一次合成)。装完把 Cortico 的 `worlds.vtuber.ttsRuntimeDir` 指向运行时目录、
`worlds.vtuber.ttsUrl` 指向代理端口即可。

## 已知限制

- **`cfg_value` / `inference_timesteps` / `max_steps` 在这个后端上不起作用。** 面板上它们
  看着像能调,实际会被代理丢掉。`seed` 与 `temperature` 照常透传。
- **没有强制对齐**,所以 `alignEnabled` 开着时每片会记一条 501。
- **参考音频必须是 24 kHz 单声道**才能抽 `.spk`/`.rvq`。

## 许可

本仓库自有代码随 Cortico 的许可。qwentts.cpp、Qwen3-TTS 权重与 Qwen3-ForcedAligner
各有各的许可,自行确认。
