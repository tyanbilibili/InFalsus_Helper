# -*- coding: utf-8 -*-
"""Windows 全局低级输入钩子（WH_KEYBOARD_LL + WH_MOUSE_LL），纯 ctypes，无第三方依赖。

在后台线程里安装两个钩子并共用一个消息循环；回调只做最轻的事
（把按键交给 on_event），再立刻返回。

除了「旁听」键盘，还支持四件事（都由主线程通过属性/方法设置）：

- ``swallow_capslock``：吞掉 CapsLock，不让系统切换大小写
- ``block_hotkeys``：吞掉指定的修饰键组合，例如 Win+Shift+S / Win+Shift+R
- ``update_remap(key_map)``：键盘按键重映射——吞掉源按键，再用 SendInput 注入目标
- ``update_remap(mouse_map=...)``：鼠标按键重映射——吞掉鼠标按键，改注入目标

重映射的「目标」统一用 ``(kind, value)`` 描述，kind 可以是：

- ``("key", vk)``       注入一次键盘按键
- ``("mouse", button)`` 注入一次鼠标按键，button 取 "left" / "right" / "middle"

按下还是抬起由**源消息**决定（*DOWN 消息注入按下，*UP 注入抬起），
所以同一对 down/up 消息指向同一个目标描述即可。

关于注入的执行位置（很重要）：
所有注入都丢给一个**专用线程**按先进先出执行，钩子回调**绝不**自己调 SendInput。
在低级钩子回调里注入同类事件，会让「注入的事件要等本线程处理、而本线程还卡在注入里」
互相等待，实测鼠标事件会被拖慢到几百毫秒甚至数秒。放到另一个线程就完全没这个问题。
"""

import ctypes
import queue
import threading
from ctypes import wintypes

_user32 = ctypes.WinDLL("user32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WH_KEYBOARD_LL = 13
WH_MOUSE_LL = 14

WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
WM_SYSKEYUP = 0x0105
WM_QUIT = 0x0012

WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MBUTTONDOWN = 0x0207
WM_MBUTTONUP = 0x0208

VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12
VK_CAPITAL = 0x14
VK_SPACE = 0x20
VK_LWIN = 0x5B
VK_RWIN = 0x5C
VK_LSHIFT = 0xA0
VK_RSHIFT = 0xA1
VK_LCONTROL = 0xA2
VK_RCONTROL = 0xA3
VK_LMENU = 0xA4
VK_RMENU = 0xA5

# 逻辑修饰键名 -> 它可能是哪些 vk（左右各一份）
MODIFIER_VKS = {
    "ctrl": frozenset((VK_CONTROL, VK_LCONTROL, VK_RCONTROL)),
    "alt": frozenset((VK_MENU, VK_LMENU, VK_RMENU)),
    "shift": frozenset((VK_SHIFT, VK_LSHIFT, VK_RSHIFT)),
    "win": frozenset((VK_LWIN, VK_RWIN)),
}
_MODIFIER_VKS = frozenset().union(*MODIFIER_VKS.values())

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

MAPVK_VK_TO_VSC_EX = 4

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040

_MOUSE_BUTTON_FLAGS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}

# 给本程序注入的事件打个记号；钩子里看到就原样放行，避免自我递归
INJECT_MAGIC = 0x524D4150            # 'RMAP'

_DOWN_MSGS = (WM_KEYDOWN, WM_SYSKEYDOWN)
_UP_MSGS = (WM_KEYUP, WM_SYSKEYUP)
_MOUSE_DOWN_MSGS = (WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN)


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", wintypes.WPARAM),
    ]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", wintypes.POINT),
        ("mouseData", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", wintypes.WPARAM),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", wintypes.WPARAM),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", wintypes.WPARAM),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

