# 部署:把 worlds.vtuber 的 TTS 后端换成 Qwen3-TTS

从零到能出声的完整步骤。以 Windows + NVIDIA 为例;`<...>` 是你要替换的路径。

先确认前置条件都到位:

| | 要求 | 说明 |
|---|---|---|
| GPU | 支持 CUDA,显存 ≥ 6 GB | 1.7B Q8_0 权重约占 2.2 GB,KV cache 与工作区另约 2 GB |
| Node.js | ≥ 18 | 代理用内置 `fetch`,不装依赖 |
| CUDA Toolkit | 12.x | 提供 `nvcc` 与运行时的 cudart/cublas |
| Visual Studio | BuildTools,含 C++ 工作负载 | 编 qwentts 与启动器 |
| CMake + Ninja | 任意近期版本 | Ninja 用来绕开 CUDA 与新版 MSBuild 的集成问题 |
| 磁盘 | ≥ 12 GB | 源码、权重、运行时 |

不需要 Python。仓库里没有那个依赖。

---

## 第 1 步:构建 qwentts.cpp

```powershell
git clone --recurse-submodules --depth 1 https://github.com/ServeurpersoCom/qwentts.cpp.git E:\Programs\qwentts.cpp
```

编译。用 **Ninja** 而不是 Visual Studio 生成器:CUDA 12.8 的 MSBuild 集成只覆盖 VS 2022,
装了更新的 Visual Studio 会得到 `No CUDA toolset found`。

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cd /d E:\Programs\qwentts.cpp
mkdir build & cd build
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON ^
  -DCMAKE_CUDA_ARCHITECTURES=<你的 SM> -DCMAKE_CUDA_FLAGS="-allow-unsupported-compiler"
cmake --build . -j 16
```

`<你的 SM>` 是显卡的计算能力去掉小数点:`75` = Turing(T4/T10/RTX 20),
`86` = RTX 30,`89` = RTX 40,`120` = Blackwell。跑一次 10 分钟上下。

产物在 `build\` 下的三个可执行文件里,本仓库只用到 `tts-server.exe`
(另外两个 `qwen-tts.exe` / `qwen-codec.exe` 分别是命令行合成与声线特征抽取)。

> 运行时要能在 PATH 上找到 cudart / cublas。启动器会把你填的 `cuda_bin` 加进去,
> 所以不必改系统 PATH。

## 第 2 步:取权重

```powershell
$dest = 'E:\Cortico-Data\models\qwen3-tts\gguf'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$base = 'https://hf-mirror.com/Serveurperso/Qwen3-TTS-GGUF/resolve/main'
foreach ($f in 'qwen-talker-1.7b-base-Q8_0.gguf','qwen-tokenizer-12hz-Q8_0.gguf') {
  curl.exe -L --retry 3 -o "$dest\$f" "$base/$f"
}
```

约 2.2 GB。**必须用 `base`,不是 `customvoice`**:只有 base 支持从参考音频克隆音色,
`customvoice` 只认它自带的那几个说话人,而本仓库的声线机制走的是克隆。

0.6B 那份更小、更快,音色保真度略低;要用就把文件名换成 0.6B 的对应文件。

## 第 3 步:参考音频与声线特征

TTS 会照一段参考音频克隆音色与语调。准备一段 **24 kHz 单声道**的干净人声(3–10 秒):

```
<voices-dir>\corhi.wav     参考音频
<voices-dir>\corhi.txt     它的逐字转写(与 wav 同名)
```

转写不是可选的:带上它才是 ICL 克隆,音色与语调都跟着参考走;没有它只能退到纯克隆,
保真度明显下降。

参考音频是 32 kHz 或立体声就先用 ffmpeg 转:

```powershell
ffmpeg -i <原音频> -ar 24000 -ac 1 <voices-dir>\corhi.wav
```

再抽特征(NVMe 上约 3 秒):

```powershell
$env:PATH = "<CUDA 的 bin>;$env:PATH"
cd <voices-dir>
E:\Programs\qwentts.cpp\build\qwen-codec.exe `
  --model <gguf>\qwen-tokenizer-12hz-Q8_0.gguf `
  --talker <gguf>\qwen-talker-1.7b-base-Q8_0.gguf `
  -i corhi.wav
```

产出 `corhi-24k.spk` 与 `corhi-24k.rvq`。装的时候安装器会找这两个文件,先找声线库、
再找运行时目录,也可以用 `--spk` / `--rvq` 直接指路径。

## 第 4 步:安装本仓库

