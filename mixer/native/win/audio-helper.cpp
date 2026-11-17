// AudioHelper для Windows — долгоживущий процесс-посредник между плагином и WASAPI.
// Протокол тот же, что у macOS-помощника (см. native/mac/main.swift), кроме "render":
// на Windows SVG растеризует сам плагин (plugin/raster.js).
//
//   {"id":1,"cmd":"list"}                                   → {"devices":[...],"apps":[...]}
//   {"id":2,"cmd":"setVolume","uid":"...","scope":"output"|"input","value":0..1}
//   {"id":3,"cmd":"setMute","uid":"...","scope":"...","muted":true}
//   {"id":4,"cmd":"setDefault","uid":"...","scope":"..."}
//   {"id":5,"cmd":"setApp","app":"brave.exe","volume":0..1,"muted":false}
//   События: {"event":"changed","devices":[...]}, {"event":"apps","apps":[...]}
//
// Громкость приложений — штатные аудиосессии Windows (как в «Микшере громкости»):
// уровень применяется ко всем сессиям приложения, в том числе к появившимся позже.
//
// Сборка: scripts/build-win.sh (zig c++, кросс-компиляция с macOS).

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <propvarutil.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wincodec.h>
#include <fcntl.h>
#include <io.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

// MARK: - Утилиты

template <class T>
class ComPtr {
public:
    ComPtr() = default;
    ComPtr(const ComPtr& o) : p(o.p) { if (p) p->AddRef(); }
    ComPtr& operator=(const ComPtr& o) {
        if (o.p) o.p->AddRef();
        if (p) p->Release();
        p = o.p;
        return *this;
    }
    ~ComPtr() { if (p) p->Release(); }
    T** put() { if (p) { p->Release(); p = nullptr; } return &p; }
    void** putVoid() { return reinterpret_cast<void**>(put()); }
    T* get() const { return p; }
    T* operator->() const { return p; }
    explicit operator bool() const { return p != nullptr; }
private:
    T* p = nullptr;
};

static std::string utf8(const wchar_t* s) {
    if (!s) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, nullptr, 0, nullptr, nullptr);
    std::string out(n > 0 ? n - 1 : 0, '\0');
    if (n > 1) WideCharToMultiByte(CP_UTF8, 0, s, -1, out.data(), n, nullptr, nullptr);
    return out;
}

static std::wstring wide(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring out(n > 0 ? n - 1 : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
    return out;
}

static std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
    return s;
}

static std::string base64(const unsigned char* data, size_t size) {
    static const char* abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((size + 2) / 3 * 4);
    for (size_t i = 0; i < size; i += 3) {
        unsigned v = data[i] << 16 | (i + 1 < size ? data[i + 1] << 8 : 0) | (i + 2 < size ? data[i + 2] : 0);
        out += abc[v >> 18 & 63];
        out += abc[v >> 12 & 63];
        out += i + 1 < size ? abc[v >> 6 & 63] : '=';
        out += i + 2 < size ? abc[v & 63] : '=';
    }
    return out;
}

// MARK: - Минимальный JSON
// Запросы плагина — плоские объекты со строками, числами и bool, этого достаточно.

struct JValue {
    enum Type { Null, Bool, Number, String } type = Null;
    bool b = false;
    double n = 0;
    std::string s;
};
using JObject = std::map<std::string, JValue>;

static void skipSpace(const std::string& t, size_t& i) {
    while (i < t.size() && isspace(static_cast<unsigned char>(t[i]))) i++;
}

static bool parseString(const std::string& t, size_t& i, std::string& out) {
    if (t[i] != '"') return false;
    for (i++; i < t.size(); i++) {
        char c = t[i];
        if (c == '"') { i++; return true; }
        if (c != '\\') { out += c; continue; }
        if (++i >= t.size()) return false;
        switch (t[i]) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'u': {
                if (i + 4 >= t.size()) return false;
                wchar_t w[2] = {static_cast<wchar_t>(std::stoi(t.substr(i + 1, 4), nullptr, 16)), 0};
                out += utf8(w);
                i += 4;
                break;
            }
            default: out += t[i];
        }
    }
    return false;
}

