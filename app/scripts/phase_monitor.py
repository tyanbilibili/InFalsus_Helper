# -*- coding: utf-8 -*-
"""Read-only In Falsus phase monitor.

The layout follows the IL2CPP ownership stack observation used by the reference
launcher. Nothing is written, injected, or executed in the game. Known builds
use fixed verified offsets; other builds are resolved by read-only type-signature
search and still fail closed if the expected ownership layout is not found.
"""

VERSION = "1.1.0"
# 实机验证过阶段识别的游戏 build；游戏更新后这里要同步改。
VERIFIED_GAME_BUILD = "26126718"

import ctypes
import hashlib
import json
import os
import struct
import sys
import time
from ctypes import wintypes

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

GAME_EXE = "infalsus.exe"
ASSEMBLY = "GameAssembly.dll"
BINARY_HASH = os.environ.get(
    "INFALSUS_PHASE_BINARY_HASH",
    "c2198827bfda45d23241535a3b69d8e98368399fb3afce418a38292ba893cb9e"
).lower()
METADATA_HASH = os.environ.get(
    "INFALSUS_PHASE_METADATA_HASH",
    "b1528b5e5077d0fb3995417c34bfb96ec252e88a77a4626af61878c86cc13741"
).lower()
INPUT_CLASS_RVA = 52152728
CORE_CLASS_RVA = 51979432
KNOWN_LAYOUTS = {
    (
        "375f3a8db0e5df69b78a74e0518b98d83214eb7e5bcdc428386615ddbcbc04f",
        "01ac7e13820fdfad548d1ac296510d66d599511b34e935521e3d276838a54896",
    ): (52151104, 51976968),
    (BINARY_HASH, METADATA_HASH): (INPUT_CLASS_RVA, CORE_CLASS_RVA),
}
INPUT_TYPE = "ifapp.Game.Input.InputManager"
PAIR_TYPE = "ifapp.Game.Input.InputOwnershipPair"
CORE_TYPE = "ifapp.Game.Scenes.CoreScene"

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MAX_PATH = 32768
LIST_MODULES_ALL = 0x03
STILL_ACTIVE = 259

PHASE = {0: "Unknown", 1: "Menu", 2: "Playing", 3: "Results"}
K32 = ctypes.WinDLL("kernel32", use_last_error=True)


class MODULEINFO(ctypes.Structure):
    _fields_ = [
        ("lpBaseOfDll", ctypes.c_void_p),
        ("SizeOfImage", wintypes.DWORD),
        ("EntryPoint", ctypes.c_void_p),
    ]


K32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
K32.OpenProcess.restype = wintypes.HANDLE
K32.CloseHandle.argtypes = [wintypes.HANDLE]
K32.ReadProcessMemory.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]
K32.ReadProcessMemory.restype = wintypes.BOOL
K32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
K32.GetExitCodeProcess.restype = wintypes.BOOL
K32.K32EnumProcessModulesEx.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(wintypes.HMODULE),
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
    wintypes.DWORD,
]
K32.K32EnumProcessModulesEx.restype = wintypes.BOOL
K32.K32GetModuleBaseNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.HMODULE,
    wintypes.LPWSTR,
    wintypes.DWORD,
]
K32.K32GetModuleBaseNameW.restype = wintypes.DWORD
K32.K32GetModuleFileNameExW.argtypes = [
    wintypes.HANDLE,
    wintypes.HMODULE,
    wintypes.LPWSTR,
    wintypes.DWORD,
]
K32.K32GetModuleFileNameExW.restype = wintypes.DWORD
K32.K32GetModuleInformation.argtypes = [
    wintypes.HANDLE,
    wintypes.HMODULE,
    ctypes.POINTER(MODULEINFO),
    wintypes.DWORD,
]
K32.K32GetModuleInformation.restype = wintypes.BOOL
K32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]
K32.QueryFullProcessImageNameW.restype = wintypes.BOOL


