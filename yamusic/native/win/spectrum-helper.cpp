// Помощник волны для Windows: захватывает звук приложения (WASAPI process loopback,
// Windows 10 20348+ / Windows 11), раскладывает на частоты и ~30 раз в секунду пишет
// в stdout строку JSON — тот же протокол, что у macOS-помощника:
//   {"bands":[0..100, ...]}   — уровни полос от низких к высоким
//   {"status":"waiting"}      — приложение не запущено или на паузе (пишется при смене)
// Где process loopback нет, захватывает весь звук устройства вывода (loopback) — волна
// тогда реагирует на любой звук, о чём сообщает в stderr.
// Аргументы: [имя exe приложения] [число полос]. Плагин просто завершает процесс, когда волна не нужна.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <shellapi.h>
#include <tlhelp32.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <complex>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// MARK: - Параметры активации process loopback (audioclientactivationparams.h, нет в mingw)

struct ProcessLoopbackParams {
    DWORD targetProcessId;
    int mode; // 0 — включая дерево процессов цели
};

struct ActivationParams {
    int activationType; // 1 — process loopback
    ProcessLoopbackParams loopback;
};

using ActivateFn = HRESULT(WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*,
                                    IActivateAudioInterfaceAsyncOperation**);

static const IID IID_IAgileObject_ = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

/** Ждёт завершения ActivateAudioInterfaceAsync (вызывается из MTA-потока системы). */
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    ~ActivationHandler() { CloseHandle(done); }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
            riid == IID_IAgileObject_) {
            *out = this;
            AddRef();
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { return --refs; } // живёт на стеке
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation*) override {
        SetEvent(done);
        return S_OK;
    }

private:
    std::atomic<ULONG> refs{1};
};

// MARK: - Вывод

static std::mutex outLock;
static std::string lastStatus;

static void emitLine(const std::string& line) {
    std::lock_guard<std::mutex> guard(outLock);
    fwrite(line.data(), 1, line.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void status(const std::string& value) {
    if (value == lastStatus) return;
    lastStatus = value;
    emitLine("{\"status\":\"" + value + "\"}");
}

static void warn(const char* text) {
    fprintf(stderr, "%s\n", text);
    fflush(stderr);
}

// MARK: - Звук: последние сэмплы (моно)

constexpr int kFftSize = 2048;

class SampleRing {
public:
    void write(const float* mono, size_t frames) {
        std::lock_guard<std::mutex> guard(lock);
        for (size_t i = 0; i < frames; i++) {
            buffer[index] = mono[i];
            index = (index + 1) % kFftSize;
        }
        lastWrite = GetTickCount64();
    }
    std::vector<float> snapshot() {
        std::lock_guard<std::mutex> guard(lock);
        std::vector<float> out(kFftSize);
        for (int i = 0; i < kFftSize; i++) out[i] = buffer[(index + i) % kFftSize];
        return out;
    }
    ULONGLONG lastWriteTick() {
        std::lock_guard<std::mutex> guard(lock);
        return lastWrite;
    }

private:
    std::mutex lock;
    float buffer[kFftSize] = {};
    int index = 0;
    ULONGLONG lastWrite = 0;
};

static SampleRing ring;
static std::atomic<double> sampleRate{48000};

// MARK: - Поиск процесса

static std::wstring lower(std::wstring s) {
    CharLowerBuffW(s.data(), static_cast<DWORD>(s.size()));
    return s;
}

/** Корневой процесс приложения: exe совпадает, а родитель — другой процесс. 0 — не запущено. */
static DWORD findRootProcess(const std::wstring& exe) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    std::vector<std::pair<DWORD, DWORD>> matches; // pid, parent
    PROCESSENTRY32W entry{sizeof(entry)};
    const std::wstring target = lower(exe);
    for (BOOL ok = Process32FirstW(snapshot, &entry); ok; ok = Process32NextW(snapshot, &entry)) {
        if (lower(entry.szExeFile) == target) matches.emplace_back(entry.th32ProcessID, entry.th32ParentProcessID);
    }
    CloseHandle(snapshot);
    for (const auto& match : matches) {
        const DWORD parent = match.second;
        bool parentMatches = std::any_of(matches.begin(), matches.end(), [&](const auto& m) { return m.first == parent; });
        if (!parentMatches) return match.first;
    }
    return matches.empty() ? 0 : matches.front().first;
}

// MARK: - Захват

/** Переводит пакет WASAPI в моно float. */
static void toMono(const BYTE* data, UINT32 frames, const WAVEFORMATEX* fmt, std::vector<float>& out) {
    out.assign(frames, 0.0f);
    if (!data) return; // AUDCLNT_BUFFERFLAGS_SILENT
    const int channels = std::max<int>(1, fmt->nChannels);
    bool isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
        static const GUID kFloat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
        isFloat = IsEqualGUID(ext->SubFormat, kFloat);
    }
    for (UINT32 f = 0; f < frames; f++) {
        float sum = 0;
        for (int c = 0; c < channels; c++) {
            if (isFloat && fmt->wBitsPerSample == 32) sum += reinterpret_cast<const float*>(data)[f * channels + c];
            else if (fmt->wBitsPerSample == 16) sum += reinterpret_cast<const int16_t*>(data)[f * channels + c] / 32768.0f;
            else if (fmt->wBitsPerSample == 32) sum += reinterpret_cast<const int32_t*>(data)[f * channels + c] / 2147483648.0f;
        }
        out[f] = sum / channels;
    }
}