static bool parseObject(const std::string& t, JObject& obj) {
    size_t i = 0;
    skipSpace(t, i);
    if (i >= t.size() || t[i++] != '{') return false;
    while (true) {
        skipSpace(t, i);
        if (i < t.size() && t[i] == '}') return true;
        std::string key;
        if (i >= t.size() || !parseString(t, i, key)) return false;
        skipSpace(t, i);
        if (i >= t.size() || t[i++] != ':') return false;
        skipSpace(t, i);
        JValue v;
        if (t[i] == '"') {
            v.type = JValue::String;
            if (!parseString(t, i, v.s)) return false;
        } else if (t.compare(i, 4, "true") == 0) {
            v.type = JValue::Bool; v.b = true; i += 4;
        } else if (t.compare(i, 5, "false") == 0) {
            v.type = JValue::Bool; i += 5;
        } else if (t.compare(i, 4, "null") == 0) {
            i += 4;
        } else {
            size_t used = 0;
            v.type = JValue::Number;
            v.n = std::stod(t.substr(i), &used);
            i += used;
        }
        obj[key] = v;
        skipSpace(t, i);
        if (i < t.size() && t[i] == ',') { i++; continue; }
        if (i < t.size() && t[i] == '}') return true;
        return false;
    }
}

static std::string jstr(const std::string& s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out + "\"";
}

static std::string jnum(double v) {
    char buf[32];
    snprintf(buf, sizeof buf, "%.4f", v);
    return buf;
}

static std::string jbool(bool v) { return v ? "true" : "false"; }

// MARK: - Вывод

static std::mutex outputMutex;

