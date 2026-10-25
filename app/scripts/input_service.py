# -*- coding: utf-8 -*-
"""Input companion for InFalsus Helper.

This is the reference key-listener behavior without its separate Tk window:
Alt+Z toggle, G/CapsLock sounds, CapsLock swallowing, keyboard remapping,
mouse remapping, and Win+Shift+S/R interception. Electron owns the settings UI;
this process owns the low-level Windows hooks.
"""

VERSION = "1.1.0"

import ctypes
import json
import os
import queue
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from audio_player import AudioPlayer  # noqa: E402
from key_logic import KeyLogic, ACTION_TOGGLE, ACTION_PLAY, VK_CAPITAL, VK_G, VK_Z  # noqa: E402
from keyhook import (  # noqa: E402
    InputHook,
    WM_LBUTTONDOWN,
    WM_LBUTTONUP,
    WM_MBUTTONDOWN,
    WM_MBUTTONUP,
    WM_RBUTTONDOWN,
    WM_RBUTTONUP,
)

SOUNDS = {
    "g": os.path.join(HERE, "g.mp3"),
    "capslock": os.path.join(HERE, "capslock.mp3"),
}
# 主循环节流：空闲时靠 queue.get(timeout) 阻塞，这三个值决定最坏唤醒间隔。
# 状态变化都会主动 publish(force=True)，所以兜底发布可以放慢。
CONFIG_POLL_SECONDS = 0.5
STATUS_PUBLISH_SECONDS = 1.0
MIN_WAIT_SECONDS = 0.25
VK_F = 0x46
VK_LSHIFT = 0xA0
VK_SPACE = 0x20
VK_S = 0x53
VK_R = 0x52
REMAP_PAIRS = {VK_CAPITAL: VK_LSHIFT, VK_G: VK_F}
MOUSE_REMAP = {
    WM_LBUTTONDOWN: ("key", VK_LSHIFT),
    WM_LBUTTONUP: ("key", VK_LSHIFT),
    WM_RBUTTONDOWN: ("key", VK_SPACE),
    WM_RBUTTONUP: ("key", VK_SPACE),
    WM_MBUTTONDOWN: ("mouse", "left"),
    WM_MBUTTONUP: ("mouse", "left"),
}
BLOCK_HOTKEYS = {VK_S: frozenset(("win", "shift")), VK_R: frozenset(("win", "shift"))}
MUTEX_NAME = "Local\\InFalsusHelperInput_{7C1D739A-D6B6-4AD5-A113-5146A6AC82A0}"

DEFAULTS = {
    "enabled": False,
    "playSounds": False,
    "swallowCapsLock": False,
    "remapKeyboard": False,
    "remapMouse": False,
    "blockScreenshotHotkeys": False,
}


def args():
    result = {"config": None, "status": None, "smoke": False}
    values = sys.argv[1:]
    for index, item in enumerate(values):
        if item == "--config" and index + 1 < len(values):
            result["config"] = values[index + 1]
        elif item == "--status" and index + 1 < len(values):
            result["status"] = values[index + 1]
        elif item == "--smoke":
            result["smoke"] = True
    return result


def acquire_single_instance():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CreateMutexW(None, False, MUTEX_NAME)
    return ctypes.get_last_error() != 183


def clean(value):
    output = dict(DEFAULTS)
    if isinstance(value, dict):
        for key in output:
            if isinstance(value.get(key), bool):
                output[key] = value[key]
    return output


def write_json(path, value):
    if not path:
        return
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_config(path):
    if not path:
        return dict(DEFAULTS)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return clean(json.load(handle))
    except (OSError, ValueError):
        return dict(DEFAULTS)


