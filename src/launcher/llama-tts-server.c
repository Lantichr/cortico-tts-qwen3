/*
 * llama-tts-server.exe 的同名替身。
 *
 * Cortico 的 vtuber 扩展按固定文件名从 worlds.vtuber.ttsRuntimeDir 拉起 TTS 服务,端口取自
 * worlds.vtuber.ttsUrl。这个后端是两个进程(qwentts 的 tts-server + proxy.mjs),本程序把
 * 它们合到扩展认的那一个入口上;扩展传进来的 VoxCPM2 参数一律忽略,配置来自同目录的
 * launcher.ini。
 *
 * 两个子进程挂进同一个 Job Object 并设 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE:Windows 上扩展
 * 停止服务走的是 proc.kill(),只作用于本进程,靠 job 才能把子孙一起带走。
 *
 * 子进程的 stderr 都接到本进程上,扩展逐行读它并登记到运行日志的 server 区域。
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define INI_MAX 32

typedef struct {
    wchar_t key[64];
    wchar_t val[1024];
} IniEntry;

static IniEntry g_ini[INI_MAX];
static int      g_ini_n = 0;

static void trim(wchar_t *s) {
    wchar_t *p = s;
    while (*p == L' ' || *p == L'\t' || *p == L'\r' || *p == L'\n') p++;
    if (p != s) memmove(s, p, (wcslen(p) + 1) * sizeof(wchar_t));
    size_t n = wcslen(s);
    while (n > 0 && (s[n - 1] == L' ' || s[n - 1] == L'\t' || s[n - 1] == L'\r' || s[n - 1] == L'\n')) s[--n] = L'\0';
}

/* 配置文件按 UTF-8 读:部署路径常含中文,系统代码页解不了。 */
static BOOL read_file_utf8(const wchar_t *path, wchar_t *out, DWORD cap) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return FALSE;
    char  raw[65536];
    DWORD got = 0;
    BOOL  ok  = ReadFile(h, raw, sizeof(raw) - 1, &got, NULL);
    CloseHandle(h);
    if (!ok || got == 0) return FALSE;
    raw[got] = '\0';
    const char *p = raw;
    if (got >= 3 && (unsigned char) p[0] == 0xEF && (unsigned char) p[1] == 0xBB && (unsigned char) p[2] == 0xBF) p += 3;
    return MultiByteToWideChar(CP_UTF8, 0, p, -1, out, (int) cap) > 0;
}

static void ini_load(const wchar_t *path) {
    wchar_t buf[32768];
    if (!read_file_utf8(path, buf, 32768)) return;
    for (wchar_t *line = buf; *line && g_ini_n < INI_MAX;) {
        wchar_t *nl = wcschr(line, L'\n');
        if (nl) *nl = L'\0';
        trim(line);
        if (*line && *line != L'#' && *line != L';') {
            wchar_t *eq = wcschr(line, L'=');
            if (eq) {
                *eq = L'\0';
                trim(line);
                wchar_t *val = eq + 1;
                trim(val);
                lstrcpynW(g_ini[g_ini_n].key, line, 64);
                lstrcpynW(g_ini[g_ini_n].val, val, 1024);
                g_ini_n++;
            }
        }
        if (!nl) break;
        line = nl + 1;
    }
}

static const wchar_t *ini_get(const wchar_t *key, const wchar_t *fallback) {
    for (int i = 0; i < g_ini_n; i++) {
        if (_wcsicmp(g_ini[i].key, key) == 0 && g_ini[i].val[0]) return g_ini[i].val;
    }
    return fallback;
}

static BOOL require(const wchar_t *key, wchar_t *out, DWORD cap) {
    const wchar_t *v = ini_get(key, NULL);
    if (!v) {
        fwprintf(stderr, L"[launcher] launcher.ini 缺 %s\n", key);
        return FALSE;
    }
    lstrcpynW(out, v, cap);
    return TRUE;
}

/* 子进程的 stderr 接到本体上:扩展逐行读它,登记到运行日志的 server 区域。 */
static BOOL start_child(const wchar_t *cmdline, const wchar_t *cwd, HANDLE job, PROCESS_INFORMATION *pi) {
    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_ERROR_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    ZeroMemory(pi, sizeof(*pi));
    if (!CreateProcessW(NULL, (LPWSTR) cmdline, NULL, NULL, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, NULL, cwd, &si,
                        pi)) {
        fwprintf(stderr, L"[launcher] 启动失败 err=%lu: %s\n", GetLastError(), cmdline);
        return FALSE;
    }
    /* 先入 job 再放行:否则子进程可能在入 job 前就生出自己的子孙,漏在 job 外 */
    if (!AssignProcessToJobObject(job, pi->hProcess)) {
        fwprintf(stderr, L"[launcher] 加入 job 失败 err=%lu\n", GetLastError());
    }
    ResumeThread(pi->hThread);
    return TRUE;
}