def find_game_pid():
    # tasklist is intentionally avoided so process names and identities come from Win32.
    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    K32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    K32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    K32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    K32.Process32FirstW.restype = wintypes.BOOL
    K32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    K32.Process32NextW.restype = wintypes.BOOL
    snapshot = K32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot in (None, ctypes.c_void_p(-1).value):
        return []
    matches = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        if K32.Process32FirstW(snapshot, ctypes.byref(entry)):
            while True:
                if entry.szExeFile.lower() == GAME_EXE:
                    matches.append(int(entry.th32ProcessID))
                if not K32.Process32NextW(snapshot, ctypes.byref(entry)):
                    break
    finally:
        K32.CloseHandle(snapshot)
    return matches


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def pe_data_section(path):
    with open(path, "rb") as handle:
        header = handle.read(4096)
    pe = struct.unpack_from("<I", header, 0x3C)[0]
    count = struct.unpack_from("<H", header, pe + 6)[0]
    optional_size = struct.unpack_from("<H", header, pe + 20)[0]
    table = pe + 24 + optional_size
    for index in range(count):
        item = table + index * 40
        name = header[item:item + 8].split(b"\0", 1)[0].decode("ascii")
        virtual_size, virtual_address = struct.unpack_from("<II", header, item + 8)
        if name == ".data":
            return virtual_address, virtual_size
    raise OSError("module_identity_failed")


class GameMemory:
    def __init__(self, pid):
        self.pid = int(pid)
        self.handle = K32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
        self.module = 0
        self.game_root = None
        self.reason = "attached_readonly"
        self.input_class_rva = 0
        self.core_class_rva = 0
        self.known_build = False
        self.build_key = None
        if not self.handle:
            raise OSError("read_access_denied")

    def read(self, address, count):
        if (
            self.handle is None
            or count <= 0
            or count > 4096
            or address < 65536
            or address > 140737488355327 - count
        ):
            raise OSError("read_bounds_or_exit")
        buffer = ctypes.create_string_buffer(count)
        received = ctypes.c_size_t()
        ok = K32.ReadProcessMemory(
            self.handle,
            ctypes.c_void_p(address),
            buffer,
            count,
            ctypes.byref(received),
        )
        if not ok or received.value != count:
            raise OSError("partial_read")
        return buffer.raw

    def read_large(self, address, count):
        if count < 0 or count > 16 * 1024 * 1024:
            raise OSError("read_bounds_or_exit")
        return b"".join(
            self.read(address + offset, min(4096, count - offset))
            for offset in range(0, count, 4096)
        )

    def alive(self):
        if not self.handle:
            return False
        code = wintypes.DWORD()
        return bool(K32.GetExitCodeProcess(self.handle, ctypes.byref(code))) and code.value == STILL_ACTIVE

    def locate_module(self):
        modules = (wintypes.HMODULE * 1024)()
        needed = wintypes.DWORD()
        if not K32.K32EnumProcessModulesEx(
            self.handle, modules, ctypes.sizeof(modules), ctypes.byref(needed), LIST_MODULES_ALL
        ):
            raise OSError("process_query_denied")
        count = needed.value // ctypes.sizeof(wintypes.HMODULE)
        for index in range(min(count, 1024)):
            module = modules[index]
            name = ctypes.create_unicode_buffer(512)
            if not K32.K32GetModuleBaseNameW(self.handle, module, name, len(name)):
                continue
            if name.value.lower() != ASSEMBLY.lower():
                continue
            path_buffer = ctypes.create_unicode_buffer(MAX_PATH)
            if not K32.K32GetModuleFileNameExW(self.handle, module, path_buffer, MAX_PATH):
                raise OSError("module_identity_failed")
            info = MODULEINFO()
            if not K32.K32GetModuleInformation(
                self.handle, module, ctypes.byref(info), ctypes.sizeof(info)
            ):
                raise OSError("module_identity_failed")
            if info.SizeOfImage <= INPUT_CLASS_RVA + 8:
                raise OSError("module_identity_failed")
            exe_name = ctypes.create_unicode_buffer(MAX_PATH)
            size = wintypes.DWORD(MAX_PATH)
            if not K32.QueryFullProcessImageNameW(
                self.handle, 0, exe_name, ctypes.byref(size)
            ):
                raise OSError("process_query_denied")
            if os.path.basename(exe_name.value).lower() != GAME_EXE:
                raise OSError("process_identity_changed")
            self.module = int(info.lpBaseOfDll or 0)
            self.game_root = os.path.dirname(path_buffer.value)
            self.reason = "attached_readonly"
            return
        raise OSError("module_not_loaded")

    def verify_build(self):
        if not self.game_root:
            raise OSError("module_not_loaded")
        assembly_path = os.path.join(self.game_root, ASSEMBLY)
        metadata_path = os.path.join(
            self.game_root, "infalsus_Data", "il2cpp_data", "Metadata", "global-metadata.dat"
        )
        assembly_hash = sha256_file(assembly_path).lower()
        metadata_hash = sha256_file(metadata_path).lower()
        if os.environ.get("INFALSUS_PHASE_DEBUG") == "1":
            print(
                "PHASE_DEBUG " + json.dumps({
                    "root": self.game_root,
                    "assembly": assembly_hash,
                    "metadata": metadata_hash
                }, ensure_ascii=False),
                flush=True
            )
        self.build_key = (assembly_hash, metadata_hash)
        self.known_build = (assembly_hash, metadata_hash) in KNOWN_LAYOUTS

    def discover_layout(self):
        assembly_path = os.path.join(self.game_root, ASSEMBLY)
        rva, size = pe_data_section(assembly_path)
        blob = self.read_large(self.module + rva, size)
        targets = {
            INPUT_TYPE: None,
            CORE_TYPE: None,
            PAIR_TYPE: None,
        }
        for offset in range(0, len(blob) - 8, 8):
            value = struct.unpack_from("<Q", blob, offset)[0]
            if value < 0x10000000000 or value > 0x7FFFFFFFFFFF:
                continue
            try:
                found = type_name(self, value)
            except OSError:
                continue
            if found in targets and targets[found] is None:
                targets[found] = rva + offset
            if all(item is not None for item in targets.values()):
                break
        if not targets[INPUT_TYPE] or not targets[CORE_TYPE] or not targets[PAIR_TYPE]:
            raise OSError("unsupported_build")
        self.input_class_rva = targets[INPUT_TYPE]
        self.core_class_rva = targets[CORE_TYPE]

    def resolve_layout(self):
        self.verify_build()
        known = KNOWN_LAYOUTS.get(self.build_key)
        if known:
            self.input_class_rva, self.core_class_rva = known
            return
        self.discover_layout()

    def close(self):
        if self.handle:
            K32.CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def ptr(memory, address):
    value = struct.unpack("<Q", memory.read(address, 8))[0]
    if value < 65536 or value > 140737488355327:
        raise OSError("invalid_pointer")
    return value