static void send(const std::string& json) {
    std::lock_guard<std::mutex> lock(outputMutex);
    fwrite(json.data(), 1, json.size(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

// MARK: - IPolicyConfig (недокументированный, но стабильный с Windows 7 —
// через него «Параметры звука» меняют устройство по умолчанию)

static const CLSID CLSID_PolicyConfigClient = {0x870af99c, 0x171d, 0x4f9e, {0xaf, 0x0d, 0xe6, 0x3d, 0xf4, 0x0c, 0x2b, 0xc9}};
static const IID IID_IPolicyConfig = {0xf8679f50, 0x850a, 0x41cf, {0x9c, 0x72, 0x43, 0x0f, 0x29, 0x02, 0x90, 0xc8}};

struct IPolicyConfig : public IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetMixFormat(PCWSTR, WAVEFORMATEX**) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetDeviceFormat(PCWSTR, INT, WAVEFORMATEX**) = 0;
    virtual HRESULT STDMETHODCALLTYPE ResetDeviceFormat(PCWSTR) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetDeviceFormat(PCWSTR, WAVEFORMATEX*, WAVEFORMATEX*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetProcessingPeriod(PCWSTR, INT, PINT64, PINT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetProcessingPeriod(PCWSTR, PINT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetShareMode(PCWSTR, void*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetShareMode(PCWSTR, void*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetPropertyValue(PCWSTR, BOOL, const PROPERTYKEY&, PROPVARIANT*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetPropertyValue(PCWSTR, BOOL, const PROPERTYKEY&, PROPVARIANT*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetDefaultEndpoint(PCWSTR, ERole) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetEndpointVisibility(PCWSTR, INT) = 0;
};

// MARK: - Рабочий поток
// Все обращения к WASAPI идут из одного потока; callback'и COM и чтение stdin
// только ставят задачи в очередь.

static std::mutex workMutex;
static std::condition_variable workCv;
static std::deque<std::string> requests;
static bool notifyRequested = false;
static std::chrono::steady_clock::time_point notifyAt;

static void requestNotify() {
    std::lock_guard<std::mutex> lock(workMutex);
    if (!notifyRequested) {
        notifyRequested = true;
        // Склеиваем пачку уведомлений в одно обновление.
        notifyAt = std::chrono::steady_clock::now() + std::chrono::milliseconds(40);
    }
    workCv.notify_one();
}

static ComPtr<IMMDeviceEnumerator> enumerator;

// MARK: - Callback'и

template <class Interface>
class Callback : public Interface {
public:
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = --refs;
        if (r == 0) delete this;
        return r;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
        if (riid == IID_IUnknown || riid == __uuidof(Interface)) {
            *out = static_cast<Interface*>(this);
            AddRef();
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    virtual ~Callback() = default;
private:
    std::atomic<ULONG> refs{1};
};

class DeviceEvents : public Callback<IMMNotificationClient> {
public:
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { requestNotify(); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { requestNotify(); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { requestNotify(); return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole, LPCWSTR) override { requestNotify(); return S_OK; }
    // Срабатывает очень часто и почти всегда не по делу — игнорируем.
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }
};

class VolumeEvents : public Callback<IAudioEndpointVolumeCallback> {
public:
    HRESULT STDMETHODCALLTYPE OnNotify(PAUDIO_VOLUME_NOTIFICATION_DATA) override { requestNotify(); return S_OK; }
};

// MARK: - Устройства

struct Endpoint {
    ComPtr<IMMDevice> device;
    ComPtr<IAudioEndpointVolume> volume;
    std::string id;
    std::string name;
    bool output = true;
};

static std::string deviceId(IMMDevice* device) {
    LPWSTR id = nullptr;
    if (FAILED(device->GetId(&id))) return "";
    std::string out = utf8(id);
    CoTaskMemFree(id);
    return out;
}

static std::string defaultId(EDataFlow flow) {
    ComPtr<IMMDevice> device;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(flow, eConsole, device.put()))) return "";
    return deviceId(device.get());
}

static std::vector<Endpoint> listEndpoints() {
    std::vector<Endpoint> result;
    for (EDataFlow flow : {eRender, eCapture}) {
        ComPtr<IMMDeviceCollection> collection;
        if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, collection.put()))) continue;
        UINT count = 0;
        collection->GetCount(&count);
        for (UINT i = 0; i < count; i++) {
            Endpoint e;
            if (FAILED(collection->Item(i, e.device.put()))) continue;
            e.id = deviceId(e.device.get());
            e.output = flow == eRender;
            ComPtr<IPropertyStore> props;
            if (SUCCEEDED(e.device->OpenPropertyStore(STGM_READ, props.put()))) {
                PROPVARIANT name;
                PropVariantInit(&name);
                if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &name)) && name.vt == VT_LPWSTR) {
                    e.name = utf8(name.pwszVal);
                }
                PropVariantClear(&name);
            }
            if (e.name.empty()) e.name = e.id;
            e.device->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, e.volume.putVoid());
            result.push_back(e);
        }
    }
    return result;
}

static Endpoint* findEndpoint(std::vector<Endpoint>& endpoints, const std::string& id) {
    for (auto& e : endpoints) if (e.id == id) return &e;
    return nullptr;
}

static std::string deviceSnapshot() {
    auto endpoints = listEndpoints();
    std::string defaultOut = defaultId(eRender), defaultIn = defaultId(eCapture);
    std::string out = "[";
    for (size_t i = 0; i < endpoints.size(); i++) {
        auto& e = endpoints[i];
        float level = 0;
        BOOL muted = FALSE;
        bool hasVolume = e.volume && SUCCEEDED(e.volume->GetMasterVolumeLevelScalar(&level));
        bool hasMute = e.volume && SUCCEEDED(e.volume->GetMute(&muted));
        bool isDefault = e.id == (e.output ? defaultOut : defaultIn);
        if (i) out += ",";
        out += "{\"uid\":" + jstr(e.id) + ",\"name\":" + jstr(e.name) + "," + jstr(e.output ? "output" : "input") +
               ":{\"volume\":" + (hasVolume ? jnum(level) : "null") +
               ",\"muted\":" + (hasMute ? jbool(muted) : "null") +
               ",\"isDefault\":" + jbool(isDefault) + "}}";
    }
    return out + "]";
}

// Подписки на громкость устройств: id → (endpoint volume, callback).
static std::map<std::string, std::pair<ComPtr<IAudioEndpointVolume>, VolumeEvents*>> volumeWatches;

static void watchVolumes() {
    auto endpoints = listEndpoints();
    std::set<std::string> alive;
    for (auto& e : endpoints) {
        alive.insert(e.id);
        if (!e.volume || volumeWatches.count(e.id)) continue;
        auto* cb = new VolumeEvents();
        if (SUCCEEDED(e.volume->RegisterControlChangeNotify(cb))) volumeWatches[e.id] = {e.volume, cb};
        else cb->Release();
    }
    for (auto it = volumeWatches.begin(); it != volumeWatches.end();) {
        if (alive.count(it->first)) { ++it; continue; }
        it->second.first->UnregisterControlChangeNotify(it->second.second);
        it->second.second->Release();
        it = volumeWatches.erase(it);
    }
}

// MARK: - Приложения (аудиосессии)

struct ProcessInfo {
    std::string id;    // имя exe в нижнем регистре: одинаково у всех процессов приложения
    std::string name;  // FileDescription из ресурсов exe
    std::wstring path;
};

struct Session {
    ComPtr<ISimpleAudioVolume> volume;
    std::string appId;
    std::string instance;
    bool playing = false;
};

static std::map<DWORD, ProcessInfo> processCache;
static std::map<std::string, ProcessInfo> appInfo;
static std::map<std::string, std::string> iconCache;
static std::map<std::string, std::pair<float, bool>> levels;  // app → (volume, muted)
static std::set<std::string> leveledSessions;
static std::string lastAppsSignature;

static std::string fileDescription(const std::wstring& path) {
    DWORD handle = 0;
    DWORD size = GetFileVersionInfoSizeW(path.c_str(), &handle);
    if (!size) return "";
    std::vector<unsigned char> data(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return "";
    struct Translation { WORD lang, codepage; } *translations = nullptr;
    UINT len = 0;
    if (!VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&translations), &len) || !len) return "";
    wchar_t key[64];
    swprintf(key, 64, L"\\StringFileInfo\\%04x%04x\\FileDescription", translations[0].lang, translations[0].codepage);
    wchar_t* value = nullptr;
    if (!VerQueryValueW(data.data(), key, reinterpret_cast<void**>(&value), &len) || !len) return "";
    return utf8(value);
}

static bool processInfo(DWORD pid, ProcessInfo& info) {
    auto cached = processCache.find(pid);
    if (cached != processCache.end()) { info = cached->second; return true; }

    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return false;
    wchar_t buffer[MAX_PATH * 2];
    DWORD size = MAX_PATH * 2;
    BOOL ok = QueryFullProcessImageNameW(process, 0, buffer, &size);
    CloseHandle(process);
    if (!ok) return false;

    info.path = buffer;
    std::string exe = utf8(buffer);
    exe = exe.substr(exe.find_last_of("\\/") + 1);
    info.id = lower(exe);
    info.name = fileDescription(info.path);
    if (info.name.empty()) info.name = exe.size() > 4 ? exe.substr(0, exe.size() - 4) : exe;
    processCache[pid] = info;
    return true;
}

/// Иконка exe → PNG base64 через WIC.
static std::string iconPNG(const std::wstring& path) {
    HICON icon = nullptr;
    if (FAILED(SHDefExtractIconW(path.c_str(), 0, 0, &icon, nullptr, MAKELONG(48, 48))) || !icon) return "";

    std::string result;
    ComPtr<IWICImagingFactory> factory;
    ComPtr<IWICBitmap> bitmap;
    ComPtr<IStream> stream;
    ComPtr<IWICBitmapEncoder> encoder;
    ComPtr<IWICBitmapFrameEncode> frame;
    UINT w = 0, h = 0;
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    if (SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_IWICImagingFactory, factory.putVoid())) &&
        SUCCEEDED(factory->CreateBitmapFromHICON(icon, bitmap.put())) &&
        SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, stream.put())) &&
        SUCCEEDED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put())) &&
        SUCCEEDED(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache)) &&
        SUCCEEDED(encoder->CreateNewFrame(frame.put(), nullptr)) &&
        SUCCEEDED(frame->Initialize(nullptr)) &&
        SUCCEEDED(bitmap->GetSize(&w, &h)) &&
        SUCCEEDED(frame->SetSize(w, h)) &&
        SUCCEEDED(frame->SetPixelFormat(&format)) &&
        SUCCEEDED(frame->WriteSource(bitmap.get(), nullptr)) &&
        SUCCEEDED(frame->Commit()) &&
        SUCCEEDED(encoder->Commit())) {
        HGLOBAL global = nullptr;
        STATSTG stat = {};
        if (SUCCEEDED(GetHGlobalFromStream(stream.get(), &global)) && SUCCEEDED(stream->Stat(&stat, STATFLAG_NONAME))) {
            auto* bytes = static_cast<unsigned char*>(GlobalLock(global));
            if (bytes) {
                result = base64(bytes, static_cast<size_t>(stat.cbSize.QuadPart));
                GlobalUnlock(global);
            }
        }
    }
    DestroyIcon(icon);
    return result;
}