int wmain(int argc, wchar_t **argv) {
    wchar_t self[MAX_PATH], home[MAX_PATH], ini[MAX_PATH];
    if (!GetModuleFileNameW(NULL, self, MAX_PATH)) {
        fwprintf(stderr, L"[launcher] 取不到自身路径 err=%lu\n", GetLastError());
        return 1;
    }
    lstrcpynW(home, self, MAX_PATH);
    wchar_t *slash = wcsrchr(home, L'\\');
    if (slash) *slash = L'\0';
    swprintf_s(ini, MAX_PATH, L"%s\\launcher.ini", home);
    ini_load(ini);
    if (g_ini_n == 0) {
        fwprintf(stderr, L"[launcher] 读不到或读空了 %s\n", ini);
        return 1;
    }

    wchar_t server[MAX_PATH], model[MAX_PATH], codec[MAX_PATH], node[MAX_PATH], proxy[MAX_PATH], cuda[MAX_PATH],
        voices[MAX_PATH], voice[128], lang[64], alias[128];
    if (!require(L"server_exe", server, MAX_PATH) || !require(L"model", model, MAX_PATH) ||
        !require(L"codec", codec, MAX_PATH) || !require(L"node", node, MAX_PATH) || !require(L"proxy", proxy, MAX_PATH) ||
        !require(L"voice", voice, 128)) {
        return 1;
    }
    lstrcpynW(cuda, ini_get(L"cuda_bin", L""), MAX_PATH);
    lstrcpynW(voices, ini_get(L"voices_dir", L""), MAX_PATH);
    lstrcpynW(lang, ini_get(L"language", L"Chinese"), 64);
    lstrcpynW(alias, ini_get(L"alias", L"qwen3-tts-base"), 128);
    const wchar_t *tts_port = ini_get(L"tts_port", L"8080");
    /* 扩展会把它认为的服务端口传进来(取自 worlds.vtuber.ttsUrl)。以它为准,省得
       代理端口和 ttsUrl 各写一处、对不上时表现为「连不上」。 */
    const wchar_t *proxy_port = ini_get(L"proxy_port", L"8010");
    for (int i = 1; i < argc - 1; i++) {
        if (wcscmp(argv[i], L"--port") == 0 && argv[i + 1][0]) proxy_port = argv[i + 1];
    }

    /* ggml-cuda 要 cudart / cublas,它们通常不在系统 PATH 上 */
    wchar_t path[32768], oldpath[32768];
    DWORD n = GetEnvironmentVariableW(L"PATH", oldpath, 32768);
    if (n == 0 || n >= 32768) oldpath[0] = L'\0';
    if (cuda[0]) swprintf_s(path, 32768, L"%s;%s;%s", cuda, home, oldpath);
    else swprintf_s(path, 32768, L"%s;%s", home, oldpath);
    SetEnvironmentVariableW(L"PATH", path);

    /* 代理从环境变量取配置:一个 ini 是唯一的事实来源 */
    wchar_t buf[1024];
    swprintf_s(buf, 1024, L"http://127.0.0.1:%s", tts_port);
    SetEnvironmentVariableW(L"QWEN_TTS_URL", buf);
    SetEnvironmentVariableW(L"QWEN_TTS_PROXY_PORT", proxy_port);
    SetEnvironmentVariableW(L"QWEN_TTS_LANG", lang);
    SetEnvironmentVariableW(L"QWEN_TTS_VOICE", voice);
    if (voices[0]) SetEnvironmentVariableW(L"QWEN_TTS_VOICES_DIR", voices);

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) {
        fwprintf(stderr, L"[launcher] 建 job 失败 err=%lu\n", GetLastError());
        return 1;
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION li;
    ZeroMemory(&li, sizeof(li));
    li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof(li));

    wchar_t cmd[32768];
    fwprintf(stderr, L"[launcher] 上游 %s\n", server);
    /* extra_args 原样追加:上游的调优开关(--clamp-fp16 / --max-batch / --no-fa 等)不必改本程序 */
    const wchar_t *extra = ini_get(L"extra_args", L"");
    swprintf_s(cmd, 32768,
               L"\"%s\" --model \"%s\" --codec \"%s\" --alias %s --host 127.0.0.1 --port %s --lang %s%s%s", server,
               model, codec, alias, tts_port, lang, extra[0] ? L" " : L"", extra);
    PROCESS_INFORMATION tts;
    if (!start_child(cmd, home, job, &tts)) return 1;

    /* 上游加载权重期间代理已经在听,请求会在自己那侧等到上游就绪 */
    swprintf_s(cmd, 32768, L"\"%s\" \"%s\"", node, proxy);
    PROCESS_INFORMATION proxy_pi;
    if (!start_child(cmd, home, job, &proxy_pi)) {
        TerminateJobObject(job, 1);
        return 1;
    }

    HANDLE both[2] = {tts.hProcess, proxy_pi.hProcess};
    DWORD  which   = WaitForMultipleObjects(2, both, FALSE, INFINITE);
    fwprintf(stderr, L"[launcher] %s 退出,收掉整套\n", which == WAIT_OBJECT_0 ? L"tts-server" : L"proxy");
    TerminateJobObject(job, 0);
    return 0;
}