_user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
_user32.SetWindowsHookExW.restype = wintypes.HHOOK
_user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
_user32.CallNextHookEx.restype = ctypes.c_ssize_t
_user32.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
_user32.UnhookWindowsHookEx.restype = wintypes.BOOL
_user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
_user32.GetMessageW.restype = ctypes.c_int
_user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
_user32.TranslateMessage.restype = wintypes.BOOL
_user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
_user32.DispatchMessageW.restype = wintypes.LPARAM
_user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
_user32.PostThreadMessageW.restype = wintypes.BOOL
_user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
_user32.SendInput.restype = wintypes.UINT
_user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
_user32.MapVirtualKeyW.restype = wintypes.UINT
_kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
_kernel32.GetModuleHandleW.restype = wintypes.HMODULE
_kernel32.GetCurrentThreadId.argtypes = []
_kernel32.GetCurrentThreadId.restype = wintypes.DWORD


def scancode_for(vk):
    """把虚拟键码换成 (硬件扫描码, 是否扩展键)；映射不了时返回 (0, False)。"""
    ext = int(_user32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX))
    if not ext:
        return 0, False
    if ext >> 8 in (0xE0, 0xE1):
        return ext & 0xFF, True
    return ext, False


def send_key(vk, is_down):
    """用 SendInput 注入一次键盘按键（带魔数标记，方便钩子识别并放行）。

    这里用的是**硬件扫描码**（KEYEVENTF_SCANCODE）而不是虚拟键码，原因很关键：
    DirectInput / Raw Input 的游戏只读扫描码，只填 wVk 的话这类游戏根本收不到
    （而普通窗口程序、GetAsyncKeyState 都正常，所以很容易误判成"注入没生效"）。
    个别 vk 映射不出扫描码时，退回虚拟键码。
    """
    scan, extended = scancode_for(vk)
    events = (INPUT * 1)()
    events[0].type = INPUT_KEYBOARD
    events[0].ki.time = 0
    events[0].ki.dwExtraInfo = INJECT_MAGIC
    if scan:
        events[0].ki.wVk = 0
        events[0].ki.wScan = scan
        flags = KEYEVENTF_SCANCODE
        if extended:
            flags |= KEYEVENTF_EXTENDEDKEY
    else:
        events[0].ki.wVk = vk
        events[0].ki.wScan = 0
        flags = 0
    if not is_down:
        flags |= KEYEVENTF_KEYUP
    events[0].ki.dwFlags = flags
    return _user32.SendInput(1, events, ctypes.sizeof(INPUT))


def send_mouse_button(button, is_down):
    """用 SendInput 在当前光标位置注入一次鼠标按键（同样带魔数标记）。"""
    down_flag, up_flag = _MOUSE_BUTTON_FLAGS[button]
    events = (INPUT * 1)()
    events[0].type = INPUT_MOUSE
    events[0].mi.dx = 0
    events[0].mi.dy = 0
    events[0].mi.mouseData = 0
    events[0].mi.dwFlags = down_flag if is_down else up_flag
    events[0].mi.time = 0
    events[0].mi.dwExtraInfo = INJECT_MAGIC
    return _user32.SendInput(1, events, ctypes.sizeof(INPUT))


def dispatch_target(target, is_down):
    """按目标描述注入一次输入。

    目标可以是 ``("key", vk)``、``("mouse", "left"/"right"/"middle")``，
    也可以**直接给一个 vk**（等价于 ``("key", vk)``）——键盘重映射表用的就是后者。
    """
    if not isinstance(target, tuple):
        return send_key(target, is_down)
    kind, value = target
    if kind == "key":
        return send_key(value, is_down)
    return send_mouse_button(value, is_down)