static std::vector<Session> listSessions() {
    std::vector<Session> result;
    ComPtr<IMMDeviceCollection> collection;
    if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, collection.put()))) return result;
    UINT count = 0;
    collection->GetCount(&count);
    for (UINT d = 0; d < count; d++) {
        ComPtr<IMMDevice> device;
        ComPtr<IAudioSessionManager2> manager;
        ComPtr<IAudioSessionEnumerator> sessions;
        if (FAILED(collection->Item(d, device.put())) ||
            FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, manager.putVoid())) ||
            FAILED(manager->GetSessionEnumerator(sessions.put()))) continue;
        int n = 0;
        sessions->GetCount(&n);
        for (int i = 0; i < n; i++) {
            ComPtr<IAudioSessionControl> control;
            ComPtr<IAudioSessionControl2> control2;
            if (FAILED(sessions->GetSession(i, control.put())) ||
                FAILED(control->QueryInterface(__uuidof(IAudioSessionControl2), control2.putVoid()))) continue;

            AudioSessionState state;
            if (FAILED(control->GetState(&state)) || state == AudioSessionStateExpired) continue;

            Session s;
            s.playing = state == AudioSessionStateActive;
            if (control2->IsSystemSoundsSession() == S_OK) {
                s.appId = "system";
                appInfo[s.appId] = {"system", "Системные звуки", L""};
            } else {
                DWORD pid = 0;
                ProcessInfo info;
                if (FAILED(control2->GetProcessId(&pid)) || !pid || !processInfo(pid, info)) continue;
                s.appId = info.id;
                appInfo[s.appId] = info;
            }
            LPWSTR instance = nullptr;
            if (SUCCEEDED(control2->GetSessionInstanceIdentifier(&instance))) {
                s.instance = utf8(instance);
                CoTaskMemFree(instance);
            }
            control->QueryInterface(__uuidof(ISimpleAudioVolume), s.volume.putVoid());
            result.push_back(s);
        }
    }
    return result;
}