def text(memory, address):
    chars = []
    for offset in range(0, 128, 8):
        for value in memory.read(address + offset, 8):
            if value == 0:
                return "".join(chars)
            if value < 32 or value > 126:
                raise OSError("invalid_type_name")
            chars.append(chr(value))
    raise OSError("unbounded_type_name")


def type_name(memory, klass):
    item = text(memory, ptr(memory, klass + 16))
    namespace = text(memory, ptr(memory, klass + 24))
    if not item:
        raise OSError("empty_type_name")
    return namespace + "." + item if namespace else item


def static_fields(memory, reference, expected):
    klass = ptr(memory, reference)
    if type_name(memory, klass) != expected:
        raise OSError("type_mismatch")
    return ptr(memory, klass + 184)


def classify(owners, core_flag):
    playing = set(
        (
            "ifapp.Game.Scenes.GameScene",
            "ifapp.Game.Scenes.Game.GamePauseLayer",
            "SongTransitionLayer",
            "ifapp.Game.Scenes.StorySongTransitionScene",
        )
    )
    menu = set(
        (
            "ifapp.Game.Scenes.TitleScene",
            "ifapp.Game.Scenes.SongSelectScene",
            "ifapp.Game.Scenes.HubScene",
            "ifapp.Game.Scenes.TimelineScene",
            "ifapp.Game.Scenes.Recipe.RecipeScene",
        )
    )
    result = False
    known_menu = False
    unknown = False
    for owner in owners:
        if owner in playing:
            return "Playing"
        if owner == "ifapp.Game.Scenes.ResultsScene":
            result = True
        elif owner in menu:
            known_menu = True
        elif owner not in (CORE_TYPE, INPUT_TYPE, "ifapp.Game.UI.Common.UIManager"):
            unknown = True
    if core_flag or unknown or (known_menu and result):
        return "Unknown"
    if result:
        return "Results"
    if known_menu:
        return "Menu"
    return "Unknown"