class InputHook(threading.Thread):
    """全局键盘 + 鼠标低级钩子线程。

    参数 ``on_event(vk, is_down)`` 在钩子线程里被调用（只对键盘），必须非常快，
    通常只是往 queue 里塞一个元组。它拿到的是**改写前**的原始按键，
    所以重映射不会影响本程序自己的组合键判断。

    注入由 ``_inject_loop`` 这个专用线程执行，见模块开头的说明。
    """

    def __init__(self, on_event):
        super(InputHook, self).__init__(name="input-hook", daemon=True)
        self._on_event = on_event
        self._proc = None          # 必须保持引用，否则回调会被 GC 掉
        self._mouse_proc = None
        self._hook = None
        self._mouse_hook = None
        self._thread_id = None
        self._ready = threading.Event()

        self.installed = False
        self.mouse_installed = False
        self.error = None
        self.inject_error = None       # 注入线程里最近一次异常，便于排查

        # 由主线程设置：True 时吞掉 CapsLock，不让系统切换大小写
        self.swallow_capslock = False
        # 由主线程设置：{源 vk: 目标 vk}，整体替换，读的时候天然是原子的
        self.remap = {}
        # 由主线程设置：{鼠标消息: 目标描述}，目标可以是键盘键或鼠标键
        self.mouse_remap = {}
        # 由主线程设置：要吞掉的热键 {主键 vk: 必需的修饰键名集合}，
        # 例如 {0x53: frozenset(("win", "shift"))} 屏蔽 Win+Shift+S
        self.block_hotkeys = {}
        # 钩子线程私有：当前按下的修饰键 vk（只用于判断热键组合）
        self._mods = set()
        # 当前「已注入按下、还没注入抬起」的记录，用于取消映射时补发抬起
        self._injected = {}
        self._injected_mouse = {}
        self._inject_lock = threading.Lock()

        # 注入队列 + 注入线程
        self._inject_queue = queue.Queue()
        self._inject_worker = None

    # -- 生命周期 -----------------------------------------------------------
    def start_and_wait(self, timeout=3.0):
        """启动注入线程与钩子线程，等待钩子装好，返回键盘钩子是否成功。"""
        self._ensure_inject_worker()
        super(InputHook, self).start()
        self._ready.wait(timeout)
        return self.installed

    def _ensure_inject_worker(self):
        if self._inject_worker is None or not self._inject_worker.is_alive():
            self._inject_worker = threading.Thread(target=self._inject_loop,
                                                   name="input-inject", daemon=True)
            self._inject_worker.start()

    def run(self):
        self._thread_id = int(_kernel32.GetCurrentThreadId())
        self._proc = HOOKPROC(self._keyboard_callback)
        self._mouse_proc = HOOKPROC(self._mouse_callback)
        module = _kernel32.GetModuleHandleW(None)

        self._hook = _user32.SetWindowsHookExW(WH_KEYBOARD_LL, self._proc, module, 0)
        if not self._hook:
            self.error = "SetWindowsHookExW(键盘) 失败（错误码 %d）" % ctypes.get_last_error()

        self._mouse_hook = _user32.SetWindowsHookExW(WH_MOUSE_LL, self._mouse_proc, module, 0)
        if not self._mouse_hook and not self.error:
            self.error = "SetWindowsHookExW(鼠标) 失败（错误码 %d）" % ctypes.get_last_error()

        self.installed = bool(self._hook)
        self.mouse_installed = bool(self._mouse_hook)
        self._ready.set()

        if not (self._hook or self._mouse_hook):
            return

        msg = wintypes.MSG()
        while _user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            _user32.TranslateMessage(ctypes.byref(msg))
            _user32.DispatchMessageW(ctypes.byref(msg))

    def stop(self, timeout=2.0):
        """退出消息循环并卸载钩子。"""
        self.update_remap()                # 入队补发抬起
        self._flush_injects()              # 等注入线程把队列跑完
        self._inject_queue.put(None)       # 通知注入线程退出
        if self._inject_worker is not None and self._inject_worker.is_alive():
            self._inject_worker.join(1.0)
        if self._thread_id:
            _user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        if self.is_alive():
            self.join(timeout)
        for name in ("_hook", "_mouse_hook"):
            hook = getattr(self, name)
            if hook:
                _user32.UnhookWindowsHookEx(hook)
                setattr(self, name, None)
        self.installed = False
        self.mouse_installed = False

    # -- 注入线程 -----------------------------------------------------------
    def _inject_loop(self):
        while True:
            item = self._inject_queue.get()
            try:
                if item is None:
                    break
                target, is_down = item
                dispatch_target(target, is_down)
            except Exception as exc:       # 注入失败不能让注入线程挂掉
                self.inject_error = exc
            finally:
                self._inject_queue.task_done()

    def _request_inject(self, target, is_down):
        """把一次注入排进队列（钩子回调里只做这一步，绝不自己 SendInput）。"""
        self._inject_queue.put((target, is_down))

    def _flush_injects(self, timeout=2.0):
        """等队列执行完；万一线程已退出，最多等 timeout 秒。"""
        if self._inject_worker is None or not self._inject_worker.is_alive():
            return
        done = threading.Event()

        def waiter():
            self._inject_queue.join()
            done.set()

        threading.Thread(target=waiter, daemon=True).start()
        done.wait(timeout)

    # -- 重映射 -------------------------------------------------------------
    def update_remap(self, key_map=None, mouse_map=None):
        """更新（键盘 / 鼠标）重映射表。

        对「不再被映射、但注入的按下还没抬起」的键补发一次抬起，
        否则中途取消勾选会把那个键永久卡在按下状态。
        """
        new_key = dict(key_map or {})
        new_mouse = dict(mouse_map or {})
        with self._inject_lock:
            for source in list(self._injected):
                target = self._injected[source]
                if new_key.get(source) != target:
                    self._request_inject(target, False)
                    del self._injected[source]
            for message in list(self._injected_mouse):
                target = self._injected_mouse[message]
                if new_mouse.get(message) != target:
                    self._request_inject(target, False)
                    del self._injected_mouse[message]
        self.remap = new_key
        self.mouse_remap = new_mouse

    # -- 回调 ---------------------------------------------------------------
    def _modifiers_held(self):
        """当前按下的修饰键名集合（只在钩子线程里调用）。"""
        held = set()
        for name, vks in MODIFIER_VKS.items():
            if self._mods & vks:
                held.add(name)
        return held

    def _keyboard_callback(self, n_code, w_param, l_param):
        # n_code < 0 时必须原样传递，不处理
        if n_code == 0:
            message = int(w_param)
            info = ctypes.cast(l_param, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents

            # 自己注入的按键：直接放行，避免无限递归
            if int(info.dwExtraInfo or 0) == INJECT_MAGIC:
                return _user32.CallNextHookEx(None, n_code, w_param, l_param)

            vk = int(info.vkCode)
            if message in _DOWN_MSGS or message in _UP_MSGS:
                is_down = message in _DOWN_MSGS

                # 维护修饰键状态（只有 block_hotkeys 用得到，空表时基本零成本）
                if vk in _MODIFIER_VKS:
                    if is_down:
                        self._mods.add(vk)
                    else:
                        self._mods.discard(vk)

                # 先按「改写前」的原始按键通知上层（音效、组合键都看这个）
                self._on_event(vk, is_down)

                # 屏蔽热键：例如 Win+Shift+S（截图）、Win+Shift+R（录屏）
                blocked = self.block_hotkeys
                if blocked:
                    needed = blocked.get(vk)
                    if needed is not None and needed <= self._modifiers_held():
                        return 1                  # 吞掉，系统收不到 → 热键不会触发

                target = self.remap.get(vk)
                if target is not None:
                    self._inject(vk, target, is_down)
                    return 1                      # 吞掉原始按键
                if vk == VK_CAPITAL and self.swallow_capslock:
                    return 1

        return _user32.CallNextHookEx(None, n_code, w_param, l_param)

    def _mouse_callback(self, n_code, w_param, l_param):
        if n_code == 0:
            message = int(w_param)
            # 先做一次便宜的查表：鼠标移动之类的无关消息直接放行，不做任何 cast
            target = self.mouse_remap.get(message)
            if target is not None:
                info = ctypes.cast(l_param, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
                # 注入的事件带魔数，放行——这一点很关键：
                # 「中键 -> 鼠标左键」注入的左键不会被「左键 -> LShift」再改写一遍
                if int(info.dwExtraInfo or 0) != INJECT_MAGIC:
                    self._inject_mouse(message, target)
                    return 1                      # 吞掉原始鼠标按键

        return _user32.CallNextHookEx(None, n_code, w_param, l_param)

    # -- 注入（只入队，真正执行在 _inject_loop） -----------------------------
    def _inject(self, source, target, is_down):
        self._request_inject(target, is_down)
        with self._inject_lock:
            if is_down:
                self._injected[source] = target
            else:
                self._injected.pop(source, None)

    def _inject_mouse(self, message, target):
        is_down = message in _MOUSE_DOWN_MSGS
        self._request_inject(target, is_down)
        with self._inject_lock:
            if is_down:
                self._injected_mouse[message] = target
            else:
                self._injected_mouse.pop(message, None)