static void applyLevel(Session& s) {
    auto level = levels.find(s.appId);
    if (level == levels.end() || !s.volume) return;
    s.volume->SetMasterVolume(level->second.first, nullptr);
    s.volume->SetMute(level->second.second, nullptr);
}

static std::string appsSnapshot(const std::vector<Session>& sessions) {
    std::map<std::string, bool> playing;
    for (auto& s : sessions) playing[s.appId] = playing[s.appId] || s.playing;
    std::string out = "[";
    bool first = true;
    for (auto& [id, isPlaying] : playing) {
        auto& info = appInfo[id];
        if (!iconCache.count(id)) iconCache[id] = info.path.empty() ? "" : iconPNG(info.path);
        if (!first) out += ",";
        first = false;
        out += "{\"id\":" + jstr(id) + ",\"name\":" + jstr(info.name) + ",\"playing\":" + jbool(isPlaying) +
               ",\"icon\":" + (iconCache[id].empty() ? "null" : jstr(iconCache[id])) + "}";
    }
    return out + "]";
}

/// Раз в секунду: применяем уровни к новым сессиям и сообщаем, если поменялся список приложений.
static void pollApps() {
    auto sessions = listSessions();
    for (auto& s : sessions) {
        if (levels.count(s.appId) && leveledSessions.insert(s.instance).second) applyLevel(s);
    }
    std::string signature;
    for (auto& s : sessions) signature += s.appId + (s.playing ? "+" : "-") + ",";
    if (signature != lastAppsSignature) {
        lastAppsSignature = signature;
        send("{\"event\":\"apps\",\"apps\":" + appsSnapshot(sessions) + "}");
    }
}

// MARK: - Команды

static std::string field(const JObject& o, const char* key) {
    auto it = o.find(key);
    return it != o.end() && it->second.type == JValue::String ? it->second.s : "";
}

static std::string error(const std::string& message) {
    return "\"ok\":false,\"error\":" + jstr(message);
}