def capture(memory):
    input_static = static_fields(memory, memory.module + memory.input_class_rva, INPUT_TYPE)
    input_instance = ptr(memory, input_static + 16)
    if type_name(memory, ptr(memory, input_instance)) != INPUT_TYPE:
        raise OSError("instance_mismatch")
    ptr(memory, input_instance + 16)

    core_static = static_fields(memory, memory.module + memory.core_class_rva, CORE_TYPE)
    core_flag = memory.read(core_static + 24, 1)[0]
    if core_flag > 1:
        raise OSError("invalid_transition_flag")

    owners_container = ptr(memory, input_instance + 56)
    last = struct.unpack("<i", memory.read(input_instance + 68, 4))[0]
    count = struct.unpack("<Q", memory.read(owners_container + 24, 8))[0]
    if count == 0 or count > 256 or last < -1 or last >= 64 or last >= count:
        raise OSError("invalid_stack_bounds")

    owners = []
    always_owners = []
    identity = [input_instance, owners_container, last, core_flag]

    def owner_name(pair):
        if not pair:
            return None
        if pair < 65536 or pair > 140737488355327:
            raise OSError("pair_mismatch")
        if type_name(memory, ptr(memory, pair)) != PAIR_TYPE:
            raise OSError("pair_mismatch")
        owner_instance = ptr(memory, pair + 24)
        ptr(memory, owner_instance + 16)
        return type_name(memory, ptr(memory, owner_instance))

    if last >= 0:
        points = memory.read(owners_container + 32, (last + 1) * 8)
        for index in range(last + 1):
            pair = struct.unpack_from("<Q", points, index * 8)[0]
            identity.append(pair)
            if pair:
                owner_instance = ptr(memory, pair + 24)
                owner_type = owner_name(pair)
                identity.extend((owner_instance, owner_type))
                owners.append(owner_type)

    try:
        always_container = ptr(memory, input_instance + 48)
        always_count = struct.unpack("<i", memory.read(input_instance + 64, 4))[0]
        always_length = struct.unpack("<Q", memory.read(always_container + 24, 8))[0]
        if 0 <= always_count <= always_length <= 256:
            points = memory.read(always_container + 32, always_count * 8)
            for index in range(always_count):
                pair = struct.unpack_from("<Q", points, index * 8)[0]
                if pair:
                    always_owners.append(owner_name(pair))
    except OSError:
        # Older builds may not expose this secondary stack.
        always_owners.clear()

    # Current builds keep some scene receivers in the always-received stack.
    # UIManager is neutral; scene/layer types still drive the classification.
    candidate = classify(owners + always_owners, bool(core_flag))
    if os.environ.get("INFALSUS_PHASE_DEBUG") == "1":
        print(
            "PHASE_CAPTURE " + json.dumps({
                "owners": owners,
                "alwaysOwners": always_owners,
                "coreFlag": bool(core_flag),
                "candidate": candidate
            }, ensure_ascii=False),
            flush=True
        )
    return candidate, tuple(identity), "layout_matched" if candidate != "Unknown" else "unrecognized_or_transition"


class StabilityGate:
    def __init__(self):
        self.pending = "Unknown"
        self.count = 0

    def update(self, phase):
        if phase in ("Unknown", "Playing"):
            self.pending = phase
            self.count = 0
            return phase
        if phase != self.pending:
            self.pending = phase
            self.count = 1
            return "Unknown"
        self.count = min(2, self.count + 1)
        return phase if self.count >= 2 else "Unknown"

    def reset(self):
        self.pending = "Unknown"
        self.count = 0