```powershell
git clone <本仓库地址> E:\Programs\cortico-tts-qwen3
cd E:\Programs\cortico-tts-qwen3
node scripts/install.mjs `
  --runtime    E:\Cortico-Data\runtimes\qwen3-tts `
  --server-exe E:\Programs\qwentts.cpp\build\tts-server.exe `
  --talker     E:\Cortico-Data\models\qwen3-tts\gguf\qwen-talker-1.7b-base-Q8_0.gguf `
  --codec      E:\Cortico-Data\models\qwen3-tts\gguf\qwen-tokenizer-12hz-Q8_0.gguf `
  --voices-dir E:\Cortico-Data\models\vtuber\voices `
  --cuda-bin   "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8\bin" `
  --voice corhi
```

`--vcvars` 若和你的 VS 安装位置不同要一并指对(`--help` 看全部选项)。

安装器做四件事:编译 `src/launcher/llama-tts-server.c`、把启动器与 `src/proxy.mjs`
铺进运行时目录、写 `launcher.ini`、然后起一次冒烟 —— 拉起来打 `/health`、合成一句、
报出耗时与音频时长,最后收掉。冒烟失败会把启动器的输出打出来,并给你非零退出码。

装完的运行时目录长这样,它就是 `worlds.vtuber.ttsRuntimeDir` 要指的地方:

```
E:\Cortico-Data\runtimes\qwen3-tts\
  llama-tts-server.exe    启动器(扩展认的文件名)
  launcher.ini            配置,唯一事实来源
  proxy.mjs               代理
  corhi-24k.spk           声线特征
  corhi-24k.rvq
```

## 第 5 步:配置 Cortico

三个键,改完**重启 World** 才生效:

| 键 | 值 |
|---|---|
| `worlds.vtuber.ttsRuntimeDir` | 上面那个运行时目录 |
| `worlds.vtuber.ttsUrl` | `http://127.0.0.1:8010`(代理端口) |
| `worlds.vtuber.streamEnabled` | `true` |

`ttsUrl` 的**端口**就是代理要监听的端口。启动器会读扩展传进来的 `--port`,以它为准,
所以这两处不会对不上;`launcher.ini` 里的 `proxy_port` 只是手工起代理时的默认值。

写好之后从头启动 bot(或重启 vtuber World),然后在控制台的「声线档案」页点启动 ——
那个按钮现在拉起的是整套新后端(启动器 + 上游 + 代理)。

## 验证

```powershell
# 上游就绪
curl.exe http://127.0.0.1:8080/health
# 代理就绪(它转发上游的 health)
curl.exe http://127.0.0.1:8010/health
# 声线已注册
curl.exe http://127.0.0.1:8080/v1/audio/voices
```

然后在控制台「声线档案」页点试听。真实演出里,运行日志的 `TTS` 区域会出现

```
流式收流 2777ms → 10880ms 音频
```

左边是墙钟、右边是音频时长。右边的数字比左边大 3 倍左右是正常的;左边追平或反超说明
这台机器扛不住,把 `streamEnabled` 关掉退回整段合成。

## 排错

| 现象 | 原因 |
|---|---|
| 面板报「加载超时」 | 上游起不来。看运行日志 `server` 区域,通常是权重路径写错或 CUDA DLL 不在 PATH 上 |
| 合成 502 `上游不可达` | 代理活着但上游退了。上游进程的 stderr 会进运行日志 |
| 合成 400 `input is empty` | 正常:扩展每 30 秒用空 body 探一次流式路由,代理就地回 400 表示「路由在」 |
| 面板说端口被占 | 8010 上还有别的进程(比如旧的 VoxCPM2 server)。停掉它再启动 |
| 声音是别人的 / 不像参考 | `.spk`/`.rvq` 与 `corhi.wav` 不配对,或 `corhi.txt` 缺失导致退到纯克隆 |
| 启动器报 `launcher.ini 缺 <键>` | 配置少了必填项。重跑安装器 |
| `spawn UNKNOWN` | Windows 智能应用控制拦下了未签名的 exe |

上游崩过一次并留下 `GGML_ASSERT ... pool_used` 之类:CUDA 后端的已知脆弱点,连续快速
发合成请求时概率升高。重启服务即可,演出不受影响。

## 已知限制

- **`cfg_value` / `inference_timesteps` / `max_steps` 无效。** 它们是 VoxCPM2 专有字段,
  代理会丢掉。面板上这三个旋钮在这个后端上不起作用。`seed` 与 `temperature` 照常透传。
- **没有强制对齐。** 这个后端不带对齐模型,`/v1/audio/align` 固定回 501,扩展把片内
  `<>` 动作的时间退回按字符比例估计。要精确落点得另挂
  [Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B),
  而承载它的 `llama-tts-server`(Phantivia 的 llama.cpp-omni fork)不肯在缺 VoxCPM2 权重的
  情况下启动,代价不小。
- **Q8_0 是这套配置的取舍点。** 更高精度更稳但更占显存。上游自己的调优开关走
  `launcher.ini` 的 `extra_args`(安装时用 `--extra-args`),原样追加到上游命令行,
  例如 `--max-batch 2`、`--clamp-fp16`、`--no-fa`;能不能用取决于你的上游版本。