class InputService:
    def __init__(self, config_path, status_path, smoke=False):
        self.config_path = config_path
        self.status_path = status_path
        self.smoke = smoke
        self.config = read_config(config_path)
        self.config_mtime = self._mtime()
        self.audio = AudioPlayer(SOUNDS)
        self.logic = KeyLogic(enabled=self.config["enabled"], combo_modifiers=("alt",), combo_keys={VK_Z})
        self.events = queue.Queue()
        self.hook = InputHook(lambda vk, down: self.events.put((vk, down)))
        self.last_trigger = None
        self.last_published = None
        self.started = time.time()
        self.running = True

    def _mtime(self):
        if not self.config_path:
            return 0
        try:
            return os.stat(self.config_path).st_mtime_ns
        except OSError:
            return 0

    def apply_config(self):
        mtime = self._mtime()
        if not mtime or mtime == self.config_mtime:
            return
        previous = self.config
        self.config = read_config(self.config_path)
        self.config_mtime = mtime
        if self.config["enabled"] != previous["enabled"]:
            self.logic.enabled = self.config["enabled"]

    def sync_hook(self):
        enabled = bool(self.logic.enabled)
        self.hook.swallow_capslock = enabled and self.config["swallowCapsLock"]
        remap = REMAP_PAIRS if enabled and self.config["remapKeyboard"] else {}
        mouse = MOUSE_REMAP if enabled and self.config["remapMouse"] else {}
        if remap != self.hook.remap or mouse != self.hook.mouse_remap:
            self.hook.update_remap(remap, mouse)
        block = BLOCK_HOTKEYS if enabled and self.config["blockScreenshotHotkeys"] else {}
        if block != self.hook.block_hotkeys:
            self.hook.block_hotkeys = block

    def publish(self, force=False):
        status = {
            "running": bool(self.hook.installed and self.running),
            "enabled": bool(self.logic.enabled),
            "hookInstalled": bool(self.hook.installed),
            "mouseHookInstalled": bool(self.hook.mouse_installed),
            "error": self.hook.error,
            "injectError": str(self.hook.inject_error) if self.hook.inject_error else None,
            "lastTrigger": self.last_trigger,
            "smoke": self.smoke,
            "uptime": round(time.time() - self.started, 3),
        }
        text = json.dumps(status, ensure_ascii=False, sort_keys=True)
        if not force and text == self.last_published:
            return
        self.last_published = text
        write_json(self.status_path, status)
        print("INPUT " + text, flush=True)

    def handle_event(self, event):
        vk, down = event
        for action, payload in self.logic.handle(vk, down):
            if action == ACTION_TOGGLE:
                self.publish(force=True)
            elif action == ACTION_PLAY and self.config["playSounds"]:
                ok = self.audio.play(payload)
                self.last_trigger = {
                    "name": payload,
                    "ok": bool(ok),
                    "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
                }
                self.publish(force=True)

    def handle_events(self):
        """清空队列里的按键事件；返回是否处理过事件。"""
        changed = False
        while True:
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                break
            changed = True
            self.handle_event(event)
        if changed:
            self.sync_hook()
        return changed

    def run(self):
        if not acquire_single_instance():
            write_json(self.status_path, {
                "running": False,
                "enabled": False,
                "error": "另一个输入服务实例正在运行",
            })
            return 2
        if not self.hook.start_and_wait():
            self.running = False
            self.publish(force=True)
            return 3
        self.publish(force=True)
        next_config = 0
        next_publish = 0
        while self.running:
            now = time.time()
            if now >= next_config:
                self.apply_config()
                self.sync_hook()
                next_config = now + CONFIG_POLL_SECONDS
            if now >= next_publish:
                self.publish()
                next_publish = now + STATUS_PUBLISH_SECONDS
            # 阻塞等按键事件，而不是空转轮询：有按键立刻唤醒，空闲时零 CPU。
            wait = max(MIN_WAIT_SECONDS, min(next_config, next_publish) - time.time())
            try:
                self.handle_event(self.events.get(timeout=wait))
                self.handle_events()
                self.sync_hook()
            except queue.Empty:
                pass
            self.audio.cleanup()
            if self.smoke and time.time() - self.started >= 1.5:
                self.running = False
        self.audio.stop()
        self.hook.stop()
        self.publish(force=True)
        return 0


def main():
    parsed = args()
    try:
        ctypes.WinDLL("shcore").SetProcessDpiAwareness(1)
    except Exception:
        pass
    service = InputService(parsed["config"], parsed["status"], parsed["smoke"])
    return service.run()


if __name__ == "__main__":
    raise SystemExit(main())