def publish(path, status, previous):
    now = int(time.time() * 1000)
    status["sampledAt"] = now
    text_value = json.dumps(status, ensure_ascii=False, sort_keys=True)
    signature = text_value.rsplit(', "sampledAt"', 1)[0]
    if signature == previous and now % 500 > 60:
        return previous
    if path:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(text_value)
        os.replace(temporary, path)
    print("PHASE " + text_value, flush=True)
    return signature


def simulate(path):
    gate = StabilityGate()
    started = time.time()
    previous = None
    while True:
        elapsed = time.time() - started
        phase = "Menu" if elapsed < 2 else "Playing" if elapsed < 5 else "Results" if elapsed < 9 else "Menu"
        stable = gate.update(phase)
        previous = publish(
            path,
            {
                "phase": stable,
                "rawPhase": phase,
                "pid": 0,
                "reason": "simulated",
                "notice": "阶段模拟",
                "supported": True,
            },
            previous,
        )
        time.sleep(0.04)


def monitor(path):
    memory = None
    pid = 0
    next_identity = 0
    gate = StabilityGate()
    previous = None
    reason = "no_game_process"
    while True:
        try:
            now = time.monotonic()
            if memory and not memory.alive():
                memory.close()
                memory = None
                pid = 0
                gate.reset()
                reason = "no_game_process"
            if now >= next_identity:
                next_identity = now + 0.75
                pids = find_game_pid()
                next_pid = pids[0] if len(pids) == 1 else 0
                if len(pids) > 1:
                    reason = "ambiguous_game_process"
                if next_pid != pid:
                    if memory:
                        memory.close()
                    memory = None
                    pid = next_pid
                    gate.reset()
                    reason = "attaching" if pid else "no_game_process"
                    if pid:
                        try:
                            memory = GameMemory(pid)
                            memory.locate_module()
                            memory.resolve_layout()
                        except OSError as error:
                            reason = str(error)
                            if memory:
                                memory.close()
                            memory = None
            if memory:
                first = capture(memory)
                second = capture(memory)
                if first[1] != second[1]:
                    raw = "Unknown"
                    reason = "changing_snapshot"
                else:
                    raw = first[0]
                    reason = first[2]
                phase = gate.update(raw)
                notice = (
                    "游玩时折叠 · 结算自动展开"
                    if phase != "Unknown"
                    else "阶段确认中 · 暂时保护隐藏"
                )
                status = {
                    "phase": phase,
                    "rawPhase": raw,
                    "pid": pid,
                    "reason": reason,
                    "notice": notice,
                    "supported": True,
                }
            else:
                status = {
                    "phase": "Unknown",
                    "rawPhase": "Unknown",
                    "pid": pid,
                    "reason": reason,
                    "notice": (
                        "此游戏版本尚未适配阶段识别"
                        if reason == "unsupported_build"
                        else "无法只读检测游戏 · 请检查权限"
                        if reason in ("read_access_denied", "process_query_denied")
                        else "等待游戏连接"
                        if not pid
                        else "正在连接游戏"
                    ),
                    "supported": reason != "unsupported_build",
                }
            previous = publish(path, status, previous)
        except OSError as error:
            reason = str(error) or "read_or_layout_failed"
            status = {
                "phase": "Unknown",
                "rawPhase": "Unknown",
                "pid": pid,
                "reason": reason,
                "notice": "阶段读取失败 · 暂时保护隐藏",
                "supported": reason != "unsupported_build",
            }
            previous = publish(path, status, previous)
        except Exception:
            previous = publish(
                path,
                {
                    "phase": "Unknown",
                    "rawPhase": "Unknown",
                    "pid": pid,
                    "reason": "monitor_unavailable",
                    "notice": "阶段监控不可用 · 暂时保护隐藏",
                    "supported": False,
                },
                previous,
            )
        # 游戏没在跑时没必要 25 Hz 轮询进程列表：降到约 3 Hz，检测延迟仍 < 1.3 秒。
        time.sleep(0.04 if memory else 0.35)


def main():
    path = None
    simulate_mode = "--simulate" in sys.argv
    for index, value in enumerate(sys.argv):
        if value == "--status" and index + 1 < len(sys.argv):
            path = sys.argv[index + 1]
    try:
        if simulate_mode:
            simulate(path)
        else:
            monitor(path)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