/** IAudioClient для process loopback приложения pid; nullptr — API недоступен. */
static IAudioClient* activateProcessLoopback(DWORD pid) {
    static ActivateFn activate = [] {
        HMODULE dll = LoadLibraryW(L"mmdevapi.dll");
        return dll ? reinterpret_cast<ActivateFn>(GetProcAddress(dll, "ActivateAudioInterfaceAsync")) : nullptr;
    }();
    if (!activate) return nullptr;

    ActivationParams params{1, {pid, 0}};
    PROPVARIANT prop{};
    prop.vt = VT_BLOB;
    prop.blob.cbSize = sizeof(params);
    prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ActivationHandler handler;
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    if (FAILED(activate(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &prop, &handler, &op))) return nullptr;
    WaitForSingleObject(handler.done, 5000);
    HRESULT result = E_FAIL;
    IUnknown* unknown = nullptr;
    op->GetActivateResult(&result, &unknown);
    op->Release();
    if (FAILED(result) || !unknown) return nullptr;
    IAudioClient* client = nullptr;
    unknown->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client));
    unknown->Release();
    return client;
}

/** IAudioClient устройства вывода по умолчанию (для loopback всего звука). */
static IAudioClient* activateSystemLoopback() {
    IMMDeviceEnumerator* enumerator = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                reinterpret_cast<void**>(&enumerator)))) return nullptr;
    IMMDevice* device = nullptr;
    IAudioClient* client = nullptr;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) {
        device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&client));
        device->Release();
    }
    enumerator->Release();
    return client;
}

/** Поток захвата: работает, пока running; пишет сэмплы в ring. */
static void captureThread(DWORD pid, std::atomic<bool>* running) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    static bool warned = false;

    WAVEFORMATEX pcm{WAVE_FORMAT_PCM, 2, 44100, 44100 * 4, 4, 16, 0};
    WAVEFORMATEX* format = &pcm;
    WAVEFORMATEX* mixFormat = nullptr;
    DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;

    IAudioClient* client = activateProcessLoopback(pid);
    if (client) {
        flags |= AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
    } else {
        if (!warned) warn("process loopback unavailable, capturing all system audio");
        warned = true;
        client = activateSystemLoopback();
        if (client && SUCCEEDED(client->GetMixFormat(&mixFormat))) format = mixFormat;
    }

    HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    IAudioCaptureClient* capture = nullptr;
    bool ok = client && SUCCEEDED(client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, format, nullptr)) &&
              SUCCEEDED(client->SetEventHandle(event)) &&
              SUCCEEDED(client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture))) &&
              SUCCEEDED(client->Start());
    if (!ok) warn("audio capture failed to start");
    sampleRate = format->nSamplesPerSec;

    std::vector<float> mono;
    while (ok && *running) {
        WaitForSingleObject(event, 200);
        UINT32 packet = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD bufferFlags = 0;
            if (FAILED(capture->GetBuffer(&data, &frames, &bufferFlags, nullptr, nullptr))) break;
            toMono((bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) ? nullptr : data, frames, format, mono);
            capture->ReleaseBuffer(frames);
            ring.write(mono.data(), mono.size());
        }
    }

    if (client) client->Stop();
    if (capture) capture->Release();
    if (client) client->Release();
    if (mixFormat) CoTaskMemFree(mixFormat);
    CloseHandle(event);
    CoUninitialize();
}

