# -*- coding: utf-8 -*-
"""音频播放器：用 Windows MCI（winmm）播放 mp3，纯 ctypes，无第三方依赖。

关键行为：``play()`` 会先结束当前正在播放的音效，再开始新的，
所以短时间内多次触发时，后按下的会覆盖前面的。
"""

import ctypes
import os
from ctypes import wintypes

_winmm = ctypes.WinDLL("winmm")

_mciSendStringW = _winmm.mciSendStringW
_mciSendStringW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.UINT, wintypes.HWND]
_mciSendStringW.restype = wintypes.DWORD

_mciGetErrorStringW = _winmm.mciGetErrorStringW
_mciGetErrorStringW.argtypes = [wintypes.DWORD, wintypes.LPWSTR, wintypes.UINT]
_mciGetErrorStringW.restype = wintypes.BOOL

_ALIAS = "reasonix_key_sound"


class AudioPlayer(object):
    """把音效名映射到文件路径并播放。"""

    def __init__(self, mapping=None):
        self.mapping = dict(mapping or {})
        self.last_error = None
        self._opened = False

    # -- 底层 ---------------------------------------------------------------
    @staticmethod
    def _cmd(command):
        buf = ctypes.create_unicode_buffer(512)
        code = _mciSendStringW(command, buf, 512, None)
        return code, buf.value

    @staticmethod
    def _error_text(code):
        buf = ctypes.create_unicode_buffer(512)
        _mciGetErrorStringW(wintypes.DWORD(code), buf, 512)
        return buf.value

    # -- 对外 ---------------------------------------------------------------
    def stop(self):
        """立刻结束正在播放的音效（没有在播时是空操作）。"""
        if self._opened:
            self._cmd("close " + _ALIAS)
            self._opened = False

    def play(self, name):
        """播放 name 对应的文件，并打断上一个音效。成功返回 True。"""
        path = self.mapping.get(name)
        if not path:
            self.last_error = "没有为 %r 配置音频文件" % (name,)
            return False
        if not os.path.exists(path):
            self.last_error = "音频文件不存在：%s" % path
            return False

        # 先结束上一个音效——这就是「后按覆盖前」
        self.stop()

        code, _ = self._cmd('open "%s" type mpegvideo alias %s' % (path, _ALIAS))
        if code:
            # 少数机器上 mpegvideo 不可用，退回让 MCI 自己判断类型
            code, _ = self._cmd('open "%s" alias %s' % (path, _ALIAS))
        if code:
            self.last_error = "打开音频失败：%s" % self._error_text(code)
            return False

        self._opened = True
        code, _ = self._cmd("play " + _ALIAS)
        if code:
            self.last_error = "播放失败：%s" % self._error_text(code)
            self.stop()
            return False

        self.last_error = None
        return True

    def is_playing(self):
        """当前是否有音效正在播放。"""
        if not self._opened:
            return False
        code, mode = self._cmd("status %s mode" % _ALIAS)
        if code:
            self._opened = False
            return False
        return mode == "playing"

    def cleanup(self):
        """播放结束后释放 MCI 句柄（不会打断正在播放的音效）。"""
        if self._opened and not self.is_playing():
            self.stop()