static std::string handle(const JObject& request) {
    std::string cmd = field(request, "cmd");

    if (cmd == "list") {
        return "\"ok\":true,\"devices\":" + deviceSnapshot() + ",\"apps\":" + appsSnapshot(listSessions());
    }

    if (cmd == "setApp") {
        std::string app = field(request, "app");
        auto volume = request.find("volume");
        if (app.empty() || volume == request.end() || volume->second.type != JValue::Number) return error("no app/volume");
        auto muted = request.find("muted");
        float value = static_cast<float>(std::min(std::max(volume->second.n, 0.0), 1.0));
        levels[app] = {value, muted != request.end() && muted->second.b};
        for (auto& s : listSessions()) {
            if (s.appId != app) continue;
            leveledSessions.insert(s.instance);
            applyLevel(s);
        }
        return "\"ok\":true";
    }

    if (cmd == "render") return error("render is done by the plugin on Windows");

    auto endpoints = listEndpoints();
    Endpoint* e = findEndpoint(endpoints, field(request, "uid"));
    if (!e) return error("device not found");

    if (cmd == "setVolume") {
        auto v = request.find("value");
        if (v == request.end() || v->second.type != JValue::Number || !e->volume) return error("no value");
        float value = static_cast<float>(std::min(std::max(v->second.n, 0.0), 1.0));
        return SUCCEEDED(e->volume->SetMasterVolumeLevelScalar(value, nullptr)) ? "\"ok\":true" : error("setVolume failed");
    }
    if (cmd == "setMute") {
        auto v = request.find("muted");
        if (v == request.end() || v->second.type != JValue::Bool || !e->volume) return error("no muted");
        return SUCCEEDED(e->volume->SetMute(v->second.b, nullptr)) ? "\"ok\":true" : error("setMute failed");
    }
    if (cmd == "setDefault") {
        ComPtr<IPolicyConfig> policy;
        if (FAILED(CoCreateInstance(CLSID_PolicyConfigClient, nullptr, CLSCTX_ALL, IID_IPolicyConfig, policy.putVoid()))) {
            return error("IPolicyConfig unavailable");
        }
        std::wstring id = wide(e->id);
        bool ok = true;
        for (ERole role : {eConsole, eMultimedia, eCommunications}) {
            ok = SUCCEEDED(policy->SetDefaultEndpoint(id.c_str(), role)) && ok;
        }
        return ok ? "\"ok\":true" : error("setDefault failed");
    }
    return error("unknown cmd " + cmd);
}

static void process(const std::string& line) {
    JObject request;
    if (!parseObject(line, request)) return;
    auto id = request.find("id");
    std::string idJson = id != request.end() && id->second.type == JValue::Number ? jnum(id->second.n) : "null";
    send("{\"id\":" + idJson + "," + handle(request) + "}");
}

// MARK: - main

int main() {
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stdin), _O_BINARY);

    std::thread([] {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            std::lock_guard<std::mutex> lock(workMutex);
            requests.push_back(line);
            workCv.notify_one();
        }
        // stdin закрыт — плагин завершился.
        ExitProcess(0);
    }).detach();

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                enumerator.putVoid()))) {
        fprintf(stderr, "MMDeviceEnumerator unavailable\n");
        return 1;
    }
    auto* deviceEvents = new DeviceEvents();
    enumerator->RegisterEndpointNotificationCallback(deviceEvents);
    watchVolumes();

    auto nextPoll = std::chrono::steady_clock::now();
    while (true) {
        std::deque<std::string> batch;
        bool notify = false;
        {
            std::unique_lock<std::mutex> lock(workMutex);
            auto deadline = notifyRequested ? std::min(notifyAt, nextPoll) : nextPoll;
            workCv.wait_until(lock, deadline, [] { return !requests.empty(); });
            batch.swap(requests);
            if (notifyRequested && std::chrono::steady_clock::now() >= notifyAt) {
                notifyRequested = false;
                notify = true;
            }
        }
        for (auto& line : batch) process(line);
        if (notify) {
            watchVolumes();
            send("{\"event\":\"changed\",\"devices\":" + deviceSnapshot() + "}");
        }
        if (std::chrono::steady_clock::now() >= nextPoll) {
            pollApps();
            nextPoll = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        }
    }
}