// MARK: - Спектр

static void fft(std::vector<std::complex<float>>& a) {
    const size_t n = a.size();
    for (size_t i = 1, j = 0; i < n; i++) {
        size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(a[i], a[j]);
    }
    for (size_t len = 2; len <= n; len <<= 1) {
        const float angle = -2.0f * 3.14159265f / len;
        const std::complex<float> step(std::cos(angle), std::sin(angle));
        for (size_t i = 0; i < n; i += len) {
            std::complex<float> w(1);
            for (size_t k = 0; k < len / 2; k++) {
                auto u = a[i + k], v = a[i + k + len / 2] * w;
                a[i + k] = u + v;
                a[i + k + len / 2] = u - v;
                w *= step;
            }
        }
    }
}

/** Уровни полос 0…100 — та же шкала, что у macOS-помощника (окно Ханна vDSP_HANN_NORM, -75…-15 дБ). */
static std::vector<int> bands(const std::vector<float>& samples, int count, double rate) {
    static std::vector<float> window = [] {
        std::vector<float> w(kFftSize);
        for (int i = 0; i < kFftSize; i++) w[i] = 0.8165f * (1.0f - std::cos(2.0f * 3.14159265f * i / kFftSize));
        return w;
    }();
    std::vector<std::complex<float>> data(kFftSize);
    for (int i = 0; i < kFftSize; i++) data[i] = samples[i] * window[i];
    fft(data);

    const int half = kFftSize / 2;
    const double binHz = rate / kFftSize, low = 40.0, high = std::min(16000.0, rate / 2);
    std::vector<int> out(count);
    for (int b = 0; b < count; b++) {
        const double f0 = low * std::pow(high / low, double(b) / count);
        const double f1 = low * std::pow(high / low, double(b + 1) / count);
        const int b0 = std::max(1, int(f0 / binHz)), b1 = std::max(b0 + 1, int(f1 / binHz));
        float peak = 0;
        for (int bin = b0; bin < std::min(b1, half); bin++) peak = std::max(peak, std::abs(data[bin]) * 4.0f / kFftSize);
        const float db = 20.0f * std::log10(std::max(peak, 1e-9f));
        out[b] = int(std::round(std::clamp((db + 75.0f) / 60.0f, 0.0f, 1.0f) * 100));
    }
    return out;
}

// MARK: - Цикл

int wmain() {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    const std::wstring exe = argc > 1 ? argv[1] : L"Яндекс Музыка.exe";
    const int count = argc > 2 ? std::clamp(_wtoi(argv[2]), 4, 64) : 32;

    DWORD pid = 0;
    std::atomic<bool>* running = nullptr;
    std::thread worker;
    auto stop = [&] {
        if (!running) return;
        *running = false;
        worker.join();
        delete running;
        running = nullptr;
    };

    ULONGLONG lastCheck = 0;
    for (;;) {
        const ULONGLONG now = GetTickCount64();
        if (now - lastCheck >= 1000) {
            lastCheck = now;
            const DWORD next = findRootProcess(exe);
            if (next != pid) {
                stop();
                pid = next;
                if (pid) {
                    running = new std::atomic<bool>(true);
                    worker = std::thread(captureThread, pid, running);
                }
            }
        }

        const auto samples = ring.snapshot();
        float peak = 0;
        for (float s : samples) peak = std::max(peak, std::fabs(s));
        if (!pid || now - ring.lastWriteTick() > 500 || peak < 1e-4f) {
            status("waiting");
        } else {
            lastStatus.clear();
            const auto levels = bands(samples, count, sampleRate);
            std::string line = "{\"bands\":[";
            for (size_t i = 0; i < levels.size(); i++) line += (i ? "," : "") + std::to_string(levels[i]);
            emitLine(line + "]}");
        }
        Sleep(33);
    }
}
