# -*- coding: utf-8 -*-
"""按键判定逻辑。

这一层刻意不碰任何 Windows API，只做「原始按键事件 -> 动作」的翻译，
方便单元测试。

- 组合键 Alt + Z : 开启 / 关闭监听
- 监听开启时：
    G         -> 播放 g.mp3
    CapsLock  -> 播放 capslock.mp3
- 长按产生的自动重复只算一次。
"""

VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12          # Alt
VK_CAPITAL = 0x14       # CapsLock
VK_SPACE = 0x20
VK_G = 0x47
VK_Z = 0x5A
VK_LWIN = 0x5B
VK_RWIN = 0x5C
VK_LSHIFT = 0xA0
VK_RSHIFT = 0xA1
VK_LCONTROL = 0xA2
VK_RCONTROL = 0xA3
VK_LMENU = 0xA4
VK_RMENU = 0xA5

CTRL_VKS = frozenset((VK_CONTROL, VK_LCONTROL, VK_RCONTROL))
ALT_VKS = frozenset((VK_MENU, VK_LMENU, VK_RMENU))
SHIFT_VKS = frozenset((VK_SHIFT, VK_LSHIFT, VK_RSHIFT))
WIN_VKS = frozenset((VK_LWIN, VK_RWIN))
_MODIFIER_VKS = CTRL_VKS | ALT_VKS | SHIFT_VKS | WIN_VKS

# 逻辑修饰键名 -> 它可能是的那些 vk（左右各一份）
MODIFIER_GROUPS = {
    "ctrl": CTRL_VKS,
    "alt": ALT_VKS,
    "shift": SHIFT_VKS,
    "win": WIN_VKS,
}

# 动作种类
ACTION_TOGGLE = "toggle"        # payload: 新的监听状态 (True/False)
ACTION_PLAY = "play"            # payload: 音效名 ("g" / "capslock")


class KeyLogic(object):
    """把 (vk, is_down) 事件流翻译成动作列表。"""

    def __init__(self, enabled=False, combo_modifiers=("alt",), combo_keys=None):
        self.enabled = bool(enabled)
        # 组合键 = 这些逻辑修饰键都按住，并且主键落在 combo_keys 里
        self.combo_modifiers = tuple(combo_modifiers)
        self.combo_keys = set(combo_keys) if combo_keys else {VK_Z}
        self._pressed = set()

    # -- 查询 ---------------------------------------------------------------
    def _combo_modifiers_held(self):
        for name in self.combo_modifiers:
            group = MODIFIER_GROUPS.get(name, ())
            if not any(vk in self._pressed for vk in group):
                return False
        return True

    # -- 主入口 -------------------------------------------------------------
    def handle(self, vk, is_down):
        """喂入一个按键事件，返回动作列表（可能为空）。"""
        if is_down:
            return self._on_key_down(vk)
        self._pressed.discard(vk)
        return []

    def _on_key_down(self, vk):
        actions = []
        if vk in self._pressed:
            # 长按自动重复：同一次按下只处理一遍
            return actions
        self._pressed.add(vk)

        if vk in _MODIFIER_VKS:
            # 修饰键本身不触发任何动作，只记录状态
            return actions

        if vk in self.combo_keys and self._combo_modifiers_held():
            self.enabled = not self.enabled
            actions.append((ACTION_TOGGLE, self.enabled))
            return actions

        if not self.enabled:
            return actions

        if vk == VK_G:
            actions.append((ACTION_PLAY, "g"))
        elif vk == VK_CAPITAL:
            actions.append((ACTION_PLAY, "capslock"))
        return actions

    def reset(self):
        """清空「当前按下的键」，用于焦点/会话切换后避免脏状态。"""
        self._pressed.clear()
